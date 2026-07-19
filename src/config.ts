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
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    respPort: intFromEnv('RESP_PORT', 6379),
    healthPort: intFromEnv('HEALTH_PORT', 8081),
    adminPort: intFromEnv('ADMIN_PORT', 8082),
    authPassword: env.REDIS_AUTH_PASSWORD || null,
    adminToken: env.ADMIN_TOKEN || null,
    ttlSweepIntervalMs: intFromEnv('TTL_SWEEP_INTERVAL_MS', 5000),
    otelServiceName: env.OTEL_SERVICE_NAME || 'backendcache',
    appInsightsConnectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING || null,
    otlpTraceEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    otlpMetricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
  };
}
