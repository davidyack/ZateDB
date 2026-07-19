/**
 * Reference implementation of the one deliberate deviation documented in
 * the BackendCache design spec (§5): rate-limit-redis's default RedisStore
 * sends an EVALSHA/EVAL Lua script to increment-and-check atomically.
 * BackendCache does not support Lua scripting (see the non-goals in the
 * README), so the consuming app's rate-limit middleware needs a small,
 * hand-rolled replacement for that one store.
 *
 * This file is not part of BackendCache's runtime — it's the pattern the
 * consuming app's rate-limit middleware should copy in, using the same
 * `redis` (node-redis) client and connection it already has. It's exercised
 * here via test/integration/rateLimitStore.test.ts against a real
 * BackendCache instance and a real express-rate-limit middleware, so a
 * behavioral regression in either package is caught before it reaches
 * production.
 *
 * Concurrency note: INCR + EXPIRE NX (rather than a single atomic Lua
 * script) allows a client to burst up to ~2x the limit right at a window
 * boundary. That's a property of fixed-window algorithms generally, not a
 * new hole introduced here — the race window itself is closed by the NX
 * flag (TTL is only set once, by whichever request first creates the key).
 */
import type { RedisClientType } from 'redis';
import type { Store, IncrementResponse, Options as RateLimitOptions } from 'express-rate-limit';

export class BackendCacheRateLimitStore implements Store {
  windowMs: number;
  prefix: string;

  constructor(private readonly client: RedisClientType, windowMs: number, prefix = 'rl:') {
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  init(options: RateLimitOptions): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redisKey = this.prefix + key;
    const totalHits = await this.client.incr(redisKey);
    // No-op if the key already has a TTL — only the request that created
    // the counter gets to set the window length.
    await this.client.expire(redisKey, Math.ceil(this.windowMs / 1000), 'NX');
    return { totalHits, resetTime: undefined };
  }

  async decrement(key: string): Promise<void> {
    // Not supported: BackendCache's command surface (deliberately scoped to
    // what the consuming app calls) has no DECR. Only reached when
    // skipFailedRequests/skipSuccessfulRequests are enabled, which the
    // consuming app's rate-limit middleware does not use today. If that
    // changes, extend BackendCache's command table (§7) rather than
    // reaching for a workaround here.
  }

  async resetKey(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
}
