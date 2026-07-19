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
  /**
   * Consecutive failed AUTH attempts on one connection before it's dropped,
   * forcing a full TCP reconnect + handshake per burst of guesses. Blunts
   * line-speed password brute force (a single connection can otherwise fire
   * unlimited guesses back-to-back). 0 disables.
   */
  maxFailedAuthAttempts: number;
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

  // ---- cluster / high-availability -------------------------------------
  /** Stable-enough identity for this node; see cluster/nodeId.ts for the resolution order. */
  nodeId: string;
  /** Azure Service Bus connection string. Set together with Cosmos config to run in HA (multi-node) mode. */
  serviceBusConnectionString: string | null;
  serviceBusTopicName: string;
  /** Cosmos DB key-based connection string. Takes precedence over cosmosEndpoint. */
  cosmosConnectionString: string | null;
  /** Cosmos DB account endpoint, for managed-identity (AAD) auth when no connection string is set. */
  cosmosEndpoint: string | null;
  cosmosDatabase: string;
  cosmosKeysContainer: string;
  cosmosNodesContainer: string;
  heartbeatIntervalMs: number;
  /** A peer node's heartbeat older than this is treated as dead and dropped from cluster admin views. */
  nodeStaleMs: number;
  /** How long startup (Cosmos DB / Service Bus connect + hydration) may take before failing fast instead of hanging indefinitely. */
  clusterStartupTimeoutMs: number;
  /**
   * Hard ceiling on graceful shutdown. cluster.stop() makes network calls
   * (replication drain, Service Bus subscription delete, client close); if
   * they hang — especially on the crash path, where the process is already
   * unhealthy — this timer force-exits rather than leaving a zombie the
   * orchestrator can't restart.
   */
  shutdownHardLimitMs: number;
  /**
   * When true, the process refuses to start in standalone mode: HA must be
   * fully configured (both Cosmos DB and Service Bus) or startup fails.
   * Set in the multi-replica Bicep deployment so a typo'd env var or a
   * missed secret can't silently leave 2+ non-replicating nodes behind one
   * connection-spraying load balancer — the split-brain-by-misconfiguration
   * failure the single-replica invariant used to make impossible.
   */
  requireHa: boolean;
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
    maxFailedAuthAttempts: intFromEnv(env, 'MAX_FAILED_AUTH_ATTEMPTS', 5),
    idleTimeoutMs: intFromEnv(env, 'IDLE_TIMEOUT_MS', 5 * 60_000),
    maxBulkBytes: intFromEnv(env, 'MAX_BULK_BYTES', 8 * MiB),
    maxBufferBytes: intFromEnv(env, 'MAX_BUFFER_BYTES', 16 * MiB),
    outboundHighWaterMarkBytes: intFromEnv(env, 'MAX_OUTBOUND_BUFFER_BYTES', 32 * MiB),
    otelServiceName: env.OTEL_SERVICE_NAME || 'backendcache',
    appInsightsConnectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING || null,
    otlpTraceEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    otlpMetricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,

    nodeId: env.NODE_ID || env.CONTAINER_APP_REPLICA_NAME || '',
    serviceBusConnectionString: env.SERVICE_BUS_CONNECTION_STRING || null,
    serviceBusTopicName: env.SERVICE_BUS_TOPIC_NAME || 'backendcache-replication',
    cosmosConnectionString: env.COSMOS_CONNECTION_STRING || null,
    cosmosEndpoint: env.COSMOS_ENDPOINT || null,
    cosmosDatabase: env.COSMOS_DATABASE || 'backendcache',
    cosmosKeysContainer: env.COSMOS_KEYS_CONTAINER || 'keys',
    cosmosNodesContainer: env.COSMOS_NODES_CONTAINER || 'nodes',
    heartbeatIntervalMs: intFromEnv(env, 'HEARTBEAT_INTERVAL_MS', 10_000),
    nodeStaleMs: intFromEnv(env, 'NODE_STALE_MS', 30_000),
    clusterStartupTimeoutMs: intFromEnv(env, 'CLUSTER_STARTUP_TIMEOUT_MS', 30_000),
    shutdownHardLimitMs: intFromEnv(env, 'SHUTDOWN_HARD_LIMIT_MS', 10_000),
    requireHa: boolExact(env.REQUIRE_HA, false),
  };
}

/** Parses a strict boolean env flag: only the literal string 'true' (case-insensitive) enables it. */
function boolExact(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

export function hasDurableStoreConfigured(config: ServerConfig): boolean {
  return Boolean(config.cosmosConnectionString || config.cosmosEndpoint);
}

export function hasReplicationTransportConfigured(config: ServerConfig): boolean {
  return Boolean(config.serviceBusConnectionString);
}

/** HA (multi-node) mode requires both a durable store and a replication transport to be configured. */
export function isHaConfigured(config: ServerConfig): boolean {
  return hasDurableStoreConfigured(config) && hasReplicationTransportConfigured(config);
}
