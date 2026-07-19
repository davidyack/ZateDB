import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';
import { BackendCacheRateLimitStore } from '../../examples/rateLimitStore.js';

/**
 * Proves the one deliberate deviation in the design spec (§5): since
 * BackendCache has no Lua/EVAL support, the consuming app's rate-limit
 * middleware swaps rate-limit-redis's default (EVALSHA-based) store for a
 * ~15-line INCR + EXPIRE NX store. This test wires that store into a real
 * express-rate-limit middleware, backed by a real node-redis client talking
 * to a real BackendCache instance, and confirms limiting still works.
 */
describe('rate-limit-redis replacement store (spec §5) against BackendCache', () => {
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
        store: new BackendCacheRateLimitStore(client, 60_000, 'test-rl:'),
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

  it('allows requests under the limit and blocks once the limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/ping`);
      expect(res.status).toBe(200);
    }

    const blocked = await fetch(`${baseUrl}/ping`);
    expect(blocked.status).toBe(429);
  });

  it('the counter is a real INCR-backed string key visible in BackendCache directly', async () => {
    const { keys } = server.store.listKeys('test-rl:', 100, 0);
    expect(keys).toHaveLength(1);
    expect(keys[0].type).toBe('string');
    const detail = server.store.getKeyDetail(keys[0].key);
    expect(Number(detail?.value)).toBeGreaterThanOrEqual(4); // 3 allowed + at least 1 blocked-but-still-counted request
  });
});
