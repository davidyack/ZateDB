import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { RespServer } from '../server/respServer.js';
import type { ServerConfig } from '../config.js';
import { getCommandsProcessedTotal, recordAdminAction } from '../telemetry/commandTelemetry.js';
import { logger } from '../logger.js';

const startedAtMs = Date.now();

/**
 * Token-gated JSON admin API on its own port (separate from RESP and
 * /healthz). Every action is logged and emitted as a metric — DELETE in
 * particular mutates state a real client depends on, so it's treated as
 * auditable, not a silent debug tool.
 */
export class AdminServer {
  private server: Server;

  constructor(
    private readonly store: Store,
    private readonly pubsub: PubSubRegistry,
    private readonly respServer: RespServer,
    private readonly config: ServerConfig,
  ) {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, () => {
        this.server.removeListener('error', reject);
        logger.info('admin.listening', { port });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://internal');

    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      if (url.pathname === '/admin/stats' && req.method === 'GET') {
        this.handleStats(res);
        return;
      }
      if (url.pathname === '/admin/pubsub' && req.method === 'GET') {
        this.handlePubsub(res);
        return;
      }
      if (url.pathname === '/admin/keys' && req.method === 'GET') {
        this.handleListKeys(url, res);
        return;
      }
      const keyMatch = url.pathname.match(/^\/admin\/keys\/(.+)$/);
      if (keyMatch && req.method === 'GET') {
        this.handleGetKey(decodeURIComponent(keyMatch[1]), res);
        return;
      }
      if (keyMatch && req.method === 'DELETE') {
        this.handleDeleteKey(decodeURIComponent(keyMatch[1]), res);
        return;
      }
      this.sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      logger.error('admin.request_failed', { error: err instanceof Error ? err.message : String(err) });
      this.sendJson(res, 500, { error: 'internal error' });
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.config.adminToken) return true; // no token configured: rely on network isolation only
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${this.config.adminToken}`;
  }

  private handleStats(res: ServerResponse): void {
    const storeStats = this.store.stats();
    const pubsubStats = this.pubsub.stats();
    const uptimeSeconds = Math.max(1, Math.floor((Date.now() - startedAtMs) / 1000));
    const commandsTotal = getCommandsProcessedTotal();
    this.sendJson(res, 200, {
      uptimeSeconds,
      connectionCount: this.respServer.activeConnectionCount(),
      keyCounts: storeStats.keyCounts,
      subscriptions: {
        channels: pubsubStats.channelCount,
        patterns: pubsubStats.patternCount,
        channelSubscriptions: pubsubStats.channelSubscriptions,
        patternSubscriptions: pubsubStats.patternSubscriptions,
      },
      commandsTotal,
      commandsPerSecond: Number((commandsTotal / uptimeSeconds).toFixed(2)),
      memoryEstimateBytes: storeStats.memoryEstimateBytes,
    });
  }

  private handlePubsub(res: ServerResponse): void {
    this.sendJson(res, 200, this.pubsub.topology());
  }

  private handleListKeys(url: URL, res: ServerResponse): void {
    const prefix = url.searchParams.get('prefix') ?? '';
    const limit = clampLimit(Number(url.searchParams.get('limit') ?? '100'));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
    const { keys, total } = this.store.listKeys(prefix, limit, offset);
    this.sendJson(res, 200, { total, limit, offset, keys });
  }

  private handleGetKey(key: string, res: ServerResponse): void {
    const detail = this.store.getKeyDetail(key);
    const resultLabel = detail ? 'success' : 'error';
    // Fetching a single key's full value is an explicit, targeted action, so it
    // is auditable in the same way DELETE is — logged, not a silent debug read.
    recordAdminAction('get_key', resultLabel);
    logger.info('admin.action', { action: 'get_key', key, result: resultLabel });
    if (!detail) {
      this.sendJson(res, 404, { error: 'key not found' });
      return;
    }
    this.sendJson(res, 200, detail);
  }

  private handleDeleteKey(key: string, res: ServerResponse): void {
    const deleted = this.store.deleteKey(key);
    recordAdminAction('delete_key', deleted ? 'success' : 'error');
    logger.info('admin.action', { action: 'delete_key', key, result: deleted ? 'success' : 'error' });
    if (!deleted) {
      this.sendJson(res, 404, { error: 'key not found' });
      return;
    }
    this.sendJson(res, 200, { deleted: true, key });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }
}

function clampLimit(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return Math.min(raw, 1000);
}
