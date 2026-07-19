export interface ServerConfig {
  respPort: number;
  healthPort: number;
  adminPort: number;
  /** RESP AUTH password. When set, clients must AUTH before issuing other commands. */
  authPassword: string | null;
  adminToken: string | null;
  ttlSweepIntervalMs: number;
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
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    respPort: intFromEnv(env, 'RESP_PORT', 6379),
    healthPort: intFromEnv(env, 'HEALTH_PORT', 8081),
    adminPort: intFromEnv(env, 'ADMIN_PORT', 8082),
    authPassword: env.REDIS_AUTH_PASSWORD || null,
    adminToken: env.ADMIN_TOKEN || null,
    ttlSweepIntervalMs: intFromEnv(env, 'TTL_SWEEP_INTERVAL_MS', 5000),
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
  };
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
