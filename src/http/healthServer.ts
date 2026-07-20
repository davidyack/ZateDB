import { createServer, type Server } from 'node:http';
import type { RespServer } from '../server/respServer.js';
import type { ClusterCoordinator } from '../cluster/clusterCoordinator.js';
import type { ServerConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import { getActiveConnectionCount, getCommandsProcessedTotal } from '../telemetry/commandTelemetry.js';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '../telemetry/prometheus.js';
import { SERVER_VERSION } from '../version.js';
import { logger } from '../logger.js';

const startedAtMs = Date.now();

export class HealthServer {
  private server: Server;
  private ready = true;

  constructor(
    private readonly respServer: RespServer,
    private readonly config: ServerConfig,
    private readonly cluster: ClusterCoordinator,
    private readonly store: Store,
    private readonly pubsub: PubSubRegistry,
  ) {
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
      if (req.url === '/readyz' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Readiness: not ready during graceful shutdown (the same signal
        // /healthz uses), and in HA mode, also not ready until this node has
        // finished hydrating its in-memory copy from the durable store —
        // routing client traffic to it before then would serve a cold cache
        // (missing counters/presence/sliding-window state another node
        // already holds).
        const ready = this.ready && this.cluster.isHydrated;
        const body = JSON.stringify({ ready, haEnabled: this.cluster.haEnabled, nodeId: this.cluster.nodeId });
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(req.method === 'GET' ? body : undefined);
        return;
      }
      if (req.url === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Prometheus pull endpoint, deliberately unauthenticated (like the
        // health probes) and cheap: every number here is an already-tracked
        // O(1) aggregate — no keyspace walk — and no key names or values are
        // ever exposed, only counts.
        const keyCounts = this.store.keyCounts();
        const pubsubStats = this.pubsub.stats();
        const body = renderPrometheus({
          uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
          connectedClients: getActiveConnectionCount(),
          commandsProcessed: getCommandsProcessedTotal(),
          keyCounts,
          memoryBytes: this.store.memoryBytesEstimate(),
          pubsub: pubsubStats,
          haEnabled: this.cluster.haEnabled,
          hydrated: this.cluster.isHydrated,
          version: SERVER_VERSION,
          nodeId: this.cluster.nodeId,
        });
        res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE, 'content-length': Buffer.byteLength(body) });
        res.end(req.method === 'GET' ? body : undefined);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  }

  /** Flip readiness to false so /healthz and /readyz both return 503 while draining. */
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
