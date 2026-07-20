# Operations runbook

Incident-time reference for BackendCache in HA mode. For the *why* behind
these mechanisms see [High availability](./high-availability.md); this page
is the *what to do*. Everything here uses tooling that already exists (admin
API, metrics, logs) — no code changes required to diagnose.

## Reaching the admin API

The admin API listens on `:8082` (`ADMIN_PORT`) and is **internal-only** —
Container Apps ingress is bound to the RESP port (`:6379`), so `:8082` is
not exposed externally by design (see [Security](./security.md)). To reach
it during an incident, from inside the environment (a debug container in the
same Container Apps Environment, or `az containerapp exec` into a replica):

```bash
# from a shell inside a replica or a peer in the same environment
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8082/admin/stats
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://<replica-ip>:8082/admin/nodes
```

Because ingress load-balances per connection with no affinity, `/admin/stats`
and `/admin/pubsub` return a merged cluster-wide view plus a per-node
breakdown regardless of which replica answers; `/admin/nodes` lists
membership directly.

## "Is replication flowing?"

Check, in order:

1. **Replication queue depth** — `backendcache.replication.queue_depth`
   gauge. Steady near zero is healthy. Sustained growth means Cosmos/Service
   Bus writes aren't draining as fast as they arrive (a slow or throttled
   Cosmos, a Service Bus problem, or a write burst).
2. **Anti-entropy activity** — the `cluster.anti_entropy_reconciled` log
   (with an `applied` count) fires each reconcile pass that repaired
   something. Occasional small counts are normal. **Repeated non-zero
   `applied` every pass means live replication is limping** — events are
   being missed and only the 5-minute backstop is catching them. Investigate
   Service Bus receive health.
3. **Node membership / staleness** — `/admin/nodes`. Every live node should
   appear with a recent heartbeat. A node missing here that you believe is
   running has lost its heartbeat write path (Cosmos) — or crashed (its doc
   self-expires at ~2× `NODE_STALE_MS`).
4. **Fatal replication exits** — `cluster.replication_fatal` /
   `backendcache.replication_fatal` logs mean a node detected a dead
   subscription or sustained receive errors and exited to be restarted (it
   re-creates its subscription and re-hydrates on restart). Repeated cycling
   points at a Service Bus permissions/topology problem.

## `cluster.hydration_truncated`

A node logged this at startup: the durable keyspace in Cosmos exceeded
`MAX_MEMORY_BYTES`, so it hydrated a **partial** set and came ready anyway
(serving a partial cache beats never becoming ready). The `loaded` /
`totalDocuments` fields show how much was dropped. Action:

- **Short term**: raise the replica memory (`MAX_MEMORY_BYTES` and the
  container memory limit together) so the full keyspace fits.
- **Longer term**: the single-node capacity ceiling has been reached — plan
  namespace sharding (a second independent cluster per use case). Also check
  whether the Cosmos native TTL is actually enabled on the `keys` container;
  without it, expired docs accumulate and inflate hydration (see below).

## Durability tiers (what comes back after a restart)

Data has three tiers — know which you're reasoning about mid-incident:

- **Ephemeral** (`PUBLISH`): never persisted; nothing to recover.
- **Convergent-only** (short-TTL keys, when `DURABILITY_MIN_TTL_MS` is set):
  replicated over Service Bus but **not** written to Cosmos. A single-node
  restart re-converges them from peers; a **full-cluster** restart loses
  them — by explicit contract, and they'd have expired within the threshold
  anyway. This is the expected behavior for rate-limit / sliding-window
  counters, not a bug.
- **Durable** (no-TTL / long-TTL keys): written to Cosmos; survive a
  full-cluster restart (minus anything Cosmos native-TTL-evicted, which was
  correctly expired).

If a full-cluster restart "lost" rate-limit counters, that's the
convergent-only tier behaving as designed.

## Cost / Cosmos health

- **RU consumption** — `backendcache.cosmos.request_units` (by operation).
  A rising slope with flat traffic means a regression: check the indexing
  policy is applied to the `keys` container (the default policy multiplies
  write RU several-fold) and that `DURABILITY_MIN_TTL_MS` is set (otherwise
  every rate-limit tick writes Cosmos). See
  [Deployment → Cosmos cost & sizing](./deployment.md#cosmos-db-cost--sizing).
- **Storage growth** — if the `keys` container grows without bound, native
  TTL (`DefaultTimeToLive`) is not enabled on it; enable it so expired docs
  self-evict.

## Latency diagnosis

Set `SLOW_COMMAND_LOG_MS` (e.g. `10`) to log any command that takes at least
that many ms with a redacted key (`command.slow`). Commands are normally
sub-millisecond, so this is high-signal — use it to catch a fan-out stall or
an oversized-entry recompute, then unset it.

## Suggested alerts

| Signal | Condition | Meaning |
|---|---|---|
| `backendcache.replication.queue_depth` | sustained > N for minutes | writes not draining — Cosmos/SB back-pressure |
| `cluster.anti_entropy_reconciled` `applied` | > 0 on consecutive passes | live replication is missing events |
| `backendcache.cosmos.request_units` | slope up with flat traffic | cost regression (indexing policy / exemption off, keyspace growth) |
| `/readyz` | 503 beyond expected hydration time | stuck hydration — check `cluster.hydration_truncated` and Cosmos reachability |
| `cluster.replication_fatal` | any, especially repeated | subscription death / SB problem; node cycling |
