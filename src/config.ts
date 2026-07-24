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
  /**
   * TCP keepalive probe delay in ms for accepted RESP connections. Pub/sub
   * subscribers can sit idle (no application-level traffic) far longer than
   * any single command round-trip, which is exactly the pattern a stateful
   * NAT gateway or load balancer between client and server silently reaps
   * after its own idle timeout (5 minutes is a common default) — the socket
   * looks fine to both ends until the next write fails. OS-level keepalive
   * probes generate traffic on a truly idle connection so those middleboxes
   * see it as active. 0 disables (relies on OS defaults, typically 2h+).
   */
  tcpKeepAliveMs: number;
  /** Log any command whose execution takes at least this many ms (redacted key), for latency diagnosis. 0 disables. */
  slowCommandLogMs: number;
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
  /** Azure Service Bus connection string. Set together with Cosmos config to run in HA (multi-node) mode. Takes precedence over serviceBusFullyQualifiedNamespace. */
  serviceBusConnectionString: string | null;
  /** Service Bus fully-qualified namespace (e.g. `my-ns.servicebus.windows.net`), for managed-identity (AAD) auth when no connection string is set. */
  serviceBusFullyQualifiedNamespace: string | null;
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
  /**
   * How often to run anti-entropy re-hydration (re-load durable keys
   * changed since the last pass) as a convergence backstop for missed
   * replication events. Defaults to the Service Bus message TTL (5 min), so
   * a node partitioned past the point where events expire still catches up.
   * 0 disables.
   */
  antiEntropyIntervalMs: number;
  /**
   * Persistence exemption for short-lived keys. A key whose remaining TTL is
   * under this at replication time is NOT written to Cosmos DB — peers still
   * converge via Service Bus (they don't read Cosmos for live replication),
   * and the key would expire long before a restart could care about it. This
   * removes the dominant Cosmos RU source (rate-limit / sliding-window churn)
   * for data that was never durability-worthy. Trade-off: a *full-cluster*
   * restart loses sub-threshold keys — the accepted contract for all data
   * before persistence existed. 0 disables (everything is persisted); a
   * sensible enabled value is ~60000 (see docs/high-availability.md).
   */
  durabilityMinTtlMs: number;
  /**
   * Max channels/patterns (each) included by subscriber count in a node's
   * heartbeat snapshot. The heartbeat is re-written every
   * HEARTBEAT_INTERVAL_MS, so an uncapped topology makes its Cosmos write RU
   * grow with Socket.IO room count. Exact totals are always kept; only the
   * per-name detail list is capped.
   */
  heartbeatTopSubscriptions: number;
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
    tcpKeepAliveMs: intFromEnv(env, 'TCP_KEEPALIVE_MS', 30_000),
    slowCommandLogMs: intFromEnv(env, 'SLOW_COMMAND_LOG_MS', 0),
    maxBulkBytes: intFromEnv(env, 'MAX_BULK_BYTES', 8 * MiB),
    maxBufferBytes: intFromEnv(env, 'MAX_BUFFER_BYTES', 16 * MiB),
    outboundHighWaterMarkBytes: intFromEnv(env, 'MAX_OUTBOUND_BUFFER_BYTES', 32 * MiB),
    otelServiceName: env.OTEL_SERVICE_NAME || 'zatedb',
    appInsightsConnectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING || null,
    otlpTraceEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    otlpMetricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,

    nodeId: env.NODE_ID || env.CONTAINER_APP_REPLICA_NAME || '',
    serviceBusConnectionString: env.SERVICE_BUS_CONNECTION_STRING || null,
    serviceBusFullyQualifiedNamespace: env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE || env.SERVICE_BUS_NAMESPACE || null,
    serviceBusTopicName: env.SERVICE_BUS_TOPIC_NAME || 'zatedb-replication',
    cosmosConnectionString: env.COSMOS_CONNECTION_STRING || null,
    cosmosEndpoint: env.COSMOS_ENDPOINT || null,
    cosmosDatabase: env.COSMOS_DATABASE || 'zatedb',
    cosmosKeysContainer: env.COSMOS_KEYS_CONTAINER || 'keys',
    cosmosNodesContainer: env.COSMOS_NODES_CONTAINER || 'nodes',
    heartbeatIntervalMs: intFromEnv(env, 'HEARTBEAT_INTERVAL_MS', 10_000),
    nodeStaleMs: intFromEnv(env, 'NODE_STALE_MS', 30_000),
    antiEntropyIntervalMs: intFromEnv(env, 'ANTI_ENTROPY_INTERVAL_MS', 5 * 60_000),
    durabilityMinTtlMs: intFromEnv(env, 'DURABILITY_MIN_TTL_MS', 0),
    heartbeatTopSubscriptions: intFromEnv(env, 'HEARTBEAT_TOP_SUBSCRIPTIONS', 25),
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
  return Boolean(config.serviceBusConnectionString || config.serviceBusFullyQualifiedNamespace);
}

/** HA (multi-node) mode requires both a durable store and a replication transport to be configured. */
export function isHaConfigured(config: ServerConfig): boolean {
  return hasDurableStoreConfigured(config) && hasReplicationTransportConfigured(config);
}
