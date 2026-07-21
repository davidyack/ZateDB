import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { createClient } from 'redis-v6';
import { createAdapter } from '@socket.io/redis-adapter';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';

/**
 * The exact bug this branch fixes: @socket.io/redis-adapter built on
 * node-redis v6 (RESP3 by default — it sends HELLO 3 on every connect,
 * with no fallback) against a ZateDB that only ever spoke RESP2 on the
 * wire regardless of what HELLO negotiated. The client's RESP3 decoder and
 * the server's RESP2 encoder disagreed on every pub/sub frame, flooding
 * the pub/sub client with protocol errors even though PUBLISH/SUBSCRIBE
 * "worked". This test is the v5-based cross-replica fan-out test in
 * socketioAdapter.test.ts, but built on a v6 client so it actually
 * exercises the RESP3 handshake path a v5 client (which defaults to RESP2)
 * never touches.
 */
describe('@socket.io/redis-adapter on a node-redis v6 (RESP3) client against ZateDB', () => {
  let zateDb: TestServer;
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redisClients: Array<{ quit(): Promise<any>; sendCommand(args: string[]): Promise<any> }> = [];
  const clientErrors: unknown[] = [];

  beforeAll(async () => {
    zateDb = await startTestServer();

    const pub = createClient({ url: zateDb.url });
    const sub = pub.duplicate();
    pub.on('error', (e) => clientErrors.push(e));
    sub.on('error', (e) => clientErrors.push(e));
    await Promise.all([pub.connect(), sub.connect()]);
    redisClients.push(pub, sub);

    httpServer = createServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    io = new SocketIOServer(httpServer, { adapter: createAdapter(pub as any, sub as any) });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const port = (httpServer.address() as AddressInfo).port;
    client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
  });

  afterAll(async () => {
    client.disconnect();
    io.close();
    await Promise.all(redisClients.map((c) => c.quit()));
    await zateDb.stop();
  });

  it('a broadcast reaches the client via the RESP3 adapter', async () => {
    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('broadcast did not arrive within timeout')), 3000);
      client.once('resp3-event', (payload: string) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    io.emit('resp3-event', 'hello-via-resp3');

    await expect(received).resolves.toBe('hello-via-resp3');
  });

  it('PUBSUB NUMSUB works so io.serverSideEmit()-with-ack style calls do not fail', async () => {
    // @socket.io/redis-adapter's serverCount() calls PUBSUB NUMSUB under the
    // hood (io.fetchSockets()/io.sockets()/allRooms()/broadcastWithAck()).
    const count = await redisClients[0].sendCommand(['PUBSUB', 'NUMSUB']);
    expect(count).toEqual([]);
  });

  it('neither pub/sub client emitted a protocol error', () => {
    expect(clientErrors).toEqual([]);
  });
});
