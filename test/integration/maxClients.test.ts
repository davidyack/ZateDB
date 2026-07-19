import { afterEach, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { startTestServer, type TestServer } from '../helpers/startServer.js';

/** Opens a raw TCP socket and resolves once connected. */
function rawConnect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Sends a PING and resolves with the first data chunk as a string. */
function pingReply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (d) => resolve(d.toString('utf8')));
    socket.once('error', reject);
    socket.write('*1\r\n$4\r\nPING\r\n');
  });
}

describe('max clients guard', () => {
  let server: TestServer;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    await server?.stop();
  });

  it('refuses connections past the configured cap with an error reply', async () => {
    server = await startTestServer({ maxClients: 1 });

    const first = await rawConnect(server.port);
    sockets.push(first);
    expect(await pingReply(first)).toContain('PONG');

    const second = await rawConnect(server.port);
    sockets.push(second);
    const reply = await new Promise<string>((resolve) => {
      let buf = '';
      second.on('data', (d) => {
        buf += d.toString('utf8');
        resolve(buf);
      });
    });
    expect(reply).toMatch(/max number of clients reached/);
  });
});
