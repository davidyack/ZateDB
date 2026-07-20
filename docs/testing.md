# Testing

```bash
npm test               # unit + integration
npm run test:unit      # RESP parser/serializer, store/TTL, pub/sub registry, score-range parsing
npm run test:integration
```

Correctness here is defined by "does the real client library work," not by
unit-testing this repo's own logic in isolation.

## Unit tests

[`test/unit/`](../test/unit/) covers the protocol-and-data-structure layer
in isolation: RESP parser/serializer round-trips (including chunked TCP
input and binary-safe bulk strings), store/TTL behavior (lazy expiry,
active sweep, `WRONGTYPE` errors), the pub/sub registry (channel/pattern
delivery, disconnect cleanup), sorted-set range-bound parsing, and
`ClusterCoordinator` ([`test/unit/clusterCoordinator.test.ts`](../test/unit/clusterCoordinator.test.ts)):
standalone-mode no-ops, startup hydration from a durable store (including
a live write arriving mid-hydration not being clobbered by the snapshot),
cross-node convergence for key mutations and `PUBLISH`, field-level
convergence for concurrent `HSET`/`ZADD` on *different* fields/members of
the same key, self-origin filtering, and `drain()`. These run against
`FakeDurableStore`/`FakeReplicationHub` in-memory doubles
([`test/helpers/fakeCluster.ts`](../test/helpers/fakeCluster.ts)) rather
than real Azure resources — no network dependency, and the doubles mirror
the real Cosmos/Service Bus implementations' contracts (including the
transport's self-origin message filter) closely enough to catch a
regression in the coordinator's own logic.

[`test/unit/dispatcherReplication.test.ts`](../test/unit/dispatcherReplication.test.ts)
covers the dispatcher's replication *decisions* specifically: no-op
commands against a key this node never had ship nothing (not a phantom
delete), `SET`/`INCR`/`HSET`/`ZADD` still replicate when creating a brand
new key, a partial `HDEL`/`ZREMRANGEBYSCORE` replicates only the removed
field/member (verified against the exact shape landed in the durable
store) while removing the last one replicates a whole-key delete instead
of a leftover empty hash/set, and sequential writes to the same key
replicate in call order despite artificially reordered network latency.

## Integration tests

[`test/integration/`](../test/integration/) boots a real BackendCache
instance ([`test/helpers/startServer.ts`](../test/helpers/startServer.ts))
on an ephemeral loopback port and exercises it with the actual client
libraries a consuming app uses:

- **`redis` (node-redis v5)** — the full [command table](./command-reference.md),
  including `WRONGTYPE` errors and channel/pattern pub/sub delivery.
- **A `rate-limit-redis`-shaped custom store** — see
  [The rate-limit store deviation](./rate-limit-store.md) — wired into a
  real `express-rate-limit` middleware, confirming the underlying counter
  is a real `INCR`-backed key.
- **`@socket.io/redis-adapter`**, wired to two independent Socket.IO server
  instances (two "replicas"), confirming a broadcast — including a room
  broadcast — from one reaches a client connected only to the other. This
  is the test that caught the binary-safety bug in the RESP layer (see
  [Architecture](./architecture.md#transport)): the adapter publishes
  msgpack-encoded payloads, and a UTF-8-based RESP implementation silently
  corrupted them.
- **The sorted-set sliding-window pattern** used by cooldown/rate-cap-style
  guards — `ZADD` / `ZREMRANGEBYSCORE` / `ZCOUNT` with the exact
  range-argument syntax (`` `(${now - windowMs}`, '+inf' ``) such a caller
  sends. This is the regression test for the class of gap a command-surface
  audit is meant to catch before it reaches production: a caller using a
  data structure or argument syntax that wasn't in scope.

[`test/integration/haReplication.test.ts`](../test/integration/haReplication.test.ts)
boots **two** full BackendCache RESP servers sharing a fake Cosmos DB /
Service Bus pair (same doubles as the unit tests, wired through two
independent `ClusterCoordinator`s) and drives each with its own real
`redis` client — proving, end to end and at the RESP protocol level, that
an `INCR`/`HSET`/`ZADD`/`DEL` issued against one node is visible from the
other, and that a `PUBLISH` on one node reaches a subscriber connected
only to the other (the actual cross-node case the Socket.IO adapter
depends on). [`test/integration/adminServer.test.ts`](../test/integration/adminServer.test.ts)
covers the admin API's cluster-aware behavior the same way (standalone vs.
HA `/admin/stats`/`/admin/nodes`, and a `DELETE` propagating to the other
node).

## Command coverage audit

[`scripts/commandCoverageAudit.ts`](../scripts/commandCoverageAudit.ts) is
a CI-time script a **consuming app** runs against its own source tree,
scanning for Redis client call sites and failing if it finds a command
BackendCache doesn't implement:

```bash
npm run coverage-audit -- /path/to/consuming-app/src
```

It's a heuristic (TypeScript-AST-based, tracks variables assigned from a
configurable "get client" factory — default names `getRedisClient` and
`redisClient` — and maps node-redis camelCase method names to RESP command
names), not a full type-checker. Treat a clean run as a strong signal, not
a formal proof: it won't catch every possible aliasing pattern (e.g. a
client passed through several layers of indirection).

Wire it into the consuming app's CI so a newly-added Redis call using an
unsupported command fails the build instead of failing silently in
production — this is the exact mechanism that would have caught a
scoping gap immediately, rather than discovering it as a production
incident later.

## Performance benchmark

[`scripts/benchmark.ts`](../scripts/benchmark.ts) is a client-side
throughput/latency probe. It drives the same `redis` (node-redis v5) client
the consuming app uses and only issues commands from the
[supported table](./command-reference.md), so it's meaningful out of the box
— unlike `redis-benchmark`/`memtier_benchmark`, which default to commands
BackendCache doesn't implement and need hand-tuned flags to stay inside the
command surface.

```bash
npm run bench                          # in-process server, default mix
npm run bench -- -n 200000 -c 100      # 200k ops/command, 100 in flight
npm run bench -- -t set,get,incr       # only these commands
npm run bench -- --url redis://host:6379   # against a running instance (add :pw@ for AUTH)
```

By default it boots an in-process BackendCache on an ephemeral loopback port
(the same way the integration tests do), so no running instance is required;
`--url` (or `REDIS_URL`) measures the real network path instead. It reports
per-command ops/sec and latency percentiles (avg/p50/p95/p99/max).

This is a probe, not a formal benchmark: numbers depend on the machine, Node
version, and (for `--url`) the network hop — use it to catch regressions and
compare configurations, not as an absolute figure. It measures a single
BackendCache node driven directly by one client; it deliberately does not
exercise cross-node HA replication (see
[Architecture](./architecture.md)) — that path is covered by the
integration tests above, not this throughput probe.
