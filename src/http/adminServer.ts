import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { RespServer } from '../server/respServer.js';
import type { ServerConfig } from '../config.js';
import type { ClusterCoordinator } from '../cluster/clusterCoordinator.js';
import { getCommandsProcessedTotal, recordAdminAction } from '../telemetry/commandTelemetry.js';
import { secureEqual } from '../util/secureCompare.js';
import { logger } from '../logger.js';

const startedAtMs = Date.now();

/**
 * Token-gated JSON admin API on its own port (separate from RESP and
 * /healthz). Every action is logged and emitted as a metric — DELETE in
 * particular mutates state a real client depends on, so it's treated as
 * auditable, not a silent debug tool.
 *
 * In standalone (single-node) mode, every endpoint reflects only this
 * process. In HA mode, /admin/stats and /admin/pubsub also report a
 * cluster-wide view assembled from peer nodes' heartbeat snapshots (see
 * ClusterCoordinator.clusterSnapshot), and /admin/nodes lists cluster
 * membership directly — any node can answer for the whole cluster, since
 * Container Apps' internal ingress doesn't let an operator target one
 * replica specifically.
 */
export class AdminServer {
  private server: Server;

  constructor(
    private readonly store: Store,
    private readonly pubsub: PubSubRegistry,
    private readonly respServer: RespServer,
    private readonly config: ServerConfig,
    private readonly cluster: ClusterCoordinator,
  ) {
    this.server = createServer((req, res) => void this.handle(req, res));
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');

    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      if (url.pathname === '/admin/stats' && req.method === 'GET') {
        await this.handleStats(res);
        return;
      }
      if (url.pathname === '/admin/pubsub' && req.method === 'GET') {
        await this.handlePubsub(res);
        return;
      }
      if (url.pathname === '/admin/nodes' && req.method === 'GET') {
        await this.handleNodes(res);
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
    return secureEqual(header, `Bearer ${this.config.adminToken}`);
  }

  private async handleStats(res: ServerResponse): Promise<void> {
    const storeStats = this.store.stats();
    const pubsubStats = this.pubsub.stats();
    const uptimeSeconds = Math.max(1, Math.floor((Date.now() - startedAtMs) / 1000));
    const commandsTotal = getCommandsProcessedTotal();
    const peers = await this.cluster.clusterSnapshot();

    const body: Record<string, unknown> = {
      nodeId: this.cluster.nodeId,
      haEnabled: this.cluster.haEnabled,
      hydrated: this.cluster.isHydrated,
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
    };

    if (this.cluster.haEnabled) {
      body.cluster = {
        nodeCount: peers.length,
        connectionCount: peers.reduce((sum, n) => sum + n.connectionCount, 0),
        commandsTotal: peers.reduce((sum, n) => sum + n.commandsTotal, 0),
        keyCounts: sumKeyCounts(peers.map((n) => n.keyCounts)),
        nodes: peers.map((n) => ({ nodeId: n.nodeId, lastHeartbeatMs: n.lastHeartbeatMs, connectionCount: n.connectionCount })),
      };
    }

    this.sendJson(res, 200, body);
  }

  private async handlePubsub(res: ServerResponse): Promise<void> {
    const local = this.pubsub.topology();
    if (!this.cluster.haEnabled) {
      this.sendJson(res, 200, local);
      return;
    }

    const peers = await this.cluster.clusterSnapshot();
    const otherPeers = peers.filter((n) => n.nodeId !== this.cluster.nodeId);
    this.sendJson(res, 200, {
      cluster: {
        channels: mergeSubscriberCounts(
          'channel',
          local.channels,
          otherPeers.flatMap((n) => n.subscriptions.channels),
        ),
        patterns: mergeSubscriberCounts(
          'pattern',
          local.patterns,
          otherPeers.flatMap((n) => n.subscriptions.patterns),
        ),
      },
      byNode: [
        { nodeId: this.cluster.nodeId, channelCount: local.channels.length, patternCount: local.patterns.length, channels: local.channels, patterns: local.patterns },
        // Peer channel/pattern lists are capped to the top-N by subscriber
        // count in the heartbeat (see HEARTBEAT_TOP_SUBSCRIPTIONS); the *Count
        // fields are always exact, so the view is honest about truncation.
        ...otherPeers.map((n) => ({
          nodeId: n.nodeId,
          channelCount: n.subscriptions.channelCount,
          patternCount: n.subscriptions.patternCount,
          channels: n.subscriptions.channels,
          patterns: n.subscriptions.patterns,
        })),
      ],
    });
  }

  private async handleNodes(res: ServerResponse): Promise<void> {
    if (!this.cluster.haEnabled) {
      this.sendJson(res, 200, { haEnabled: false, nodes: [{ nodeId: this.cluster.nodeId, self: true }] });
      return;
    }
    const peers = await this.cluster.clusterSnapshot();
    this.sendJson(res, 200, {
      haEnabled: true,
      nodes: peers.map((n) => ({ ...n, self: n.nodeId === this.cluster.nodeId })),
    });
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
    // Propagate cluster-wide the same way a client's DEL does: the key is
    // already gone locally, so this ships a delete fact to the durable
    // store and every other node rather than leaving it to reappear on
    // this node's next hydration.
    this.cluster.publishKeyChange(key);
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

function sumKeyCounts(all: Array<Record<string, number>>): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const counts of all) {
    for (const [type, count] of Object.entries(counts)) sums[type] = (sums[type] ?? 0) + count;
  }
  return sums;
}

/** Merges per-node channel/pattern subscriber counts into one cluster-wide view, keyed by channel/pattern name. */
function mergeSubscriberCounts<K extends 'channel' | 'pattern'>(
  nameField: K,
  local: Array<Record<K, string> & { subscriberCount: number }>,
  remote: Array<Record<K, string> & { subscriberCount: number }>,
): Array<Record<K, string> & { subscriberCount: number }> {
  const counts = new Map<string, Record<K, string> & { subscriberCount: number }>();
  for (const entry of [...local, ...remote]) {
    const name = entry[nameField];
    const existing = counts.get(name);
    if (existing) existing.subscriberCount += entry.subscriberCount;
    else counts.set(name, { ...entry });
  }
  return Array.from(counts.values());
}
