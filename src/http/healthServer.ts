import { createServer, type Server } from 'node:http';
import type { RespServer } from '../server/respServer.js';
import { logger } from '../logger.js';

const startedAtMs = Date.now();

export class HealthServer {
  private server: Server;

  constructor(private readonly respServer: RespServer) {
    this.server = createServer((req, res) => {
      if (req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        const body = JSON.stringify({
          status: 'ok',
          uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
          connections: this.respServer.activeConnectionCount(),
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(req.method === 'GET' ? body : undefined);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, () => {
        this.server.removeListener('error', reject);
        logger.info('health.listening', { port });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
