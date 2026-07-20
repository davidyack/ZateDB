import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';

/**
 * The payoff of Lua/EVAL support: rate-limit-redis's DEFAULT store — the one
 * that failed on the diagnostics page with `ERR unknown command 'SCRIPT'` —
 * now works against BackendCache with no workaround store. This wires the
 * unmodified `RedisStore` (which does SCRIPT LOAD + EVALSHA under the hood)
 * into a real express-rate-limit middleware over a real node-redis client and
 * a real BackendCache instance, and confirms limiting works end to end.
 */
describe('rate-limit-redis DEFAULT (Lua/EVALSHA) store against BackendCache', () => {
  let server: TestServer;
  let client: RedisClientType;
  let app: Express;
  let baseUrl: string;
  let httpServer: import('node:http').Server;

  beforeAll(async () => {
    server = await startTestServer();
    client = createClient({ url: server.url });
    await client.connect();

    app = express();
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 3,
        standardHeaders: true,
        legacyHeaders: false,
        store: new RedisStore({
          prefix: 'default-rl:',
          // node-redis v5: forward the raw RESP args the store builds
          // (SCRIPT LOAD / EVALSHA / GET / DEL) straight to the server.
          sendCommand: (...args: string[]) => client.sendCommand(args) as Promise<never>,
        }),
      }),
    );
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await client.quit();
    await server.stop();
  });

  it('SCRIPT LOAD returns a usable SHA and EVALSHA runs the loaded script', async () => {
    const body = "return redis.call('INCR', KEYS[1])";
    const sha = (await client.sendCommand(['SCRIPT', 'LOAD', body])) as string;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await client.sendCommand(['EVALSHA', sha, '1', 'evalsha-counter'])).toBe(1);
    expect(await client.sendCommand(['EVALSHA', sha, '1', 'evalsha-counter'])).toBe(2);
  });

  it('allows requests under the limit and blocks once exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/ping`);
      expect(res.status).toBe(200);
    }
    const blocked = await fetch(`${baseUrl}/ping`);
    expect(blocked.status).toBe(429);
  });

  it('the limiter counter lands in BackendCache under its prefix', async () => {
    const { keys } = server.store.listKeys('default-rl:', 100, 0);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0].type).toBe('string');
  });
});
