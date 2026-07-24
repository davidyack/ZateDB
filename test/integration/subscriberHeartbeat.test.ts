import { afterEach, describe, expect, it } from 'vitest';
import { connect, Socket } from 'node:net';
import { createClient as createClientV5 } from 'redis';
import { createClient as createClientV6 } from 'redis-v6';
import { startTestServer, type TestServer } from '../helpers/startServer.js';

/** Opens a raw TCP socket and resolves once connected. */
function rawConnect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * TCP keepalive (see tcpKeepAlive.test.ts) only helps against a stateful
 * NAT/hardware LB honoring kernel-level keepalive ACKs. A managed ingress
 * proxy in front of ZateDB (e.g. Azure Container Apps' envoy) resets its own
 * idle timeout on application-layer bytes only, so an idle subscriber
 * connection behind one is still silently reaped even with keepalive on.
 * subscriberHeartbeatIntervalMs pushes real bytes down an idle subscriber
 * connection to keep such a proxy's timer from expiring.
 */
describe('subscriber heartbeat', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    await server?.stop();
  });

  it('sends an unsolicited heartbeat frame on an idle subscriber-mode connection at the configured interval', async () => {
    server = await startTestServer({ subscriberHeartbeatIntervalMs: 20 });
    const socket = await rawConnect(server.port);
    sockets.push(socket);

    const frames: string[] = [];
    socket.on('data', (d) => frames.push(d.toString('utf8')));
    socket.write('*2\r\n$9\r\nSUBSCRIBE\r\n$2\r\nch\r\n');

    await new Promise((resolve) => setTimeout(resolve, 100));

    // First frame is the SUBSCRIBE confirmation; everything after is
    // heartbeats, since nothing was ever published on "ch".
    const all = frames.join('');
    const heartbeatCount = (all.match(/__zatedb_heartbeat__/g) ?? []).length;
    expect(heartbeatCount).toBeGreaterThan(0);
  });

  it('does not heartbeat a non-subscriber connection', async () => {
    server = await startTestServer({ subscriberHeartbeatIntervalMs: 20 });
    const socket = await rawConnect(server.port);
    sockets.push(socket);

    const frames: string[] = [];
    socket.on('data', (d) => frames.push(d.toString('utf8')));

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(frames.join('')).toBe('');
  });

  it('is a no-op when subscriberHeartbeatIntervalMs is 0 (opt-out)', async () => {
    server = await startTestServer({ subscriberHeartbeatIntervalMs: 0 });
    const socket = await rawConnect(server.port);
    sockets.push(socket);

    const frames: string[] = [];
    socket.on('data', (d) => frames.push(d.toString('utf8')));
    socket.write('*2\r\n$9\r\nSUBSCRIBE\r\n$2\r\nch\r\n');

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(frames.join('')).not.toMatch(/__zatedb_heartbeat__/);
  });

  it('a RESP2 (node-redis v5) subscriber tolerates the unsolicited heartbeat with zero client errors', async () => {
    server = await startTestServer({ subscriberHeartbeatIntervalMs: 20 });
    const errors: unknown[] = [];
    const sub = createClientV5({ url: server.url });
    sub.on('error', (e) => errors.push(e));
    await sub.connect();

    try {
      await sub.subscribe('ch', () => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errors).toEqual([]);
    } finally {
      await sub.disconnect();
    }
  });

  it('a RESP3 (node-redis v6) subscriber tolerates the unsolicited heartbeat with zero client errors', async () => {
    server = await startTestServer({ subscriberHeartbeatIntervalMs: 20 });
    const errors: unknown[] = [];
    const sub = createClientV6({ url: server.url });
    sub.on('error', (e) => errors.push(e));
    await sub.connect();

    try {
      await sub.subscribe('ch', () => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errors).toEqual([]);
    } finally {
      await sub.disconnect();
    }
  });
});
