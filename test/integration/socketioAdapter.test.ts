import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';

/**
 * Cross-replica Socket.IO fan-out (§4): a client connected to "replica A"
 * needs to see events emitted from "replica B". @socket.io/redis-adapter
 * does this by opening a dedicated PUBLISH client and a dedicated
 * SUBSCRIBE-only client per Socket.IO server instance. This test runs two
 * independent Socket.IO HTTP servers, each with its own adapter pair, both
 * pointed at the same ZateDB instance, and confirms a broadcast from
 * one is received by a client connected only to the other — the actual
 * production topology this exists to support.
 */
describe('@socket.io/redis-adapter cross-replica fan-out against ZateDB', () => {
  let zateDb: TestServer;
  let httpServerA: HttpServer;
  let httpServerB: HttpServer;
  let ioA: SocketIOServer;
  let ioB: SocketIOServer;
  let clientA: ClientSocket;
  let clientB: ClientSocket;
  const redisClients: Array<ReturnType<typeof createClient>> = [];
  // Any 'error' event on an adapter's pub/sub client means the client and
  // server disagreed about the wire protocol (see test/integration/resp3.test.ts)
  // — a client that logs an error per frame and keeps limping must fail
  // this suite, not just have delivery checked. Collected across every
  // pub/sub client pair created for this describe block.
  const clientErrors: unknown[] = [];

  async function makeAdapterPair() {
    const pub = createClient({ url: zateDb.url });
    const sub = pub.duplicate();
    pub.on('error', (e) => clientErrors.push(e));
    sub.on('error', (e) => clientErrors.push(e));
    await Promise.all([pub.connect(), sub.connect()]);
    redisClients.push(pub, sub);
    // @socket.io/redis-adapter bundles its own nested `redis`/`@redis/client`
    // type versions, which TS sees as structurally distinct from this
    // project's top-level `redis` types (same version-skew shape as the
    // OpenTelemetry exporter cast in src/telemetry/otel.ts). Both are
    // node-redis v5 clients at runtime, so this cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createAdapter(pub as any, sub as any);
  }

  beforeAll(async () => {
    zateDb = await startTestServer();

    httpServerA = createServer();
    httpServerB = createServer();
    ioA = new SocketIOServer(httpServerA, { adapter: await makeAdapterPair() });
    ioB = new SocketIOServer(httpServerB, { adapter: await makeAdapterPair() });

    await Promise.all([
      new Promise<void>((resolve) => httpServerA.listen(0, resolve)),
      new Promise<void>((resolve) => httpServerB.listen(0, resolve)),
    ]);

    const portA = (httpServerA.address() as AddressInfo).port;
    const portB = (httpServerB.address() as AddressInfo).port;

    clientA = ioClient(`http://127.0.0.1:${portA}`, { transports: ['websocket'] });
    clientB = ioClient(`http://127.0.0.1:${portB}`, { transports: ['websocket'] });

    await Promise.all([
      new Promise<void>((resolve) => clientA.on('connect', () => resolve())),
      new Promise<void>((resolve) => clientB.on('connect', () => resolve())),
    ]);
  });

  afterAll(async () => {
    clientA.disconnect();
    clientB.disconnect();
    ioA.close();
    ioB.close();
    await Promise.all(redisClients.map((c) => c.quit()));
    await zateDb.stop();
  });

  it('a broadcast emitted on replica A reaches a client connected only to replica B', async () => {
    const received = new Promise<[string, number]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cross-replica event did not arrive within timeout')), 3000);
      clientB.once('cross-replica-event', (payload: string, count: number) => {
        clearTimeout(timer);
        resolve([payload, count]);
      });
    });

    // ioA has no direct connection to clientB; only the shared ZateDB
    // pub/sub channel can carry this broadcast to replica B's socket.
    ioA.emit('cross-replica-event', 'hello-from-a', 42);

    await expect(received).resolves.toEqual(['hello-from-a', 42]);
  });

  it('a room broadcast on replica B reaches a client connected only to replica A', async () => {
    await new Promise<void>((resolve) => {
      ioA.on('connection', () => {}); // no-op, just ensure listener registration doesn't throw
      resolve();
    });

    // clientA's underlying socket joins a room via replica A's server-side socket object.
    const serverSideSocketA = await new Promise<import('socket.io').Socket>((resolve) => {
      ioA.once('connection', resolve);
      if (ioA.sockets.sockets.size > 0) {
        resolve(Array.from(ioA.sockets.sockets.values())[0]);
      }
    });
    await serverSideSocketA.join('room:cross');

    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('room broadcast did not arrive within timeout')), 3000);
      clientA.once('room-event', (payload: string) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    // Broadcast to the room from replica B — only reachable via the shared adapter.
    ioB.to('room:cross').emit('room-event', 'hello-room');

    await expect(received).resolves.toBe('hello-room');
  });

  it('neither adapter pub/sub client emitted a protocol error across the whole run', () => {
    expect(clientErrors).toEqual([]);
  });
});
