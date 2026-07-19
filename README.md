# BackendCache

A small, self-hosted, RESP-protocol-compatible cache and pub/sub service. It
implements only the Redis command surface a consuming application actually
calls, so an existing `redis` (node-redis v5) client, `rate-limit-redis`, and
the Socket.IO Redis adapter can connect to it as a drop-in replacement for
Redis — no new SDK, no consuming-code changes beyond
[one deliberate exception](./docs/rate-limit-store.md).

BackendCache is intentionally narrow in scope: it is not a general-purpose
Redis-compatible engine. It supports strings, hashes, sorted sets, key
expiry, and pub/sub — nothing else — and adds commands only when a real
caller needs them. See the full [command reference](./docs/command-reference.md)
for what's supported and why everything else is a deliberate non-goal.

## Why this exists

Some consuming applications have a cross-replica dependency on Redis
(shared rate-limit counters, presence mirroring, Socket.IO fan-out,
sliding-window abuse guards) that only matters once you run more than one
API replica. BackendCache lets you satisfy that dependency with a small,
purpose-built service you deploy alongside your app — no external managed
Redis service required — while keeping the exact same client library and
connection code your app already has. BackendCache itself runs as
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
integration suite exercises a real BackendCache instance with `redis`
(node-redis v5), a real `express-rate-limit` middleware, and
`@socket.io/redis-adapter`. See [Testing](./docs/testing.md) for details,
including the CI-time [command coverage audit](./docs/testing.md#command-coverage-audit)
script.

## Deployment

```bash
docker build -t backendcache:latest .
docker run -p 6379:6379 -p 8081:8081 -p 8082:8082 backendcache:latest
```

`infra/backendcache.bicep` is a sketch for a multi-node Azure Container
App (2+ replicas) with internal-only ingress, wired to Service Bus and
Cosmos DB for cross-node sync. See [Deployment](./docs/deployment.md) for
configuration options and the full picture.

## Docs

- [Architecture](./docs/architecture.md) — transport, storage, pub/sub, and shutdown.
- [High availability](./docs/high-availability.md) — running as multiple nodes: Service Bus replication, Cosmos DB persistence, hydration, and the consistency model.
- [Command reference](./docs/command-reference.md) — every supported command, plus the non-goals and why each was excluded.
- [The rate-limit store deviation](./docs/rate-limit-store.md) — the one place a consuming app needs a small code change.
- [Deployment](./docs/deployment.md) — configuration, running locally, Docker, and the Container Apps Bicep sketch.
- [Observability](./docs/observability.md) — the admin API, OpenTelemetry tracing/metrics, and logging.
- [Testing](./docs/testing.md) — the testing strategy and the command coverage audit script.
- [Security](./docs/security.md) — the threat model and controls.
