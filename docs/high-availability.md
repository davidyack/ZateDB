# High availability

BackendCache runs as multiple nodes behind one internal Container Apps
ingress. Each node holds a full in-memory copy of the keyspace for fast
reads, stays in sync with every other node over Azure Service Bus, and
persists to Cosmos DB as the durable backing store — so a node restarting,
being redeployed, or scaling in/out never drops a shared rate-limit
counter, a presence entry, or a sliding-window abuse-guard set.

```
                 ┌──────────────┐        ┌──────────────┐
 client ───┬────▶│   Node A     │        │   Node B     │◀────┬─── client
            │    │  in-memory   │        │  in-memory   │      │
            │    │  hot copy    │        │  hot copy    │      │
            │    └──────┬───────┘        └───────┬──────┘      │
            │           │  publish/subscribe      │              │
            │           └───────────► Service Bus ◄──────────────┘
            │                        (topic, one                │
            │                    subscription per node)         │
            │                                                    │
            └──────────────► Cosmos DB ◀─────────────────────────┘
                     (keys container: source of truth
                      nodes container: heartbeat/topology)
```

Any node can serve any client — Container Apps' internal TCP ingress
load-balances across replicas with no session affinity, which this design
requires: every node is equally authoritative.

## The three moving parts

### 1. Startup hydration

Before a node accepts RESP connections, it loads every live key from
Cosmos DB into its in-memory `Store` ([`src/cluster/clusterCoordinator.ts`](../src/cluster/clusterCoordinator.ts)).
`GET /readyz` reports `503` until this finishes, and the Container Apps
readiness probe is wired to it (see [Deployment](./deployment.md)) — a
freshly scaled-out or restarted node is never routed a client before its
cache is warm. `GET /healthz` (liveness) is never gated on hydration: the
process is alive either way, just not ready for traffic yet.

### 2. Replication

After a mutating command (`SET` / `INCR` / `EXPIRE` / `PEXPIRE` / `HSET` /
`HDEL` / `ZADD` / `ZREMRANGEBYSCORE` / `DEL`) is applied to the local
`Store` — synchronously, exactly as in single-node mode — the dispatcher
reads the resulting key state back and hands it to the
`ClusterCoordinator` ([`src/commands/dispatcher.ts`](../src/commands/dispatcher.ts)),
which:

1. Upserts the resulting state to Cosmos DB (or deletes the document, if
   the key is now gone).
2. Broadcasts the same fact over the node's Service Bus subscription, so
   every other node applies it to its own in-memory copy.

This is **fire-and-forget relative to the client's reply** — the RESP
response the client already received reflects the fast local mutation,
not a round trip to Cosmos DB or Service Bus. Convergence across nodes
happens within the delivery latency of the replication transport (typically
well under a second), not synchronously. Graceful shutdown drains any
in-flight replication work (bounded by a timeout) before the process exits,
so a controlled redeploy doesn't drop the last few writes — see
`ClusterCoordinator.drain()`.

