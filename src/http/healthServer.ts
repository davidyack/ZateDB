import { createServer, type Server } from 'node:http';
import type { RespServer } from '../server/respServer.js';
import type { ClusterCoordinator } from '../cluster/clusterCoordinator.js';
import { logger } from '../logger.js';

const startedAtMs = Date.now();

export class HealthServer {
  private server: Server;

  constructor(private readonly respServer: RespServer, private readonly cluster: ClusterCoordinator) {
    this.server = createServer((req, res) => {
      if (req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Liveness: the process is up and accepting connections. Never
        // gated on hydration — a node mid-hydration is alive, just not
        // ready for traffic yet (see /readyz).
        const body = JSON.stringify({
          status: 'ok',
          uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
          connections: this.respServer.activeConnectionCount(),
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(req.method === 'GET' ? body : undefined);
        return;
      }
      if (req.url === '/readyz' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Readiness: in HA mode, a node isn't ready until it has finished
        // hydrating its in-memory copy from the durable store — routing
        // client traffic to it before then would serve a cold cache
        // (missing counters/presence/sliding-window state another node
        // already holds).
        const ready = this.cluster.isHydrated;
        const body = JSON.stringify({ ready, haEnabled: this.cluster.haEnabled, nodeId: this.cluster.nodeId });
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
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
