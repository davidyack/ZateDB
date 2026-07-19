import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { Connection } from './connection.js';
import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { ServerConfig } from '../config.js';
import { logger } from '../logger.js';

export class RespServer {
  private server: Server;
  private connections = new Set<Connection>();
  private accepting = true;

  constructor(private readonly store: Store, private readonly pubsub: PubSubRegistry, private readonly config: ServerConfig) {
    this.server = createServer((socket) => this.onConnect(socket));
  }

  listen(port: number = this.config.respPort): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, () => {
        this.server.removeListener('error', reject);
        logger.info('resp.listening', { port });
        resolve();
      });
    });
  }

  /** Actual bound port — useful when listen() was called with port 0 (ephemeral, e.g. in tests). */
  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  private onConnect(socket: Socket): void {
    if (!this.accepting) {
      socket.destroy();
      return;
    }
    const conn = new Connection(socket, { store: this.store, pubsub: this.pubsub, config: this.config });
    this.connections.add(conn);
    socket.on('close', () => this.connections.delete(conn));
  }

  activeConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Graceful shutdown: stop accepting new connections, let in-flight
   * commands finish naturally (they're synchronous per-command), then
   * close idle connections and the listening socket.
   */
  async shutdown(gracePeriodMs = 2000): Promise<void> {
    this.accepting = false;
    this.server.close();

    for (const conn of this.connections) conn.end();

    if (this.connections.size === 0) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const conn of this.connections) conn.destroy();
        resolve();
      }, gracePeriodMs);
      const check = setInterval(() => {
        if (this.connections.size === 0) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }
}