`PUBLISH` is replicated the same way but is never written to Cosmos DB
(pub/sub delivery is inherently ephemeral, matching real Redis's own
fire-and-forget semantics — see [Architecture](./architecture.md#pubsub)):
a `PUBLISH` on one node delivers to that node's local subscribers
immediately, and is also broadcast so every other node delivers to *its*
local subscribers. This is what makes the Socket.IO Redis adapter's
cross-replica room broadcast work when the two Socket.IO server instances
are connected to different BackendCache nodes.

### 3. Heartbeat

Each node periodically (`HEARTBEAT_INTERVAL_MS`, default 10s) writes a
snapshot of its own stats/topology to Cosmos DB's `nodes` container. The
admin API reads these snapshots to answer cluster-wide questions
(`/admin/stats`, `/admin/pubsub`, `/admin/nodes`) regardless of which node
answers the HTTP request — necessary because Container Apps' internal
ingress has no way to target one specific replica. A peer whose heartbeat
is older than `NODE_STALE_MS` (default 30s) is treated as dead and dropped
from cluster views.

## Consistency model — what this trades away

This is an **eventually-consistent, multi-master** design, not a
distributed-consensus one. Concretely:

- **Cross-node writes race.** If two clients hit `INCR` on the same
  rate-limit key on two different nodes within the same replication
  window, both nodes compute their "next" value from their own local
  copy, and Cosmos DB / Service Bus resolve it as a last-write-wins fact
  rather than a distributed compare-and-swap. This mirrors the same
  fixed-window imprecision the [rate-limit store deviation](./rate-limit-store.md)
  already documents for a single node (`INCR` + `EXPIRE NX` is a
  fixed-window counter, not an atomic script) — running multiple nodes
  widens the same race window from "within one process" to "within one
  replication round trip," not a new class of problem.
- **Reads are always local.** `GET` / `HGETALL` / `ZCOUNT` never call out
  to Cosmos DB — that's the whole point of the in-memory hot copy. A key
  written on another node is visible locally once its replication event
  arrives, not before.
- **No read-after-write guarantee across nodes.** A client that writes on
  node A and immediately reads on node B (e.g. a load balancer that
  doesn't pin connections) can observe a brief staleness window.
- **"Subscription state" surviving a restart is about topology
  visibility, not live sockets.** A TCP connection (and the
  `SUBSCRIBE`/`PSUBSCRIBE` state tied to it) dies with the node it was on
  — there is no way to persist a live socket, and a well-behaved client
  (e.g. `@socket.io/redis-adapter`) reconnects and resubscribes on its
  own. What *is* preserved cluster-wide is the ability to answer "what is
  subscribed, where" via the heartbeat-driven admin topology view, and —
  more importantly — the ability for a `PUBLISH` issued anywhere to reach
  a subscriber connected anywhere, which is what the pub/sub replication
  in part 2 actually guarantees.

If a workload needs stronger guarantees than this (e.g. an exactly-once
distributed counter), that's a sign it's outgrown what a lightweight
cache/pub-sub shim in front of Cosmos DB + Service Bus can promise —
reach for a real distributed store's native primitives instead of
building a bespoke consensus layer on top of BackendCache.

## Standalone mode

Setting neither Cosmos DB nor Service Bus configuration (see
[Deployment](./deployment.md#configuration)) runs BackendCache exactly as
a single node with an in-memory-only store — identical behavior to
running one replica, useful for local development and the test suite.
Configuring only one of the two is treated as a misconfiguration (logged
as `cluster.partial_configuration`) and also falls back to standalone,
since running with real persistence but no cross-node sync (or vice
versa) would silently violate the HA guarantee rather than loudly failing
closed to the well-understood single-node behavior.

## Operational notes

- **Service Bus permissions**: each node creates its own subscription on
  the shared replication topic at startup (named after its node id) and
  deletes it on graceful shutdown; a node that dies without deregistering
  leaves an orphaned subscription that self-deletes after
  `autoDeleteOnIdle` (1 hour). This requires the connection string's
  Shared Access Policy to have **Manage** rights, not just Send/Listen —
  see [`infra/backendcache.bicep`](../infra/backendcache.bicep).
- **Cosmos DB documents are never Lua/stored-procedure driven** — every
  operation is a plain upsert, delete, or query via the SDK, keeping the
  "no embedded scripting engine" property from [Non-goals](./command-reference.md#non-goals)
  intact end to end.
- **Key names as document ids**: Redis key names routinely contain
  characters Cosmos DB document ids forbid (`/`, `#`, `?`); the `id` field
  is a base64url encoding of the key, with the original key kept verbatim
  in a `key` property (used as the partition key, which has no such
  restriction) — see [`src/cluster/cosmosDurableStore.ts`](../src/cluster/cosmosDurableStore.ts).
