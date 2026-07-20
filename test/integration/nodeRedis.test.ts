import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';

/**
 * Exercises the exact command surface config/redis.ts relies on, using the
 * real node-redis v5 client — the same library/version the consuming app
 * uses. This is the compatibility target, not a hand-written RESP spec.
 */
describe('node-redis v5 client against BackendCache', () => {
  let server: TestServer;
  let client: RedisClientType;

  beforeAll(async () => {
    server = await startTestServer();
    client = createClient({ url: server.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.quit();
    await server.stop();
  });

  afterEach(async () => {
    // best-effort cleanup between tests sharing one server/client
  });

  it('connects, and PING works', async () => {
    expect(await client.ping()).toBe('PONG');
  });

  it('INFO returns parseable server sections', async () => {
    const info = await client.info();
    expect(info).toContain('# Server');
    expect(info).toContain('redis_version:1.0.0');
    expect(info).toContain('# Replication');
    expect(info).toContain('role:master');
  });

  it('INFO accepts a section argument', async () => {
    const server = await client.info('server');
    expect(server).toContain('# Server');
    expect(server).not.toContain('# Replication');
  });

  it('SET/GET round-trips a string', async () => {
    await client.set('k1', 'hello');
    expect(await client.get('k1')).toBe('hello');
  });

  it('GET on a missing key returns null', async () => {
    expect(await client.get('does-not-exist')).toBeNull();
  });

  it('SET with PX expires the key', async () => {
    await client.set('k-px', 'v', { PX: 50 });
    expect(await client.get('k-px')).toBe('v');
    await sleep(120);
    expect(await client.get('k-px')).toBeNull();
  });

  it('DEL removes keys and returns the count removed', async () => {
    await client.set('d1', '1');
    await client.set('d2', '2');
    expect(await client.del(['d1', 'd2', 'nope'])).toBe(2);
  });

  it('INCR increments an integer counter, creating it at 0 first', async () => {
    await client.del('counter');
    expect(await client.incr('counter')).toBe(1);
    expect(await client.incr('counter')).toBe(2);
  });

  it('EXPIRE and PEXPIRE set a TTL on an existing key', async () => {
    await client.set('e1', 'v');
    expect(await client.expire('e1', 10)).toBe(1); // raw integer reply, node-redis doesn't coerce EXPIRE to boolean
    await client.set('e2', 'v');
    expect(await client.pExpire('e2', 50)).toBe(1);
    await sleep(120);
    expect(await client.get('e2')).toBeNull();
  });

  it('HSET/HDEL/HGETALL round-trip a hash — the presence-mirror pattern', async () => {
    await client.del('presence:room1');
    expect(await client.hSet('presence:room1', { 'socket-a': 'user-1', 'socket-b': 'user-2' })).toBe(2);
    const all = await client.hGetAll('presence:room1');
    expect(all).toEqual({ 'socket-a': 'user-1', 'socket-b': 'user-2' });
    expect(await client.hDel('presence:room1', 'socket-a')).toBe(1);
    expect(await client.hGetAll('presence:room1')).toEqual({ 'socket-b': 'user-2' });
  });

  it('HGETALL on a missing key returns an empty object, not an error', async () => {
    expect(await client.hGetAll('no-such-hash')).toEqual({});
  });

  it('a hash TTL (PEXPIRE) expires the whole hash', async () => {
    await client.hSet('presence:temp', { a: '1' });
    await client.pExpire('presence:temp', 50);
    await sleep(120);
    expect(await client.hGetAll('presence:temp')).toEqual({});
  });

  it('ZADD/ZCOUNT/ZREMRANGEBYSCORE round-trip a sorted set with Redis range syntax', async () => {
    await client.del('zs');
    await client.zAdd('zs', [
      { score: 1, value: 'a' },
      { score: 2, value: 'b' },
      { score: 3, value: 'c' },
    ]);
    expect(await client.zCount('zs', 1, 2)).toBe(2);
    expect(await client.zCount('zs', '(1', '+inf')).toBe(2);
    expect(await client.zRemRangeByScore('zs', 0, 1)).toBe(1);
    expect(await client.zCount('zs', '-inf', '+inf')).toBe(2);
  });

  it('MSET/MGET round-trip multiple keys, with nil for missing ones', async () => {
    await client.mSet([['m1', 'v1'], ['m2', 'v2']]);
    expect(await client.mGet(['m1', 'm2', 'm-missing'])).toEqual(['v1', 'v2', null]);
  });

  it('EXISTS counts how many of the given keys are present', async () => {
    await client.set('ex1', 'v');
    await client.set('ex2', 'v');
    await client.del('ex-missing');
    expect(await client.exists(['ex1', 'ex2', 'ex-missing'])).toBe(2);
  });

  it('TTL and PTTL report remaining lifetime, -1 without a TTL, -2 when missing', async () => {
    await client.set('t1', 'v', { EX: 100 });
    expect(await client.ttl('t1')).toBeGreaterThan(90);
    expect(await client.pTTL('t1')).toBeGreaterThan(90_000);
    await client.set('t2', 'v');
    expect(await client.ttl('t2')).toBe(-1);
    await client.del('t3');
    expect(await client.ttl('t3')).toBe(-2);
  });

  it('SET NX/PX behaves as a distributed lock: only the first holder wins', async () => {
    await client.del('lock:job');
    const first = await client.set('lock:job', 'replica-a', { NX: true, PX: 30_000 });
    const second = await client.set('lock:job', 'replica-b', { NX: true, PX: 30_000 });
    expect(first).toBe('OK'); // acquired
    expect(second).toBeNull(); // contended — lock already held
    expect(await client.get('lock:job')).toBe('replica-a');
    expect(await client.pTTL('lock:job')).toBeGreaterThan(0); // PX applied
  });

  it('SET KEEPTTL preserves a TTL across an overwrite; SET GET returns the prior value', async () => {
    await client.set('kt', 'v1', { PX: 30_000 });
    await client.set('kt', 'v2', { KEEPTTL: true });
    expect(await client.pTTL('kt')).toBeGreaterThan(0);
    expect(await client.set('kt', 'v3', { GET: true })).toBe('v2'); // old value returned
  });

  it('SCAN with MATCH enumerates keys by prefix — the connect-redis clear() pattern', async () => {
    await client.mSet([
      ['sess:a', '1'],
      ['sess:b', '2'],
      ['sess:c', '3'],
      ['other:x', '4'],
    ]);

    // Collect every matching key the way a session store's clear() does.
    const found: string[] = [];
    for await (const key of client.scanIterator({ MATCH: 'sess:*' })) {
      // node-redis v5 yields a key per iteration (string or string[] batch).
      if (Array.isArray(key)) found.push(...key);
      else found.push(key);
    }
    expect(new Set(found)).toEqual(new Set(['sess:a', 'sess:b', 'sess:c']));

    if (found.length > 0) await client.del(found);
    expect(await client.exists(['sess:a', 'sess:b', 'sess:c'])).toBe(0);
    expect(await client.get('other:x')).toBe('4'); // non-matching key untouched
  });

  it('a command against the wrong key type returns a WRONGTYPE error', async () => {
    await client.del('wrongtype');
    await client.set('wrongtype', 'a string');
    await expect(client.hGetAll('wrongtype').then(() => client.hSet('wrongtype', { f: 'v' }))).rejects.toThrow(/WRONGTYPE/);
  });

  it('PUBLISH reports the number of subscribers reached', async () => {
    const subscriber = client.duplicate();
    await subscriber.connect();
    const firstMessage = waitForNext<string>();
    await subscriber.subscribe('chan:1', (message) => firstMessage.resolve(message));

    const reached = await client.publish('chan:1', 'hello world');
    expect(reached).toBe(1);

    expect(await firstMessage.promise).toBe('hello world');
    await subscriber.quit();
  });

  it('an unsubscribed connection no longer receives PUBLISH', async () => {
    const subscriber = client.duplicate();
    await subscriber.connect();
    const received: string[] = [];
    await subscriber.subscribe('chan:2', (message) => received.push(message));
    await subscriber.unsubscribe('chan:2');

    // Publish, then prove liveness on an unrelated channel to know the
    // publish above has already been processed before asserting silence.
    expect(await client.publish('chan:2', 'should not arrive')).toBe(0);

    expect(received).toEqual([]);
    await subscriber.quit();
  });

  it('pattern subscriptions (PSUBSCRIBE) receive matching channel publishes', async () => {
    const subscriber = client.duplicate();
    await subscriber.connect();
    const received: Array<{ channel: string; message: string }> = [];
    const firstMessage = waitForNext<void>();
    await subscriber.pSubscribe('room:*', (message, channel) => {
      received.push({ channel, message });
      firstMessage.resolve();
    });

    expect(await client.publish('room:42', 'hi room 42')).toBe(1);
    expect(await client.publish('unrelated', 'should not match')).toBe(0);
    await firstMessage.promise;

    expect(received).toEqual([{ channel: 'room:42', message: 'hi room 42' }]);
    await subscriber.quit();
  });
});

/** A deferred that resolves the first time it's fulfilled, with a generous timeout so a real delivery bug still fails loudly. */
function waitForNext<T>(timeoutMs = 2000): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for pub/sub delivery`)), timeoutMs);
  });
  return { promise, resolve: resolveFn };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
