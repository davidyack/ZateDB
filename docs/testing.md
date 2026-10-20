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

[`test/integration/`](../test/integration/) boots a real ZateDB
instance ([`test/helpers/startServer.ts`](../test/helpers/startServer.ts))
on an ephemeral loopback port and exercises it with the actual client
libraries a consuming app uses:

- **`redis` (node-redis v5)** — the full [command table](./command-reference.md),
  including `WRONGTYPE` errors and channel/pattern pub/sub delivery.
- **`rate-limit-redis`** — both its **default Lua store** (`SCRIPT LOAD` +
  `EVALSHA` on the embedded VM) and the optional
  [`INCR`-based store](./rate-limit-store.md), each wired into a real
  `express-rate-limit` middleware and confirming the underlying counter is a
  real key in ZateDB.
- **`@socket.io/redis-adapter`**, wired to two independent Socket.IO server
  instances (two "replicas"), confirming a broadcast — including a room
  broadcast — from one reaches a client connected only to the other. This
  is the test that caught the binary-safety bug in the RESP layer (see
  [Architecture](./architecture.md#transport)): the adapter publishes
  msgpack-encoded payloads, and a UTF-8-based RESP implementation silently
  corrupted them.
- **`redis-v6` (node-redis v6, aliased in `devDependencies` so it can't
  collide with the pinned v5 client)** —
  [`test/integration/resp3.test.ts`](../test/integration/resp3.test.ts) and
  [`test/integration/socketioAdapterResp3.test.ts`](../test/integration/socketioAdapterResp3.test.ts).
  node-redis v6 defaults to RESP3 (it sends `HELLO 3` on every connect, with
  no RESP2 fallback), which the pinned v5 client never exercises on its own
  — that gap is exactly what let a RESP3-acknowledged-but-RESP2-encoded
  connection ship undetected. Both tests assert **zero client-side error
  events**, not just delivery: a client that logs a protocol error per frame
  and keeps limping must fail the suite.
- **The sorted-set sliding-window pattern** used by cooldown/rate-cap-style
  guards — `ZADD` / `ZREMRANGEBYSCORE` / `ZCOUNT` with the exact
  range-argument syntax (`` `(${now - windowMs}`, '+inf' ``) such a caller
  sends. This is the regression test for the class of gap a command-surface
  audit is meant to catch before it reaches production: a caller using a
  data structure or argument syntax that wasn't in scope.

[`test/integration/haReplication.test.ts`](../test/integration/haReplication.test.ts)
boots **two** full ZateDB RESP servers sharing a fake Cosmos DB /
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
a CI-time script a **consuming app** runs against its own source tree. It
fails (exit 1) if it finds a Redis command ZateDB doesn't implement, or an
option ZateDB rejects:

```bash
npm run coverage-audit -- /path/to/consuming-app/src [--include-tests]
```

The implemented-command list it checks against is
[`src/commands/commandNames.ts`](../src/commands/commandNames.ts), which the
dispatcher's `COMMANDS` table is held identical to by `tsc` (`satisfies
Record<ImplementedCommand, CommandSpec>`) — so the audit can never disagree
with what the server serves. It runs two scans:

- **Client call sites.** TypeScript-AST-based: tracks variables assigned
  from a configurable "get client" factory (default names `getRedisClient`,
  `redisClient`, `getRedisPubSubClients`) and maps node-redis camelCase
  method names to RESP command names. A `zAdd` with an options argument (or
  `zAddIncr`) fails too — ZateDB's `ZADD` takes no flags.
- **Commands inside Lua scripts.** Every string and template literal in the
  source is scanned for `redis.call(...)` / `redis.pcall(...)`, so a script
  is caught wherever it lives — a module constant, an inline `eval`
  argument, a `defineScript`/`SCRIPT LOAD` body — regardless of how it
  reaches `EVAL`/`EVALSHA`. This is the gap that produced several production
  breakages (`ZCARD`, `ZREM`, `ZADD XX CH`, `INCRBYFLOAT`, `LLEN`/`LPUSH`/
  `RPUSH`/`LPOP`, `HEXISTS` called from scripts): the client call is a
  supported `EVAL`, and the unsupported command only fails at runtime, as a
  script error. For each literal command name it checks:
  - the command is implemented **and** callable from a script (connection,
    pub/sub and scripting commands such as `EVAL`/`SUBSCRIBE` are not);
  - literal options ZateDB rejects: any `ZADD` flag
    (`NX`/`XX`/`GT`/`LT`/`CH`/`INCR`), and any `SET` option other than
    `EX`/`PX`/`KEEPTTL`/`NX`/`XX`/`GET`. Options passed through `ARGV` can't
    be seen statically and aren't checked.

  A command name that isn't a literal (`redis.call(cmd, ...)`, or a
  `${...}` substitution in a template) can't be checked; it is printed as a
  **warning** and does not fail the run. Comments are never scanned. Each
  finding is reported at the `file:line` of the `redis.call` itself.

Test files (`__tests__/`, `__mocks__/`, `test/`, `tests/`, `*.test.*`,
`*.spec.*`) are skipped by default — their scripts run against fakes, not
ZateDB; pass `--include-tests` to scan them as well.

It's a heuristic, not a type-checker or a Lua parser. Treat a clean run as a
strong signal, not a formal proof: it won't catch every aliasing pattern
(e.g. a client passed through several layers of indirection, or a script
assembled by concatenation that splits a `redis.call(` across pieces).

### Running it in a consuming app's CI

ZateDB isn't published to npm (`"private": true`), so the audit runs from a
checkout of the ZateDB ref you deploy — pin it to the same version as your
image so the audit checks the command surface you actually run.

**GitHub Actions** — use the composite action in
[`coverage-audit/`](../coverage-audit/action.yml):

```yaml
- uses: actions/checkout@v4
- uses: davidyack/ZateDB/coverage-audit@v0.1.3   # the ZateDB version you deploy
  with:
    path: backend/src
```

**Any other CI** (needs Node 18+ and git):

```bash
git clone --depth 1 --branch v0.1.3 https://github.com/davidyack/ZateDB.git .zatedb
npm --prefix .zatedb ci --omit=optional --no-audit --no-fund
npm --prefix .zatedb run -s coverage-audit -- "$PWD/backend/src"
```

`--omit=optional` skips the server's Azure/OTel runtime tree; the audit only
needs `typescript` and `tsx`. (An `npx github:davidyack/ZateDB` bin isn't
offered: a git install drops devDependencies, so it would mean shipping the
TypeScript compiler in the server's production dependencies.)

Wire it into the consuming app's CI so a newly-added Redis call — or Lua
script — using an unsupported command fails the build instead of failing
silently in production.

## Performance benchmark

[`scripts/benchmark.ts`](../scripts/benchmark.ts) is a client-side
throughput/latency probe. It drives the same `redis` (node-redis v5) client
the consuming app uses and only issues commands from the
[supported table](./command-reference.md), so it's meaningful out of the box
— unlike `redis-benchmark`/`memtier_benchmark`, which default to commands
ZateDB doesn't implement and need hand-tuned flags to stay inside the
command surface.

```bash
npm run bench                          # in-process server, default mix
npm run bench -- -n 200000 -c 100      # 200k ops/command, 100 in flight
npm run bench -- -t set,get,incr       # only these commands
npm run bench -- --url redis://host:6379   # against a running instance (add :pw@ for AUTH)
```

By default it boots an in-process ZateDB on an ephemeral loopback port
(the same way the integration tests do), so no running instance is required;
`--url` (or `REDIS_URL`) measures the real network path instead. It reports
per-command ops/sec and latency percentiles (avg/p50/p95/p99/max).

This is a probe, not a formal benchmark: numbers depend on the machine, Node
version, and (for `--url`) the network hop — use it to catch regressions and
compare configurations, not as an absolute figure. It measures a single
ZateDB node driven directly by one client; it deliberately does not
exercise cross-node HA replication (see
[Architecture](./architecture.md)) — that path is covered by the
integration tests above, not this throughput probe.
