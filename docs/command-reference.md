# Command reference

Every command below is implemented in
[`src/commands/dispatcher.ts`](../src/commands/dispatcher.ts) and covered
by integration tests against the real client libraries that use it — see
[Testing](./testing.md).

| Command | Notes |
|---|---|
| `PING` | Allowed pre-auth and in subscriber mode. |
| `HELLO` | Acknowledged; the connection stays on RESP2 regardless of the requested protover. |
| `AUTH` | Required before other commands when `REDIS_AUTH_PASSWORD` is set. |
| `CLIENT SETINFO` / `GETNAME` / `SETNAME` / `ID` | No-ops beyond bookkeeping — must never error, since node-redis sends `SETINFO` on every connect and treats an error there as a connection failure. |
| `QUIT` | Replies `OK`, then closes the socket. |
| `GET` | Returns a nil bulk string for a missing key. |
| `SET` | Supports `EX seconds` and `PX ms`. A non-positive or non-integer expiry is rejected (matching real Redis), not silently coerced. |
| `DEL` | Multi-key; returns the count actually removed. |
| `INCR` | Creates the key at `0` first, then increments. Errors if the existing value isn't a base-10 integer. |
| `EXPIRE` / `PEXPIRE` | Support `NX`/`XX`/`GT`/`LT` flags. |
| `HSET` | Multi field/value pairs; returns the count of *new* fields added. |
| `HDEL` | Multi-field; deletes the key entirely once its last field is removed. |
| `HGETALL` | Returns an empty array (not an error) for a missing key. |
| `ZADD` | Multi score/member pairs; returns the count of *new* members added (an existing member's score is updated, not counted as new). |
| `ZREMRANGEBYSCORE` | Full range-bound syntax — see below. |
| `ZCOUNT` | Full range-bound syntax — see below. |
| `PUBLISH` | Returns the number of subscribers reached (exact-channel + matching-pattern). |
| `SUBSCRIBE` / `PSUBSCRIBE` | Switch the connection into subscriber mode. `PSUBSCRIBE` uses Redis glob syntax (`*`, `?`, `[...]`). |
| `UNSUBSCRIBE` / `PUNSUBSCRIBE` | With no arguments, unsubscribes from everything the connection currently holds (needed for a clean adapter shutdown). |

Anything not in this table returns `ERR unknown command` rather than
silently no-opping, so a caller using an unsupported command is caught
immediately in integration tests instead of failing silently in
production. The [command coverage audit](./testing.md#command-coverage-audit)
script exists specifically to catch this before it ships.

## Sorted-set range-bound syntax

`ZCOUNT` and `ZREMRANGEBYSCORE` both take a `min max` pair using Redis's
range syntax (see [`src/store/scoreRange.ts`](../src/store/scoreRange.ts)):

- A bare number, e.g. `5`, is **inclusive**.
- A `(`-prefixed number, e.g. `(5`, is **exclusive**.
- `-inf` / `+inf` are unbounded.

This is not simplified to numeric-only parsing, because a sliding-window
rate/cooldown check typically sends the exclusive/unbounded form, e.g.
`ZCOUNT key "(1700000000000" "+inf"` to count events in the last N
milliseconds.

## Non-goals

| Excluded | Why |
|---|---|
| `EVAL` / `EVALSHA` / `SCRIPT LOAD` (Lua scripting) | No embedded Lua runtime — and none is needed for cross-node atomicity either: HA replication and Cosmos DB persistence are both plain upserts/deletes, no stored procedures. `rate-limit-redis`'s default store needs Lua — see [The rate-limit store deviation](./rate-limit-store.md) for the one place a consuming app needs a small workaround. |
| Redis-native persistence (RDB snapshots, AOF) | Durability is handled differently here — key state is persisted to Cosmos DB as part of cross-node replication (see [High availability](./high-availability.md)), not via Redis's own snapshot/append-only-file formats. `PUBLISH` messages are still never persisted anywhere, matching real Redis pub/sub's fire-and-forget semantics. |
| Redis-native clustering/sharding (`CLUSTER *`, hash slots) | BackendCache's own multi-node HA (see [High availability](./high-availability.md)) is a from-scratch active-active design over Service Bus + Cosmos DB, not an implementation of Redis Cluster's protocol — no consuming app in scope talks `CLUSTER *`. |
| RESP3, ACLs, other data types (lists, sets, streams, geo, bitmaps, HyperLogLog) | Add on demand when a real caller needs them; don't build speculatively. |
| TLS termination in-process | Assumes a private, same-environment network hop (e.g. Container Apps internal ingress). Terminate TLS upstream if your network policy requires it in transit. |

If a future need grows past this list, prefer a real Redis-compatible
engine (Valkey, Dragonfly) over expanding BackendCache into a
general-purpose cache reimplementation.
