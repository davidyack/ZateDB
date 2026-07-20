# High availability

> ## Architecture decision record: why not managed Redis?
>
> **Azure Cache for Redis was evaluated and rejected as the cross-replica
> backend after 20+ failed deployment attempts in this Azure environment.**
> ZateDB's Cosmos DB + Service Bus HA design is therefore the
> committed architecture — it is the option that actually deploys here.
> Reviews and future work optimize *within* this design (run-cost,
> correctness, observability) rather than relitigating the choice of
> backend. The trade-offs it accepts — eventual consistency, last-write-wins
> on overwrites, per-write Cosmos RU cost — are documented below and are
> managed, not incidental.

ZateDB runs as multiple nodes behind one internal Container Apps
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

The exact *shape* of what's replicated depends on the command:

- `SET` / `DEL` ship the whole key's post-state (an absolute upsert, or a
  delete).
- `INCR` ships this node's *cumulative contribution* to the counter, not a
  whole-key value — a commutative G-counter update (see the `INCR` bullet
  in the consistency model below).
- `HSET` / `HDEL` / `ZADD` / `ZREMRANGEBYSCORE` ship only the specific
  fields/members they touched (see the consistency model below).
- `EXPIRE` / `PEXPIRE` ship **only the key's new TTL**, not a whole-entry
  snapshot. Folding a TTL change into a whole-entry upsert would overwrite
  peers with this node's entire entry — clobbering any field/member a peer
  holds that this node hasn't received yet. Replicating the expiry on its
  own preserves the field-granularity guarantee (see the TTL bullet in the
  consistency model).

**Write coalescing.** Same-key writes that queue up faster than they drain
are collapsed before the network round trip, so a hot key costs roughly one
Cosmos write + one Service Bus message per drain instead of one per command:

- Whole-key writes (`SET`/`DEL`), `INCR` contributions, and `TTL` changes
  each collapse to the *latest* queued write of their class — each fully
  supersedes the previous (an absolute value, a cumulative counter total, an
  expiry).
- Field/member deltas (`HSET`/`HDEL`/`ZADD`/`ZREMRANGEBYSCORE`) **merge**
  rather than collapse: queued changes for the same key fold into one net
  patch + event, where a later set of a field wins over an earlier set or
  delete of it and vice versa. A presence field flapping online/offline, or
  a sliding window churning members, costs one patch per drain, not one per
  flap.

Coalescing never reorders across different kinds, so a `SET` → `EXPIRE` →
`HSET` sequence on one key stays ordered.

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
are connected to different ZateDB nodes.

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

