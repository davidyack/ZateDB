/**
 * Renders a scrape-time snapshot into Prometheus text exposition format
 * (version 0.0.4). This is a self-contained pull endpoint that lives
 * alongside — not instead of — the OTLP/Azure Monitor push pipeline in
 * otel.ts: it lets a plain Prometheus server scrape the same core numbers
 * without wiring up an OTLP collector. Only cheap, already-tracked
 * aggregates are exposed (O(1) store counters, the running command total,
 * live connection count) and never any key names or values, so the endpoint
 * stays safe to leave unauthenticated for scraping.
 */

export interface MetricsSnapshot {
  uptimeSeconds: number;
  connectedClients: number;
  commandsProcessed: number;
  keyCounts: Record<string, number>;
  memoryBytes: number;
  pubsub: {
    channelCount: number;
    patternCount: number;
    channelSubscriptions: number;
    patternSubscriptions: number;
  };
  haEnabled: boolean;
  hydrated: boolean;
  version: string;
  nodeId: string;
}

/** Exposition-format content type Prometheus expects on a /metrics scrape. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

type Sample = { labels?: Record<string, string>; value: number };

export function renderPrometheus(s: MetricsSnapshot): string {
  const out: string[] = [];

  const metric = (name: string, type: 'gauge' | 'counter', help: string, samples: Sample[]): void => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    for (const sample of samples) {
      out.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
    }
  };

  metric('zatedb_up', 'gauge', 'Always 1 for a process that is serving this endpoint', [{ value: 1 }]);
  metric('zatedb_uptime_seconds', 'gauge', 'Seconds since process start', [{ value: s.uptimeSeconds }]);
  metric('zatedb_connected_clients', 'gauge', 'Currently open RESP connections', [{ value: s.connectedClients }]);
  metric('zatedb_commands_processed_total', 'counter', 'Total RESP commands processed since start', [
    { value: s.commandsProcessed },
  ]);
  metric(
    'zatedb_keys',
    'gauge',
    'Live keys held in this node\'s in-memory store, by type',
    Object.entries(s.keyCounts).map(([type, count]) => ({ labels: { type }, value: count })),
  );
  metric('zatedb_memory_estimate_bytes', 'gauge', 'Estimated in-memory keyspace size in bytes', [
    { value: s.memoryBytes },
  ]);
  metric('zatedb_pubsub_channels', 'gauge', 'Channels with at least one subscriber', [
    { value: s.pubsub.channelCount },
  ]);
  metric('zatedb_pubsub_patterns', 'gauge', 'Distinct subscribed patterns', [{ value: s.pubsub.patternCount }]);
  metric('zatedb_pubsub_channel_subscriptions', 'gauge', 'Total channel subscriptions across all clients', [
    { value: s.pubsub.channelSubscriptions },
  ]);
  metric('zatedb_pubsub_pattern_subscriptions', 'gauge', 'Total pattern subscriptions across all clients', [
    { value: s.pubsub.patternSubscriptions },
  ]);
  metric('zatedb_ha_enabled', 'gauge', 'Whether HA/cluster replication is enabled (1) or standalone (0)', [
    { value: s.haEnabled ? 1 : 0 },
  ]);
  metric('zatedb_hydrated', 'gauge', 'Whether this node has finished hydrating from the durable store', [
    { value: s.hydrated ? 1 : 0 },
  ]);
  metric('zatedb_build_info', 'gauge', 'Build/identity labels; value is always 1', [
    { labels: { version: s.version, node_id: s.nodeId }, value: 1 },
  ]);

  // Exposition format requires a trailing newline.
  return `${out.join('\n')}\n`;
}

function formatLabels(labels?: Record<string, string>): string {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return '';
  const rendered = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
  return `{${rendered}}`;
}

/** Escapes backslash, double-quote and newline per the exposition-format spec. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
