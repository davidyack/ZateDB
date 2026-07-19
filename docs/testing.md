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
standalone-mode no-ops, startup hydration from a durable store, cross-node
convergence for key mutations and `PUBLISH`, self-origin filtering, and
`drain()`. These run against `FakeDurableStore`/`FakeReplicationHub`
in-memory doubles ([`test/helpers/fakeCluster.ts`](../test/helpers/fakeCluster.ts))
rather than real Azure resources — no network dependency, and the doubles
mirror the real Cosmos/Service Bus implementations' contracts (including
the transport's self-origin message filter) closely enough to catch a
regression in the coordinator's own logic.

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
