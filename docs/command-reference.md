# Command reference

Every command below is implemented in
[`src/commands/dispatcher.ts`](../src/commands/dispatcher.ts) and covered
by integration tests against the real client libraries that use it — see
[Testing](./testing.md).

| Command | Notes |
|---|---|
| `PING` | Allowed pre-auth and in subscriber mode. |
| `INFO` | Redis-style server information as a bulk string of `# Section` blocks with `key:value` lines. Sections: `Server`, `Clients`, `Memory`, `Stats`, `Replication`, `Cluster`, `Keyspace`. `INFO <section>` returns just that section (empty string for an unknown one). Numbers come from the same O(1) store counters and command/connection totals the admin API and telemetry read, so it never walks the keyspace. |
| `HELLO` | Acknowledged; the connection stays on RESP2 regardless of the requested protover. |
| `AUTH` | Required before other commands when `REDIS_AUTH_PASSWORD` is set. |
| `CLIENT SETINFO` / `GETNAME` / `SETNAME` / `ID` | No-ops beyond bookkeeping — must never error, since node-redis sends `SETINFO` on every connect and treats an error there as a connection failure. |
| `QUIT` | Replies `OK`, then closes the socket. |
| `GET` | Returns a nil bulk string for a missing key. |
| `SET` | Supports `EX seconds`, `PX ms`, `KEEPTTL`, `NX`, `XX`, and `GET`. A non-positive or non-integer expiry is rejected (matching real Redis), not silently coerced. `SET key val NX PX ms` is the distributed-lock primitive; a skipped `NX`/`XX` write replies nil, and `GET` always replies the prior value. `NX`+`XX` or `KEEPTTL`+`EX`/`PX` together are a syntax error. Any other option (e.g. `EXAT`/`PXAT`) returns `ERR unsupported option` rather than being silently accepted — a silently dropped option would hand a lock/idempotency caller the wrong semantics. |
| `MGET` | Multi-key; a nil entry for each missing or non-string key (never errors on type). |
| `MSET` | Multi key/value pairs; always `OK`. Each write clears any prior TTL. |
| `DEL` | Multi-key; returns the count actually removed. |
| `EXISTS` | Multi-key; returns how many of the given keys exist, counting duplicates. |
| `INCR` | Creates the key at `0` first, then increments. Errors if the existing value isn't a base-10 integer. |
| `EXPIRE` / `PEXPIRE` | Support `NX`/`XX`/`GT`/`LT` flags. The time argument must be an integer; a fractional value is rejected with `ERR value is not an integer or out of range`. |
| `TTL` / `PTTL` | Remaining lifetime in seconds / milliseconds. `-2` if the key is missing, `-1` if it exists without a TTL. |
| `SCAN` | `SCAN cursor [MATCH pattern] [COUNT n] [TYPE type]`. `MATCH` uses Redis glob syntax; `COUNT` is accepted as a hint; `TYPE` filters by `string`/`hash`/`sortedset`. A full iteration completes in one page (cursor returns to `0`) — see below. |
| `HSET` | Multi field/value pairs; returns the count of *new* fields added. |
| `HDEL` | Multi-field; deletes the key entirely once its last field is removed. |
| `HGETALL` | Returns an empty array (not an error) for a missing key. |
| `ZADD` | Multi score/member pairs; returns the count of *new* members added (an existing member's score is updated, not counted as new). |
| `ZREMRANGEBYSCORE` | Full range-bound syntax — see below. |
| `ZCOUNT` | Full range-bound syntax — see below. |
| `PUBLISH` | Returns the number of subscribers reached (exact-channel + matching-pattern). |
| `SUBSCRIBE` / `PSUBSCRIBE` | Switch the connection into subscriber mode. `PSUBSCRIBE` uses Redis glob syntax (`*`, `?`, `[...]`). |
| `UNSUBSCRIBE` / `PUNSUBSCRIBE` | With no arguments, unsubscribes from everything the connection currently holds (needed for a clean adapter shutdown). |
| `EVAL` / `EVALSHA` | Run a Lua script on an embedded Lua 5.3 VM. `KEYS`/`ARGV` are 1-indexed; `redis.call`/`redis.pcall` dispatch back through the command layer — see below. |
| `SCRIPT LOAD` / `EXISTS` / `FLUSH` | Manage the process-wide SHA1 script cache. `LOAD` returns the digest; `EXISTS` reports per-SHA presence; `FLUSH` clears it. |

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

## SCAN iteration

`SCAN` returns every matching key in a single page and a terminating cursor
of `0`, so a caller's `while (cursor !== '0')` loop finishes after one round
trip. Redis treats `COUNT` as a hint and permits a full iteration to complete
in one step, so this is spec-compliant. Returning everything at once also
avoids the skip-on-delete hazard an offset-based cursor has when a caller
deletes keys mid-scan — the exact pattern `connect-redis`'s `clear()` and
similar session/cache stores use. `MATCH` applies Redis glob syntax (shared
with `PSUBSCRIBE`) and `TYPE` filters to `string`, `hash`, or `sortedset`.

This makes BackendCache a drop-in for the mainstream lock and
session/cache-store ecosystem (`SET … NX PX` locks, `connect-redis`,
`cache-manager`, `keyv`) on top of the original rate-limit / pub-sub surface.

## Lua scripting

`EVAL`/`EVALSHA` run on an embedded [fengari](https://fengari.io/) Lua 5.3
VM (see [`src/scripting/luaEngine.ts`](../src/scripting/luaEngine.ts)):

- `KEYS` and `ARGV` are exposed as 1-indexed global tables.
- `redis.call(cmd, ...)` and `redis.pcall(cmd, ...)` dispatch back through the
  same command layer a client uses — so a mutation performed inside a script
  replicates across nodes exactly like the same command sent directly
  (Redis's "effects replication"). `redis.call` raises a command error and
  aborts the script; `redis.pcall` returns it as an `{err=...}` table.
- Lua↔RESP conversion follows Redis: number→integer (truncated), string→bulk,
  `false`→nil, `true`→`:1`, table→array (stopping at the first nil),
  `{ok=...}`→status, `{err=...}`→error. `redis.error_reply`,
  `redis.status_reply`, and `redis.sha1hex` are provided.
- A fresh sandboxed state is created per invocation with only the
  deterministic libraries (`base`, `table`, `string`, `math`) — no `io`,
  `os`, `package`, or `debug`. Connection/pubsub/scripting commands
  (`SUBSCRIBE`, `EVAL`, `AUTH`, …) are rejected from inside a script.

This means `rate-limit-redis`'s **default** (Lua) store works against
BackendCache directly — the [rate-limit store deviation](./rate-limit-store.md)
is now optional, not required.

## Non-goals

| Excluded | Why |
|---|---|
| Redis-native persistence (RDB snapshots, AOF) | Durability is handled differently here — key state is persisted to Cosmos DB as part of cross-node replication (see [High availability](./high-availability.md)), not via Redis's own snapshot/append-only-file formats. `PUBLISH` messages are still never persisted anywhere, matching real Redis pub/sub's fire-and-forget semantics. |
| Redis-native clustering/sharding (`CLUSTER *`, hash slots) | BackendCache's own multi-node HA (see [High availability](./high-availability.md)) is a from-scratch active-active design over Service Bus + Cosmos DB, not an implementation of Redis Cluster's protocol — no consuming app in scope talks `CLUSTER *`. |
| RESP3, ACLs, other data types (lists, sets, streams, geo, bitmaps, HyperLogLog) | Add on demand when a real caller needs them; don't build speculatively. |
| TLS termination in-process | Assumes a private, same-environment network hop (e.g. Container Apps internal ingress). Terminate TLS upstream if your network policy requires it in transit. |

If a future need grows past this list, prefer a real Redis-compatible
engine (Valkey, Dragonfly) over expanding BackendCache into a
general-purpose cache reimplementation.
