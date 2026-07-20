# Architecture

This document covers a single node's internals — transport, storage,
pub/sub, command dispatch, and shutdown. For how multiple nodes stay in
sync (Service Bus replication, Cosmos DB persistence, startup hydration,
the consistency model that implies), see
[High availability](./high-availability.md).

```
                    ┌─────────────────────────────┐
                    │        ZateDB            │
  client library ──▶│  TCP listener (RESP) :6379       │
                    │  Connection manager (per-conn      │
                    │   parser, pub/sub mode switch)      │
                    │  Command dispatcher                  │
                    │  In-memory store (string / hash /     │
                    │   sortedset maps, TTL sweep,            │
                    │   pub/sub registry)                      │
                    │  Cluster coordinator (hydration,           │
                    │   replication, heartbeat — see              │
                    │   high-availability.md)                       │
                    │  HTTP :8081  /healthz, /readyz                  │
                    │  HTTP :8082  /admin/*  (token-gated)             │
                    │  OpenTelemetry traces + metrics                   │
                    └─────────────────────────────┘
```

## Transport

Raw TCP (`net.createServer`), RESP2 framing — see
[`src/resp/parser.ts`](../src/resp/parser.ts) and
[`src/resp/serializer.ts`](../src/resp/serializer.ts). Bulk strings are
treated as binary-safe: parsing and serialization use `latin1` byte-for-byte
encoding rather than assuming UTF-8. This matters in practice — the
Socket.IO Redis adapter publishes msgpack-encoded binary payloads over
`PUBLISH`, and a UTF-8 round-trip would silently corrupt them. This gap was
only caught by testing against the real `@socket.io/redis-adapter` package
(see [Testing](./testing.md)), not by hand-written protocol tests.

Each connection owns one parser instance and moves through a small state
machine ([`src/server/connection.ts`](../src/server/connection.ts)):

`handshake` → `command` → `subscriber` (after the first `SUBSCRIBE`/
`PSUBSCRIBE`, only pub/sub-management commands and `PING`/`QUIT` are
accepted, matching real Redis) → `closed`.

## Storage

A single `Map<string, Entry>` ([`src/store/store.ts`](../src/store/store.ts)),
entries tagged as `string` / `hash` / `sortedset`, each with an optional
`expiresAtMs`. A command against the wrong type returns `WRONGTYPE`,
matching real Redis's error text exactly — a caller may branch on it.

TTL expiry is two-pronged:

- **Lazy**: checked on every read/write to a key; an expired entry is
  treated as absent and removed.
- **Active sweep**: a low-frequency interval (`TTL_SWEEP_INTERVAL_MS`,
  default 5s) walks entries with a TTL set and evicts expired ones, so an
  idle expired key doesn't sit in memory indefinitely.

Sorted-set range queries (`ZCOUNT`, `ZREMRANGEBYSCORE`) support the full
Redis bound syntax — see [`src/store/scoreRange.ts`](../src/store/scoreRange.ts):
a bare number is inclusive, a `(number` prefix is exclusive, and
`-inf`/`+inf` are unbounded. This is not simplified to numeric-only
parsing, because real callers send the exclusive/unbounded forms (a
sliding-window rate check is typically `ZCOUNT key "(<cutoff>" "+inf"`).

## Pub/sub

A channel/pattern subscription registry
([`src/pubsub/registry.ts`](../src/pubsub/registry.ts)). `PUBLISH` delivers
synchronously to whoever is subscribed right now — no queueing, no
persistence, matching real Redis pub/sub semantics (real Redis pub/sub is
also fire-and-forget). `PSUBSCRIBE` pattern matching uses Redis's glob
syntax (`*`, `?`, `[...]`), not a general shell glob.

Disconnect cleanup is a correctness requirement, not an afterthought: on
socket close (clean or abrupt), the connection manager removes the
connection from every channel/pattern it was subscribed to. A dangling
subscription reference would be a slow memory leak and, worse, a `PUBLISH`
attempting to write to a dead socket.

## Command dispatch

A flat map from command name to handler
([`src/commands/dispatcher.ts`](../src/commands/dispatcher.ts)). Each
handler validates its own arguments and returns pre-built RESP reply
frames, so error formatting (`WRONGTYPE`, `ERR wrong number of arguments`,
etc.) stays centralized. Two gates apply before a handler runs:

- **Auth gating**: when `REDIS_AUTH_PASSWORD` is set, only `AUTH`, `HELLO`,
  `PING`, `CLIENT`, and `QUIT` are allowed before a successful `AUTH`.
- **Subscriber-mode gating**: once a connection has issued `SUBSCRIBE` or
  `PSUBSCRIBE`, only pub/sub-management commands and `PING`/`QUIT` are
  accepted, matching real Redis's subscriber-connection restriction.

A command outside the supported set returns `ERR unknown command` rather
than silently no-opping — see [Command reference](./command-reference.md)
for why that matters.

After a mutating command succeeds, the dispatcher hands the resulting key
state to the `ClusterCoordinator` for cross-node replication — see
[High availability](./high-availability.md#2-replication). This is
centralized in the dispatcher rather than in each command handler
specifically so the handlers above stay unaware that HA exists at all;
the in-memory mutation they perform is identical whether the process is
running standalone or as one of several nodes.

## Graceful shutdown

On `SIGTERM` (which Container Apps sends on scale-down/redeploy), the
process stops accepting new connections, lets in-flight commands finish
(command handling itself is synchronous, so there's nothing to drain
there), then closes idle connections, drains any in-flight cluster
replication work (bounded by a timeout), and deregisters its Service Bus
subscription and node-heartbeat document before exiting. This mirrors the
shutdown discipline a well-behaved Redis-compatible server is expected to
have, extended to not lose the last few writes on a controlled redeploy —
see [High availability](./high-availability.md).
