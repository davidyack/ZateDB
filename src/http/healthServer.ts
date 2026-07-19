import { createServer, type Server } from 'node:http';
import type { RespServer } from '../server/respServer.js';
import type { ServerConfig } from '../config.js';
import { logger } from '../logger.js';

const startedAtMs = Date.now();

export class HealthServer {
  private server: Server;
  private ready = true;

  constructor(private readonly respServer: RespServer, private readonly config: ServerConfig) {
    this.server = createServer((req, res) => {
      if (req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Readiness must flip to false the moment shutdown begins — before the
        // RESP listener actually closes — so the orchestrator stops routing new
        // connections here instead of hitting a socket that's about to vanish.
        const status = this.ready ? 200 : 503;
        const body = JSON.stringify({
          status: this.ready ? 'ok' : 'shutting_down',
          uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
          connections: this.respServer.activeConnectionCount(),
          // Surface fail-open auth config so a misconfiguration (no password /
          // no admin token) is visible on a plain health check, not silent.
          authRequired: Boolean(this.config.authPassword),
          adminAuthRequired: Boolean(this.config.adminToken),
        });
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(req.method === 'GET' ? body : undefined);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  }

  /** Flip readiness to false so /healthz returns 503 while draining. */
  setNotReady(): void {
    this.ready = false;
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
