# ZateDB

A small, self-hosted, RESP-protocol-compatible cache and pub/sub service. It
implements the Redis command surface consuming applications actually call, so
an existing `redis` (node-redis v5) client, `rate-limit-redis` (including its
default Lua-script store), and the Socket.IO Redis adapter connect to it as a
drop-in replacement for Redis — no new SDK, and a config-only change.

ZateDB is intentionally narrow in scope: it is not a general-purpose
Redis-compatible engine. It supports:

- **Strings** — `GET`/`SET` with `EX`/`PX`/`KEEPTTL`/`NX`/`XX`/`GET` (the
  `SET … NX PX` distributed-lock primitive), `MGET`/`MSET`, `INCR`.
- **Hashes** and **sorted sets** (range-bound `ZADD`/`ZCOUNT`/`ZREMRANGEBYSCORE`).
- **Keys** — `DEL`, `EXISTS`, `EXPIRE`/`PEXPIRE`, `TTL`/`PTTL`, and `SCAN`
  (for session/cache stores like `connect-redis`).
- **Lua scripting** — `EVAL`/`EVALSHA`/`SCRIPT` on an embedded VM, with
  `redis.call` and cross-node effects replication.
- **Server** — `PING`, `INFO`, and a Prometheus `/metrics` endpoint.
- **Pub/sub** — channel and pattern subscriptions.

It adds commands only when a real caller needs them. See the full
[command reference](./docs/command-reference.md) for what's supported and why
everything else is a deliberate non-goal.

## Why this exists

Some consuming applications have a cross-replica dependency on Redis
(shared rate-limit counters, presence mirroring, Socket.IO fan-out,
sliding-window abuse guards) that only matters once you run more than one
API replica. ZateDB lets you satisfy that dependency with a small,
purpose-built service you deploy alongside your app — no external managed
Redis service required — while keeping the exact same client library and
connection code your app already has. ZateDB itself runs as
multiple nodes for high availability: each holds an in-memory hot copy for
fast reads, stays in sync with the others over Azure Service Bus, and
persists to Cosmos DB as the durable backing store, so a node restarting
or scaling doesn't lose shared state. See
[High availability](./docs/high-availability.md) for the architecture.

## Running locally

```bash
npm install
npm run dev        # tsx watch, RESP on :6379, health on :8081, admin on :8082
```

## Testing

```bash
npm test               # unit + integration
npm run test:unit
npm run test:integration
```

Correctness is defined by "does the real client library work" — the
integration suite exercises a real ZateDB instance with `redis`
(node-redis v5), a real `express-rate-limit` middleware, and
`@socket.io/redis-adapter`. See [Testing](./docs/testing.md) for details,
including the CI-time [command coverage audit](./docs/testing.md#command-coverage-audit)
script.

## Deployment

The image is published to GHCR, so there's nothing to build:

```bash
docker run -p 6379:6379 -p 8081:8081 -p 8082:8082 ghcr.io/davidyack/zatedb:latest
```

Releases publish `X.Y.Z` and `latest`; merges to `main` publish `edge` and
`sha-<short>`. Pin a release tag for anything you depend on. To build it
yourself instead:

```bash
docker build -t zatedb:latest .
docker run -p 6379:6379 -p 8081:8081 -p 8082:8082 zatedb:latest
```

For Azure, `infra/modules/zatedb.bicep` is a Bicep module you drop into your
application's own template. It runs ZateDB as a multi-node Container App
(2+ replicas) with internal-only ingress, and creates its own identity,
Service Bus topic, Cosmos database/containers, and role assignments inside
infrastructure you already have:

```bicep
module zatedb 'modules/zatedb.bicep' = {
  name: 'zatedb'
  params: {
    namePrefix: 'contoso'
    managedEnvironmentId: containerAppsEnvironment.id
    serviceBusNamespaceName: serviceBus.name
    cosmosAccountName: cosmos.name
    authPassword: redisPassword
  }
}
```

`containerImage` defaults to the published `ghcr.io/davidyack/zatedb` image,
and the module itself is also published — see
[`infra/README.md`](./infra/README.md) for referencing it directly instead
of vendoring. See that same doc for the rest of what it expects and the
already-have-Cosmos variants, and [Deployment](./docs/deployment.md) for
configuration options and the full picture.

## Docs

- [Architecture](./docs/architecture.md) — transport, storage, pub/sub, and shutdown.
- [High availability](./docs/high-availability.md) — running as multiple nodes: Service Bus replication, Cosmos DB persistence, hydration, and the consistency model.
- [Command reference](./docs/command-reference.md) — every supported command, plus the non-goals and why each was excluded.
- [The rate-limit store](./docs/rate-limit-store.md) — `rate-limit-redis`'s default store now works via Lua; an optional lighter-weight `INCR`-based store is also provided.
- [Deployment](./docs/deployment.md) — configuration, running locally, Docker, and the Container Apps Bicep sketch.
- [Observability](./docs/observability.md) — the admin API, OpenTelemetry tracing/metrics, and logging.
- [Testing](./docs/testing.md) — the testing strategy and the command coverage audit script.
- [Security](./docs/security.md) — the threat model and controls.
