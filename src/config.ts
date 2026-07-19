export interface ServerConfig {
  respPort: number;
  healthPort: number;
  adminPort: number;
  /** RESP AUTH password. When set, clients must AUTH before issuing other commands. */
  authPassword: string | null;
  adminToken: string | null;
  ttlSweepIntervalMs: number;
  /** Max distinct keys before writes that create a new key are rejected with -OOM. 0 disables. */
  maxKeys: number;
  /** Estimated keyspace byte ceiling before new-key writes are rejected with -OOM. 0 disables. */
  maxMemoryBytes: number;
  /** Max concurrent RESP connections before new ones are refused. 0 disables. */
  maxClients: number;
  /** Idle (no-traffic) timeout in ms after which a non-subscriber connection is closed. 0 disables. */
  idleTimeoutMs: number;
  /** Max declared bulk-string length the parser will accept for a single argument. */
  maxBulkBytes: number;
  /** Max pending unparsed bytes buffered per connection before the connection is killed. */
  maxBufferBytes: number;
  /** Outbound socket buffer high-water mark; a connection exceeding it is destroyed (slow-consumer guard). */
  outboundHighWaterMarkBytes: number;
  otelServiceName: string;
  appInsightsConnectionString: string | null;
  otlpTraceEndpoint: string | null;
  otlpMetricsEndpoint: string | null;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const MiB = 1024 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    respPort: intFromEnv(env, 'RESP_PORT', 6379),
    healthPort: intFromEnv(env, 'HEALTH_PORT', 8081),
    adminPort: intFromEnv(env, 'ADMIN_PORT', 8082),
    authPassword: env.REDIS_AUTH_PASSWORD || null,
    adminToken: env.ADMIN_TOKEN || null,
    ttlSweepIntervalMs: intFromEnv(env, 'TTL_SWEEP_INTERVAL_MS', 5000),
    // Default memory ceiling sits below the 0.5 Gi container limit so the app
    // rejects writes before the OOM-killer wipes all state. Sized for Node's
    // ~50-80 MB RSS baseline plus headroom.
    maxKeys: intFromEnv(env, 'MAX_KEYS', 1_000_000),
    maxMemoryBytes: intFromEnv(env, 'MAX_MEMORY_BYTES', 384 * MiB),
    maxClients: intFromEnv(env, 'MAX_CLIENTS', 10_000),
    idleTimeoutMs: intFromEnv(env, 'IDLE_TIMEOUT_MS', 5 * 60_000),
    maxBulkBytes: intFromEnv(env, 'MAX_BULK_BYTES', 8 * MiB),
    maxBufferBytes: intFromEnv(env, 'MAX_BUFFER_BYTES', 16 * MiB),
    outboundHighWaterMarkBytes: intFromEnv(env, 'MAX_OUTBOUND_BUFFER_BYTES', 32 * MiB),
    otelServiceName: env.OTEL_SERVICE_NAME || 'backendcache',
    appInsightsConnectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING || null,
    otlpTraceEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    otlpMetricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
  };
}
