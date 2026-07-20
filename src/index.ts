import { loadConfig, isHaConfigured } from './config.js';
import { Store } from './store/store.js';
import { PubSubRegistry } from './pubsub/registry.js';
import { RespServer } from './server/respServer.js';
import { HealthServer } from './http/healthServer.js';
import { AdminServer } from './http/adminServer.js';
import { initTelemetry } from './telemetry/otel.js';
import { bindKeyCountsSource, bindSlowCommandThreshold, getCommandsProcessedTotal } from './telemetry/commandTelemetry.js';
import { createClusterCoordinator } from './cluster/factory.js';
import { initSaturationMetrics } from './telemetry/saturation.js';
import { registerReplicationQueueGauge } from './telemetry/clusterMetrics.js';
import { logger } from './logger.js';

/**
 * A hung Cosmos DB / Service Bus connection at startup must not leave the
 * process "alive but never ready" forever — that's a materially worse
 * failure mode than crashing, since nothing signals it beyond a
 * permanently-failing readiness probe. Failing fast lets Container Apps'
 * restart policy retry with backoff instead.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = await initTelemetry(config);

  // Fail loud on fail-open secrets: unset auth means the data/admin plane is
  // open to anyone who can reach the port. Acceptable behind strict network
  // isolation, but never silent — especially in production.
  if (!config.authPassword) {
    logger.warn('backendcache.auth_disabled', {
      detail: 'REDIS_AUTH_PASSWORD is unset — RESP clients can connect without AUTH',
      production: process.env.NODE_ENV === 'production',
    });
  }
  if (!config.adminToken) {
    logger.warn('backendcache.admin_auth_disabled', {
      detail: 'ADMIN_TOKEN is unset — the admin API (key read/delete) is unauthenticated',
      production: process.env.NODE_ENV === 'production',
    });
  }

  const store = new Store(config.ttlSweepIntervalMs, {
    maxKeys: config.maxKeys,
    maxMemoryBytes: config.maxMemoryBytes,
  });
  const pubsub = new PubSubRegistry();
  bindKeyCountsSource(() => store.keyCounts());
  bindSlowCommandThreshold(config.slowCommandLogMs);

  // RespServer.activeConnectionCount() is only available once the server
  // exists, but the cluster coordinator's heartbeat needs it as a
  // callback — resolved through this indirection rather than a
  // construction-order cycle (cluster -> respServer -> cluster).
  let connectionCount = (): number => 0;
  // A fatal replication error can fire any time after start(); shutdown is
  // defined further down, so route through a mutable handle rather than a
  // forward reference (same indirection as connectionCount above).
  let onFatalReplication: (err: Error) => void = () => {};
  const cluster = await withTimeout(
    createClusterCoordinator(config, {
      store,
      pubsub,
      connectionCount: () => connectionCount(),
      commandsTotal: getCommandsProcessedTotal,
      onFatalReplicationError: (err) => onFatalReplication(err),
    }),
    config.clusterStartupTimeoutMs,
    'timed out connecting to Cosmos DB / Service Bus',
  );

  const respServer = new RespServer(store, pubsub, config, cluster);
  connectionCount = () => respServer.activeConnectionCount();

  const healthServer = new HealthServer(respServer, config, cluster, store, pubsub);
  const adminServer = new AdminServer(store, pubsub, respServer, config, cluster);

  // Health/admin listen immediately so /readyz is reachable (reporting
  // not-ready) while hydration is in progress; the RESP port itself only
  // starts accepting client connections once hydration completes, so a
  // scaled-out node never serves a cold cache. cluster.start() is
  // timeout-bounded for the same reason createClusterCoordinator is above
  // — a stuck hydration must fail the process, not hang it forever.
  await Promise.all([healthServer.listen(config.healthPort), adminServer.listen(config.adminPort)]);
  await withTimeout(cluster.start(), config.clusterStartupTimeoutMs, 'timed out hydrating from the durable store');
  await respServer.listen(config.respPort);

  const stopSaturationMetrics = initSaturationMetrics(store, respServer);
  registerReplicationQueueGauge(() => cluster.replicationQueueDepth());

  logger.info('backendcache.started', {
    respPort: config.respPort,
    healthPort: config.healthPort,
    adminPort: config.adminPort,
    authRequired: Boolean(config.authPassword),
    adminAuthRequired: Boolean(config.adminToken),
    nodeId: cluster.nodeId,
    haEnabled: isHaConfigured(config),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('backendcache.shutting_down', { signal });
    // Hard deadline: graceful shutdown awaits cluster.stop(), which makes
    // network calls to Cosmos DB / Service Bus (drain, subscription delete,
    // client close). On the crash path (uncaughtException / unhandledRejection)
    // the process is already in a bad state, and any of those calls hanging
    // would leave a zombie that never exits — worse than an abrupt exit the
    // orchestrator can restart. This timer force-exits regardless; unref() so
    // it never itself keeps the process alive if the clean path wins the race.
    const hardExit = setTimeout(() => {
      logger.error('backendcache.shutdown_timeout', { signal, limitMs: config.shutdownHardLimitMs });
      process.exit(exitCode);
    }, config.shutdownHardLimitMs);
    hardExit.unref?.();
    // Flip readiness before closing the listener so the orchestrator drains us
    // out of rotation instead of racing a connection into a closing socket.
    healthServer.setNotReady();
    stopSaturationMetrics();
    try {
      await Promise.all([respServer.shutdown(), healthServer.close(), adminServer.close()]);
      await cluster.stop();
      store.close();
      await telemetry.shutdown();
      logger.info('backendcache.stopped', {});
    } catch (err) {
      logger.error('backendcache.shutdown_error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(hardExit);
    }
    process.exit(exitCode);
  };

  // Replication has died unrecoverably (subscription gone / sustained
  // receive errors): this node can no longer see peers' writes, so exit
  // non-zero and let the orchestrator restart a clean instance that
  // re-creates its subscription and re-hydrates. Staying up would serve a
  // silently-diverging keyspace.
  onFatalReplication = (err) => {
    logger.error('backendcache.replication_fatal', { error: err.message });
    void shutdown('replicationFatal', 1);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Last-resort safety nets: a bug that escapes the per-connection handlers
  // shouldn't leave a half-dead process untraced. Log, attempt a graceful
  // drain, then exit non-zero so the orchestrator restarts a clean instance.
  process.on('uncaughtException', (err) => {
    logger.error('backendcache.uncaught_exception', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('backendcache.unhandled_rejection', { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
    void shutdown('unhandledRejection', 1);
  });
}

main().catch((err) => {
  logger.error('backendcache.fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