- **`INCR` converges on the true sum across nodes (G-counter), not
  last-write-wins.** Each node tracks its *own* cumulative contribution to
  a counter, and replicates that running total; peers fold it in by max, so
  the effective value is the sum of every node's contribution. Two clients
  hitting `INCR` on the same rate-limit key on different nodes within the
  same replication window therefore *both* count — the counter doesn't
  undercount under contention (which is exactly when rate limiting matters:
  a fail-open during a spike is the failure this avoids). Because each event
  carries a cumulative total merged by max, the convergence is commutative
  and idempotent: reordered, duplicated, or delayed delivery can't make the
  counter drift. (Other cross-node writes to the *same* value — a `SET`, or
  two `HSET`s to the same field — still resolve last-write-wins; it's
  specifically the additive `INCR` that's now conflict-free.)
- **`SET` on a counter resets it (last-write-wins).** Writing a plain value
  to a key clears its per-origin contributions cluster-wide; a `SET` racing
  concurrent `INCR`s on the same key resolves last-write-wins, as any
  overwrite does.
- **Reads are always local.** `GET` / `HGETALL` / `ZCOUNT` never call out
  to Cosmos DB — that's the whole point of the in-memory hot copy. A key
  written on another node is visible locally once its replication event
  arrives, not before.
- **A hash/sorted-set replicates at field/member granularity, not as a
  whole snapshot, and this is never downgraded to a whole-key delete.**
  `HSET`/`ZADD` ship only the specific field/value or member/score pairs
  they set; `HDEL`/`ZREMRANGEBYSCORE` ship only the specific field/member
  names that actually existed here and were removed — even when removing
  the last one empties this node's local copy. That's deliberate: another
  node may still hold a field/member on the same key that hasn't
  replicated in yet, and a whole-key delete would destroy it. (There's no
  client-observable difference anyway between "hash/sorted-set exists with
  zero fields/members" and "key is gone" — `HGETALL`/`ZCOUNT` return the
  same empty result either way, and no `EXISTS`/`TYPE` command is exposed
  — so an empty entry lingering in Cosmos DB is a harmless storage-hygiene
  cost, not a correctness one.) This means two nodes concurrently setting
  *different* fields of the *same* presence hash (`HSET presence:room1
  user1 online` on node A, `HSET presence:room1 user2 online` on node B)
  both survive regardless of arrival order — each patches only its own
  field, on Cosmos DB and on every node's in-memory copy. Concurrently
  writing the *same* field/member from two different nodes still races
  exactly like the `INCR` bullet above (last-write-wins on that one field)
  — this doesn't create a new failure mode, it just narrows the existing
  one from "the whole key" down to "the one field/member actually
  contended."
- **`EXPIRE`/`PEXPIRE` replicate as a TTL-only fact.** A TTL change ships
  just the key's new expiry (`applyReplicatedTtl` on peers, a Cosmos Patch
  on `/entry/expiresAtMs`), leaving the key's value/fields/members
  untouched. This is what keeps an `EXPIRE` on a hash/sorted set from
  reverting a peer's concurrent field/member write: the common `INCR` +
  `EXPIRE` rate-limit idiom no longer risks the expiry step clobbering the
  counter's other cross-node writes. A TTL event for a key a peer doesn't
  hold is a no-op there (`EXPIRE` can't create a key), matching local
  semantics.
- **A no-op never replicates.** `EXPIRE`/`PEXPIRE`/`HDEL`/
  `ZREMRANGEBYSCORE`/`DEL` against a key this node doesn't currently hold
  locally ship nothing at all — the dispatcher checks whether the key
  existed before *and* after the command (and, for `EXPIRE`/`PEXPIRE`,
  whether the reply was `:1`), and only replicates when something actually
  changed here. Without this, a command that's a
  genuine no-op on this node (because the key was created on another node
  moments ago and hasn't replicated in yet) would otherwise broadcast a
  phantom "this key is deleted," destroying a real value elsewhere in the
  cluster.
- **Same-node writes to the same key replicate in order.** Rapid writes on
  the same key from the same node are drained one at a time (not run
  concurrently) through the replication pipeline, so the cluster always
  converges on whichever write happened last locally — not whichever
  network round trip happened to finish first. Consecutive whole-key writes
  that haven't started yet coalesce to the latest (see "Write coalescing"
  above), which preserves this ordering while collapsing redundant
  intermediate writes. This doesn't extend across
  nodes: two *different* nodes writing the same key concurrently still
  race, per the `INCR` bullet above.
- **A newly-joining node's snapshot never overwrites a write that landed
  during hydration.** Incoming replication events are buffered (not
  applied) while a node loads its startup snapshot from Cosmos DB, then
  replayed afterward — so a write from another node that arrives mid-hydration
  always wins over the (necessarily slightly older) snapshot, rather than
  being silently reverted once hydration finishes applying it.
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
building a bespoke consensus layer on top of ZateDB.

## Standalone mode

Setting neither Cosmos DB nor Service Bus configuration (see
[Deployment](./deployment.md#configuration)) runs ZateDB exactly as
a single node with an in-memory-only store — identical behavior to
running one replica, useful for local development and the test suite.

> ### ⚠️ No HA ⇒ run exactly one replica
>
> A standalone node **cannot detect that it is one of several replicas** —
> with no shared backend there is no channel through which peers could even
> announce themselves. So when HA is not configured, ZateDB *is* a
> single node, and the deployment must enforce that with **`minReplicas =
> maxReplicas = 1`**. Run two or more replicas without HA and each serves
> its own in-memory keyspace behind one connection-spraying load balancer:
> a `SET`/`SUBSCRIBE` on one connection is invisible to a `GET`/`PUBLISH`
> on another (the split-brain that breaks presence mirroring and pub/sub
> fan-out). Nothing inside the process can catch this — the guardrails below
> cover the *configuration* mistakes it can see; the *replica-count* mistake
> is yours to prevent at the platform, and to alert on via the
> `zatedb.cluster.ha_enabled` metric joined with the platform's own
> replica count (see [Observability](./observability.md#metrics)).

**Partial HA config is a hard startup failure.** Configuring only one of
Cosmos DB / Service Bus is never intentional — real persistence with no
cross-node sync (or vice versa) would silently violate the HA guarantee —
so the process **crashes at startup** (not just with `REQUIRE_HA`), and
Container Apps' restart policy surfaces the misconfiguration loudly. There
is no supported half-HA mode to fall back to.

**`REQUIRE_HA=true` additionally rejects a *missing* HA config.** A
multi-replica deployment (the Bicep pins `minReplicas: 2`) must *never*
silently run standalone; with `REQUIRE_HA` set, starting with neither
dependency configured also crashes rather than running as independent
non-replicating nodes. It is set in
[`infra/zatedb.bicep`](../infra/zatedb.bicep); leave it unset
for local development and the test suite, where standalone is the intended
mode.

## Operational notes

- **Startup fails fast, it doesn't hang**: connecting to Cosmos DB/Service
  Bus and hydrating are both bounded by `CLUSTER_STARTUP_TIMEOUT_MS`
  (default 30s — see [Deployment](./deployment.md)). If either is
  configured but unreachable, the process exits rather than sitting
  "alive but never ready" indefinitely — a stuck replica with a
  permanently-failing readiness probe is a worse failure mode than a
  crash-loop Container Apps' restart policy can retry with backoff. This
  is also why a partially-configured environment (Cosmos DB set, Service
  Bus not, or vice versa) crashes at startup instead of half-running HA —
  see [Standalone mode](#standalone-mode) above.
- **Replication death is detected, not silent**: the receiver treats a
  vanished subscription (`MessagingEntityNotFound`) or a sustained run of
  receive errors as fatal and exits the process (non-zero), so the
  orchestrator restarts a clean instance that re-creates its subscription
  and re-hydrates. Because the receiver uses `receiveAndDelete`, anything
  missed while it was broken is gone — "keep logging and hope" would mean
  diverging forever, which is the failure this replaces.
- **Anti-entropy backstop**: every `ANTI_ENTROPY_INTERVAL_MS` (default
  5 min, matching the Service Bus message TTL) each node re-loads the
  durable keys written since its last pass (`WHERE c._ts > @since`, riding
  Cosmos's server-assigned write timestamp so one server clock — not every
  writer node's own clock — defines the watermark, which a slow-clocked peer
  can't slip beneath) and applies them locally. This is a cheap convergence
  safety net for anything a node missed during a brief partition or blip —
  applying Cosmos's snapshot is safe under last-write-wins (Cosmos is the
  source of truth, and its field/member-patched documents already reflect
  the merged state), so a missed write converges on the next pass instead
  of lingering until the key is next written. `0` disables it.
- **Service Bus auth & permissions**: the app prefers **managed identity**
  (`SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE` + `DefaultAzureCredential`),
  falling back to a connection string only when that's all that's set —
  mirroring the Cosmos layer, so production ships no Service Bus secret.
  Each node creates its own subscription on the shared replication topic at
  startup (named after its node id) and deletes it on graceful shutdown; a
  node that dies without deregistering leaves an orphaned subscription that
  self-deletes after `autoDeleteOnIdle` (1 hour). Because nodes manage
  their own subscriptions, the identity (or SAS policy) needs **manage**
  rights on the topic, not just Send/Listen — scope it to the one
  namespace/topic. Note the topic is part of the data-plane trust boundary:
  see [Security](./security.md).
- **Cosmos DB documents are never Lua/stored-procedure driven** — every
  operation is a plain upsert, delete, query, or Patch-API call via the
  SDK, keeping the "no embedded scripting engine" property from
  [Non-goals](./command-reference.md#non-goals) intact end to end.
  Field/member-level `HSET`/`HDEL`/`ZADD`/`ZREMRANGEBYSCORE` replication
  uses Cosmos's Patch API (targeted `set`/`remove` operations on
  `/entry/fields/<name>` or `/entry/members/<name>`) rather than a
  read-modify-write of the whole document — see
  [`src/cluster/cosmosDurableStore.ts`](../src/cluster/cosmosDurableStore.ts).
  Field/member names are escaped as JSON Pointer segments (`~` and `/`)
  since Redis key/field names can contain either, and patch operations are
  batched at 10 per request (Cosmos's own per-call limit).
- **Expired keys are self-limiting in Cosmos DB**: local lazy/sweep expiry
  removes keys from each node's in-memory copy independently and is *not*
  replicated (every node expires the same key on its own clock), so nothing
  deletes the corresponding Cosmos document on expiry. To keep the keys
  container from growing monotonically with every short-lived counter or
  window, each document carries a native Cosmos `ttl` property derived from
  its `expiresAtMs` (`-1` = no expiry), so Cosmos evicts dead documents
  itself. Enable this by setting **`DefaultTimeToLive` on the keys
  container** (any non-null value, e.g. `-1` for "on, but no default
  expiry") — without it the per-document `ttl` is ignored. Hydration is
  belt-and-suspenders on top: `loadAll()` excludes already-expired
  documents in its query (`WHERE ... expiresAtMs > @now`, since Cosmos's
  own TTL sweep is lazy and can lag), and the coordinator re-checks each
  returned snapshot's expiry before applying it.
- **Hydration is bounded by `MAX_MEMORY_BYTES`**: a Cosmos keyspace that
  has grown larger than a node can hold would otherwise OOM the node
  mid-hydration and turn every restart into a crash loop (replicated/
  hydrated applies deliberately bypass the write-admission ceiling). So
  hydration stops loading once the loaded estimate crosses the ceiling,
  logs `cluster.hydration_truncated`, and the node comes ready serving the
  partial set — a signal to add memory or shard the keyspace, not a silent
  time bomb.
- **Key names as document ids**: Redis key names routinely contain
  characters Cosmos DB document ids forbid (`/`, `#`, `?`); the `id` field
  is a base64url encoding of the key, with the original key kept verbatim
  in a `key` property (used as the partition key, which has no such
  restriction) — see [`src/cluster/cosmosDurableStore.ts`](../src/cluster/cosmosDurableStore.ts).

## Cost

Cosmos DB request units (RU) are the dominant marginal cost of this
architecture; Service Bus operations and replica compute are secondary.
Reads are free (always local). So the bill is essentially *mutating-write
rate × whether we persist the write* — which is where the levers are.

- **Short-TTL persistence exemption (`DURABILITY_MIN_TTL_MS`).** The
  highest-write-rate keys — fixed-window rate-limit counters, sliding-window
  zsets — live seconds to a minute and would expire long before any restart
  or anti-entropy pass could read them back. Setting this threshold makes a
  key whose *remaining TTL* is under it skip the Cosmos write entirely:
  peers still converge over Service Bus (they never read Cosmos for live
  replication), and hydration/anti-entropy simply never see a key that would
  be dead anyway. This removes the dominant RU source outright rather than
  optimising it. **Trade-off:** a *full-cluster* restart loses sub-threshold
  keys — which was the accepted contract for *all* data before persistence
  existed, and is the right trade for a rate-limit counter that resets in
  seconds. Keys with no TTL, or a TTL above the threshold, are always
  persisted; deletes are always durable. Off by default (`0`); a sensible
  enabled value is `60000`, but derive it from a load test (see below).
- **Native TTL caps storage.** Every durable document carries a Cosmos `ttl`
  derived from its expiry, so dead keys self-evict (see Operational notes) —
  storage is self-limiting even for the keys that *are* persisted.
- **Coalescing caps write frequency.** A burst of same-key writes collapses
  to the latest before the round trip (see the Replication section), so a
  hot counter costs roughly one durable write per drain, not one per command.

**A further lever, deferred until metered.** Decoupling the *Cosmos* write
cadence from the *Service Bus* cadence — a per-key minimum interval between
durable writes, so a steadily-written hot key persists at most once per
interval while peers keep converging per broadcast — would trim RU beyond
what coalescing already does. It is intentionally not implemented yet: its
marginal benefit largely overlaps the coalescing above, a correct
trailing-edge throttle needs per-key timers and a per-key timestamp map
(an unbounded-memory hazard on a large keyspace that must be bounded
carefully), and the right interval can only be chosen from the
`zatedb.cosmos.request_units` meter under real load. Add it if the
metered RU justifies the machinery.

**Right-sizing.** The numeric threshold above, the Cosmos capacity mode
(serverless vs. provisioned/autoscale), and replica count/size should be
derived from a representative load test with RU metering on, not guessed —
serverless bills per request and wins at low/bursty RU, while autoscale
provisioned throughput wins once sustained RU/s clears a few hundred. Set a
custom Cosmos **indexing policy** on the `keys` container that indexes only
the paths queries actually touch (`/key`, `/updatedAtMs`, `/entry/expiresAtMs`)
and excludes the rest — the default policy indexes every field of every hash
and every member of every zset, and write RU scales with indexed paths, so
this is typically a several-fold write-RU reduction for pure infra config.
See [Deployment](./deployment.md) for the env surface.
