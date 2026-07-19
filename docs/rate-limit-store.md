# The rate-limit store deviation

This is the one place a consuming app needs a small, deliberate code
change to work with BackendCache — everywhere else, pointing `REDIS_URL`
at BackendCache is a config-only change.

## Why

`rate-limit-redis`'s default `RedisStore` sends a Lua script via
`EVALSHA`/`EVAL` to increment-and-check atomically. BackendCache has no
embedded Lua runtime (see [Non-goals](./command-reference.md#non-goals)),
so that default store doesn't work against it.

## The replacement

Not a byte-for-byte drop-in, but an isolated ~15-line store swap in one
file, using the same `redis` (node-redis) connection the app already has:

```ts
count = await client.incr(key);
await client.expire(key, windowSeconds, 'NX'); // no-op if a TTL is already set
return count;
```

A full reference implementation is in
[`examples/rateLimitStore.ts`](../examples/rateLimitStore.ts) — it
implements `express-rate-limit`'s `Store` interface directly (not
`rate-limit-redis`'s), so it's a straightforward substitution:

```ts
import { rateLimit } from 'express-rate-limit';
import { BackendCacheRateLimitStore } from './rateLimitStore';

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 100,
    store: new BackendCacheRateLimitStore(redisClient, 60_000),
  }),
);
```

It's exercised end-to-end in
[`test/integration/rateLimitStore.test.ts`](../test/integration/rateLimitStore.test.ts)
against a real `express-rate-limit` middleware and a real BackendCache
instance — including confirming the underlying counter is a real,
`INCR`-backed string key.

## Concurrency note

Fixed-window counters via `INCR` + `EXPIRE NX` allow a client to burst up
to ~2x the limit right at a window boundary — a property of fixed-window
algorithms generally, not a regression versus the Lua-script approach
(which is also fixed-window, just atomic-per-call). The race window itself
— two concurrent first-requests both trying to set the TTL — is closed by
the `NX` flag: only the request that actually creates the counter gets to
set its expiry.

## What's not supported

`decrement()` (used only when `skipFailedRequests`/`skipSuccessfulRequests`
are enabled) is a no-op in the reference implementation, since
BackendCache's command surface has no `DECR` — it wasn't a real call site
when the command table was built. If a consuming app needs it, extend
[`src/commands`](../src/commands) (and the
[command reference](./command-reference.md)) rather than working around
the gap in the store.
