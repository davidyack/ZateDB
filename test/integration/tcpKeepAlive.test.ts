import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, Socket } from 'node:net';
import { startTestServer, type TestServer } from '../helpers/startServer.js';

/** Opens a raw TCP socket and resolves once connected. */
function rawConnect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('TCP keepalive on accepted RESP connections', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    await server?.stop();
    vi.restoreAllMocks();
  });

  it('enables OS-level keepalive on the accepted (server-side) socket so an idle pub/sub subscriber survives a middlebox idle timeout', async () => {
    const setKeepAlive = vi.spyOn(Socket.prototype, 'setKeepAlive');

    server = await startTestServer({ tcpKeepAliveMs: 15_000 });
    const client = await rawConnect(server.port);
    sockets.push(client);

    // Give the server a tick to accept and configure the socket.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(setKeepAlive).toHaveBeenCalledWith(true, 15_000);
  });

  it('leaves keepalive untouched when tcpKeepAliveMs is 0 (opt-out)', async () => {
    const setKeepAlive = vi.spyOn(Socket.prototype, 'setKeepAlive');

    server = await startTestServer({ tcpKeepAliveMs: 0 });
    const client = await rawConnect(server.port);
    sockets.push(client);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(setKeepAlive).not.toHaveBeenCalled();
  });
});
