import type { ServerConfig } from '../config.js';
import { logger } from '../logger.js';

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: TelemetryHandle = { shutdown: async () => {} };

/**
 * Wires up OpenTelemetry tracing + metrics export, landing spans/metrics in
 * the same telemetry pipeline the consuming app already uses (Azure Monitor
 * / Application Insights via OTLP or the Azure Monitor exporter directly).
 *
 * The exporter packages are optionalDependencies: if they aren't installed,
 * or no destination is configured, this degrades to the @opentelemetry/api
 * no-op provider — command spans/metrics still get created (see
 * telemetry/commandTelemetry.ts) but cost nothing and go nowhere. Tracing
 * must never be a hard runtime dependency for a cache/pubsub service.
 */
export async function initTelemetry(config: ServerConfig): Promise<TelemetryHandle> {
  if (!config.appInsightsConnectionString && !config.otlpTraceEndpoint) {
    logger.info('telemetry.disabled', { reason: 'no exporter destination configured' });
    return NOOP_HANDLE;
  }

  try {
    const [{ NodeSDK }, { resourceFromAttributes }, semconv] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);

    const resource = resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: config.otelServiceName,
    });

    const traceExporter = await buildTraceExporter(config);
    const metricReader = await buildMetricReader(config);

    // The Azure Monitor exporter package and @opentelemetry/sdk-node can resolve
    // slightly different nested @opentelemetry/sdk-trace-base / sdk-metrics
    // versions via npm's dependency tree, so TS sees structurally-identical but
    // nominally distinct types here. They're duck-type compatible at runtime
    // (both implement the same SpanExporter/MetricReader contract), so this is
    // a deliberate, narrow cast rather than a real type hazard.
    const sdk = new NodeSDK({
      resource,
      traceExporter: traceExporter ?? undefined,
      metricReader: metricReader ?? undefined,
      instrumentations: [],
    } as ConstructorParameters<typeof NodeSDK>[0]);

    sdk.start();
    logger.info('telemetry.started', {
      exporter: config.appInsightsConnectionString ? 'azure-monitor' : 'otlp',
    });

    return {
      shutdown: async () => {
        await sdk.shutdown();
      },
    };
  } catch (err) {
    logger.warn('telemetry.init_failed', {
      error: err instanceof Error ? err.message : String(err),
      hint: 'optional OpenTelemetry exporter dependencies may not be installed; continuing without export',
    });
    return NOOP_HANDLE;
  }
}

async function buildTraceExporter(config: ServerConfig) {
  if (config.appInsightsConnectionString) {
    const { AzureMonitorTraceExporter } = await import('@azure/monitor-opentelemetry-exporter');
    return new AzureMonitorTraceExporter({ connectionString: config.appInsightsConnectionString });
  }
  if (config.otlpTraceEndpoint) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    return new OTLPTraceExporter({ url: config.otlpTraceEndpoint });
  }
  return null;
}

async function buildMetricReader(config: ServerConfig) {
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
  if (config.appInsightsConnectionString) {
    const { AzureMonitorMetricExporter } = await import('@azure/monitor-opentelemetry-exporter');
    return new PeriodicExportingMetricReader({
      exporter: new AzureMonitorMetricExporter({ connectionString: config.appInsightsConnectionString }),
      exportIntervalMillis: 30000,
    });
  }
  if (config.otlpMetricsEndpoint) {
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    return new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: config.otlpMetricsEndpoint }),
      exportIntervalMillis: 30000,
    });
  }
  return null;
}
