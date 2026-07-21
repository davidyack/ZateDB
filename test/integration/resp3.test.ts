import { afterEach, describe, expect, it } from 'vitest';
import { createClient as createClientV5 } from 'redis';
// node-redis v6 defaults to RESP3 (HELLO 3 on every connect) where v5
// defaults to RESP2. Installed under an aliased package name (`redis-v6`)
// purely for this regression test, so it never collides with the pinned v5
// client the rest of the app/tests use.
import { createClient as createClientV6 } from 'redis-v6';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';

/**
 * Regression coverage for the RESP3 negotiation bug: a RESP3 client (any
 * node-redis v6+ consumer, or a v5 client with `RESP: 3` explicitly set)
 * sends HELLO 3 and then decodes every reply as RESP3. Before per-connection
 * protocol tracking, ZateDB acknowledged HELLO 3 but kept emitting RESP2 on
 * the wire — the client's decoder and the server's encoder disagreed, which
 * showed up as a steady stream of client-side protocol errors (pub/sub
 * arrays misread as command replies) even though individual commands
 * "worked". A client that logs an error per frame and keeps limping must
 * fail this suite, not just get skipped — hence the explicit
 * zero-client-errors assertions below, not just delivery checks.
 */
describe('RESP3 protocol negotiation', () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('a node-redis v6 client (RESP3 by default) round-trips commands and pub/sub with zero client errors', async () => {
    server = await startTestServer();
    const errors: unknown[] = [];
    const pub = createClientV6({ url: server.url });
    const sub = pub.duplicate();
    pub.on('error', (e) => errors.push(e));
    sub.on('error', (e) => errors.push(e));
    await Promise.all([pub.connect(), sub.connect()]);

    try {
      await pub.set('k', 'v');
      expect(await pub.get('k')).toBe('v');

      await pub.hSet('h', { f1: 'v1', f2: 'v2' });
      expect(await pub.hGetAll('h')).toEqual({ f1: 'v1', f2: 'v2' });

      let resolveMessage!: (message: string) => void;
      const received = new Promise<string>((resolve, reject) => {
        resolveMessage = resolve;
        setTimeout(() => reject(new Error('message not received')), 2000);
      });
      await sub.subscribe('chan', (message) => resolveMessage(message));
      await pub.publish('chan', 'hello-resp3');
      await expect(received).resolves.toBe('hello-resp3');
    } finally {
      await Promise.all([pub.quit(), sub.quit()]);
    }

    expect(errors).toEqual([]);
  });

  it('a node-redis v5 client with RESP:3 explicitly requested behaves identically to v6 default', async () => {
    server = await startTestServer();
    const errors: unknown[] = [];
    const client = createClientV5({ url: server.url, RESP: 3 });
    client.on('error', (e) => errors.push(e));
    await client.connect();

    try {
      await client.set('k', 'v3');
      expect(await client.get('k')).toBe('v3');
      await client.hSet('h', { f: 'v' });
      expect(await client.hGetAll('h')).toEqual({ f: 'v' });
    } finally {
      await client.quit();
    }

    expect(errors).toEqual([]);
  });

  it('a plain RESP2 client (no HELLO 3) is unaffected by RESP3 support — the "keep RESP2" requirement', async () => {
    server = await startTestServer();
    const errors: unknown[] = [];
    const client = createClientV5({ url: server.url }); // v5 defaults to RESP2
    client.on('error', (e) => errors.push(e));
    await client.connect();

    try {
      await client.set('k', 'v2');
      expect(await client.get('k')).toBe('v2');
      await client.hSet('h', { f: 'v' });
      expect(await client.hGetAll('h')).toEqual({ f: 'v' });
    } finally {
      await client.quit();
    }

    expect(errors).toEqual([]);
  });
});
