# BackendCache

A small, self-hosted, RESP-protocol-compatible cache and pub/sub service. It
implements only the Redis command surface a consuming application actually
calls, so an existing `redis` (node-redis v5) client, `rate-limit-redis`, and
the Socket.IO Redis adapter can connect to it as a drop-in replacement for
Redis — no new SDK, no consuming-code changes beyond the one deliberate
exception documented below.

BackendCache is intentionally narrow in scope: it is not a general-purpose
Redis-compatible engine. It supports strings, hashes, sorted sets, key
expiry, and pub/sub — nothing else — and adds commands only when a real
caller needs them.

## Why this exists

Some consuming applications have an optional, cross-replica dependency on
Redis (shared rate-limit counters, presence mirroring, Socket.IO fan-out,
sliding-window abuse guards) that only matters once you run more than one
API replica. BackendCache lets you satisfy that dependency with a small,
purpose-built service you deploy alongside your app — no external managed
Redis service required — while keeping the exact same client library and
connection code your app already has.

## Command surface

Every command below is implemented and covered by integration tests against
the real client libraries that use it (see [Testing](#testing)).

| Command | Notes |
|---|---|
| `PING` | |
| `HELLO` | Acknowledged; connection stays on RESP2 regardless of requested protover |
| `AUTH` | Required before other commands when `REDIS_AUTH_PASSWORD` is set |
| `CLIENT SETINFO` / `GETNAME` / `SETNAME` / `ID` | No-ops beyond bookkeeping — must never error, node-redis sends `SETINFO` on every connect |
| `QUIT` | |
| `GET` / `SET` (`EX`, `PX`) / `DEL` | |
| `INCR` | Creates the key at 0 first |
| `EXPIRE` / `PEXPIRE` (`NX`/`XX`/`GT`/`LT`) | |
| `HSET` / `HDEL` / `HGETALL` | |
| `ZADD` / `ZREMRANGEBYSCORE` / `ZCOUNT` | Full Redis range-bound syntax: bare number = inclusive, `(number` = exclusive, `-inf`/`+inf` = unbounded |
| `PUBLISH` / `SUBSCRIBE` / `PSUBSCRIBE` / `UNSUBSCRIBE` / `PUNSUBSCRIBE` | Redis glob pattern matching (`*`, `?`, `[...]`) for `PSUBSCRIBE` |

Anything not in this table returns `ERR unknown command` rather than
silently no-opping, so a caller using an unsupported command is caught
immediately instead of failing silently in production. See
[Command coverage audit](#command-coverage-audit) for a CI-time way to
catch this before it ships.

## Non-goals

| Excluded | Why |
|---|---|
| `EVAL` / `EVALSHA` / `SCRIPT LOAD` (Lua scripting) | No embedded Lua runtime. `rate-limit-redis`'s default store needs this — see [The rate-limit store deviation](#the-rate-limit-store-deviation) for the one place a consuming app needs a small workaround. |
| Persistence (RDB, AOF) | Everything here is intentionally ephemeral, matching real Redis pub/sub's own fire-and-forget semantics. |
| Clustering / sharding / replication / multi-node HA | Single process, single dataset, single replica by design — see below. |
| RESP3, ACLs, other data types (lists, sets, streams, geo, bitmaps, HyperLogLog) | Add on demand when a real caller needs them; don't build speculatively. |
| TLS termination in-process | Assumes a private, same-environment network hop (e.g. Container Apps internal ingress). Terminate TLS upstream if your network policy requires it in transit. |

If a future need grows past this list, prefer a real Redis-compatible
engine (Valkey, Dragonfly) over expanding BackendCache into a
general-purpose cache reimplementation.

## Why single-replica

Running more than one BackendCache replica would reintroduce the exact
cross-replica coordination problem it exists to solve, one layer down.
State is in-memory only, so a restart resets counters and pub/sub
subscriptions — acceptable for ephemeral, non-billing data. Revisit only if
BackendCache's own availability becomes a measured problem.

## The rate-limit store deviation

`rate-limit-redis`'s default `RedisStore` sends a Lua script via
`EVALSHA`/`EVAL` to increment-and-check atomically. BackendCache doesn't
support Lua, so a consuming app's rate-limit middleware needs a small,
deliberate replacement — not a byte-for-byte drop-in, but an isolated
~15-line store swap in one file:

```ts
count = await client.incr(key);
await client.expire(key, windowSeconds, 'NX'); // no-op if a TTL is already set
return count;
```

A reference implementation is in [`examples/rateLimitStore.ts`](./examples/rateLimitStore.ts)
and is exercised end-to-end in
[`test/integration/rateLimitStore.test.ts`](./test/integration/rateLimitStore.test.ts)
against a real `express-rate-limit` middleware and a real BackendCache
instance.

Fixed-window counters via `INCR` + `EXPIRE NX` allow a client to burst up to
~2x the limit right at a window boundary — a property of fixed-window
algorithms generally, not a regression versus the Lua-script approach. The
race window itself (two concurrent first-requests both trying to set the
TTL) is closed by the `NX` flag.

## Architecture

```
                    ┌─────────────────────────────┐
                    │        BackendCache            │
  client library ──▶│  TCP listener (RESP) :6379       │
                    │  Connection manager (per-conn      │
                    │   parser, pub/sub mode switch)      │
                    │  Command dispatcher                  │
                    │  In-memory store (string / hash /     │
                    │   sortedset maps, TTL sweep,            │
                    │   pub/sub registry)                      │
                    │  HTTP :8081  /healthz                     │
                    │  HTTP :8082  /admin/*  (token-gated)       │
                    │  OpenTelemetry traces + metrics              │
                    └─────────────────────────────┘
```

- **Transport**: raw TCP (`net.createServer`), RESP2 framing. Bulk strings
  are treated as binary-safe (not assumed to be valid UTF-8) — this matters
  in practice, since the Socket.IO Redis adapter publishes msgpack-encoded
  binary payloads over `PUBLISH`.
- **Storage**: a single `Map<string, Entry>` keyed by name, entries tagged
  as `string` / `hash` / `sortedset`, each with an optional TTL. A command
  against the wrong type returns `WRONGTYPE`, matching real Redis's error
  text. TTL expiry is both lazy (checked on access) and actively swept on a
  low-frequency interval so idle expired keys don't sit in memory forever.
- **Pub/sub**: a channel/pattern subscription registry. `PUBLISH` delivers
  synchronously to whoever is subscribed right now — no queueing, no
  persistence, matching real Redis pub/sub semantics. On disconnect
  (clean or abrupt), a connection is always removed from every
  subscription it held, so a dead socket can never be a `PUBLISH` target.
- **Graceful shutdown**: on `SIGTERM`, stop accepting new connections,
  let in-flight commands finish (all command handling is synchronous),
  then close idle connections.

## Admin API

A token-gated JSON API on its own port (`:8082`, separate from the RESP
port and `/healthz`), for `curl`/support-tooling use — no UI.

Every request requires `Authorization: Bearer <ADMIN_TOKEN>`. If
`ADMIN_TOKEN` isn't set, the admin API relies on network isolation alone —
set it in any environment where the admin port is reachable by more than
trusted operators.

| Endpoint | Method | Purpose |
|---|---|---|
| `/admin/stats` | GET | Uptime, connection count, key counts by type, subscription counts, command throughput, memory estimate |
| `/admin/keys?prefix=&limit=&offset=` | GET | Paginated key names + type + TTL — no values, to avoid turning a debug endpoint into a bulk-exfiltration surface |
| `/admin/keys/:key` | GET | Full detail (type, value/members, TTL) for one key |
| `/admin/keys/:key` | DELETE | Force-clear a stuck key. Destructive — logged and emitted as a metric |
| `/admin/pubsub` | GET | Active channels/patterns with subscriber counts (topology only, no message content) |

## Observability

OpenTelemetry traces and metrics, exported via the Azure Monitor exporter
(when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set) or plain OTLP HTTP
(when `OTEL_EXPORTER_OTLP_*` endpoints are set). If neither is configured,
telemetry degrades to a no-op — it's never a hard runtime dependency.

- One span per command execution (`backendcache.command.<COMMAND>`), not
  per connection — a Socket.IO adapter's subscriber connection can live for
  the process's entire lifetime, so it's not a valid span boundary. Key
  names are redacted (an 8-char prefix + a short hash) before landing in a
  span attribute, since a key can embed identifying data.
- Metrics: `backendcache.commands.total`, `backendcache.commands.duration_ms`,
  `backendcache.connections.active`, `backendcache.pubsub.subscriptions.active`,
  `backendcache.admin.actions.total`.
- Structured JSON logs to stdout/stderr for connection lifecycle, command
  errors, and every admin action.
- Known limitation: RESP has no header/metadata channel, so a command span
  can't be a child of the caller's originating HTTP request trace.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `RESP_PORT` | `6379` | RESP TCP listener |
| `HEALTH_PORT` | `8081` | `/healthz` |
| `ADMIN_PORT` | `8082` | Admin JSON API |
| `REDIS_AUTH_PASSWORD` | unset | RESP `AUTH` password; unset means no auth required |
| `ADMIN_TOKEN` | unset | Admin API bearer token; unset means the admin API relies on network isolation alone |
| `TTL_SWEEP_INTERVAL_MS` | `5000` | Active TTL sweep frequency |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | unset | Enables the Azure Monitor OpenTelemetry exporter |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables plain OTLP HTTP export as an alternative to Azure Monitor |

A consuming application points its `REDIS_URL` at BackendCache exactly as
it would at real Redis — e.g. `redis://:<password>@backendcache:6379` —
with no other code changes (see the one exception above).

## Running locally

```bash
npm install
npm run dev        # tsx watch, RESP on :6379, health on :8081, admin on :8082
```

## Testing

```bash
npm test               # unit + integration
npm run test:unit      # RESP parser/serializer, store/TTL, pub/sub registry, score-range parsing
npm run test:integration
```

Correctness here is defined by "does the real client library work", not by
unit-testing this repo's own logic in isolation. The integration suite
spins up a real BackendCache instance and exercises it with:

- `redis` (node-redis v5) directly, covering the full command table above.
- A `rate-limit-redis`-shaped custom store (see
  [The rate-limit store deviation](#the-rate-limit-store-deviation)) via a
  real `express-rate-limit` middleware.
- `@socket.io/redis-adapter` wired to two independent Socket.IO server
  instances, confirming a broadcast (including a room broadcast) from one
  reaches a client connected only to the other.
- The sorted-set sliding-window pattern used by per-recipient cooldown,
  per-ticket caps, and per-workspace send-rate guards — `ZADD` /
  `ZREMRANGEBYSCORE` / `ZCOUNT` with the exact range-argument syntax
  (`` `(${now - windowMs}`, '+inf' ``) such a caller sends. This is the
  regression test for the class of gap a command-surface audit is meant to
  catch before it reaches production: a caller using a data structure that
  wasn't in scope.

## Command coverage audit

A CI-time script that scans a consuming app's source tree for Redis client
call sites and fails if it finds a command BackendCache doesn't implement:

```bash
npm run coverage-audit -- /path/to/consuming-app/src
```

It's a heuristic (tracks variables assigned from a configurable "get
client" factory, maps node-redis camelCase method names to RESP command
names), not a full type-checker — treat a clean run as a strong signal, not
a formal proof. Wire it into the consuming app's CI so a newly-added Redis
call using an unsupported command fails the build instead of failing
silently in production.

## Deployment

`Dockerfile` builds a minimal Node image exposing the RESP port (`6379`),
health port (`8081`), and admin port (`8082`). `infra/backendcache.bicep`
is a deployment sketch for running it as a single-replica Azure Container
App with internal-only ingress inside an existing Container Apps
Environment — not a complete, standalone template; it assumes the
surrounding infrastructure (Container Apps Environment, container
registry, managed identity, Application Insights, Key Vault secrets) is
already provisioned.

```bash
docker build -t backendcache:latest .
docker run -p 6379:6379 -p 8081:8081 -p 8082:8082 backendcache:latest
```

## Security

- No public ingress: network exposure is the primary control (internal-only
  Container Apps ingress, or equivalent in your environment).
- `AUTH` via `REDIS_AUTH_PASSWORD`, sent automatically by `redis` whenever
  `REDIS_URL` includes credentials — defense-in-depth even on a private
  network.
- The admin API token is a separate secret from the `AUTH` password,
  independently rotatable — different blast radius (one reads/writes cache
  data as the app would; the other can inspect/delete arbitrarily via the
  admin surface).
- No `EVAL`/scripting support means no arbitrary code execution surface —
  a structurally smaller attack surface than a general-purpose
  Redis-compatible engine, not just a scope-cutting choice.
