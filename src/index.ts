import { loadConfig } from './config.js';
import { Store } from './store/store.js';
import { PubSubRegistry } from './pubsub/registry.js';
import { RespServer } from './server/respServer.js';
import { HealthServer } from './http/healthServer.js';
import { AdminServer } from './http/adminServer.js';
import { initTelemetry } from './telemetry/otel.js';
import { initSaturationMetrics } from './telemetry/saturation.js';
import { logger } from './logger.js';

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
  const respServer = new RespServer(store, pubsub, config);
  const healthServer = new HealthServer(respServer, config);
  const adminServer = new AdminServer(store, pubsub, respServer, config);

  await Promise.all([
    respServer.listen(config.respPort),
    healthServer.listen(config.healthPort),
    adminServer.listen(config.adminPort),
  ]);

  const stopSaturationMetrics = initSaturationMetrics(store, respServer);

  logger.info('backendcache.started', {
    respPort: config.respPort,
    healthPort: config.healthPort,
    adminPort: config.adminPort,
    authRequired: Boolean(config.authPassword),
    adminAuthRequired: Boolean(config.adminToken),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('backendcache.shutting_down', { signal });
    // Flip readiness before closing the listener so the orchestrator drains us
    // out of rotation instead of racing a connection into a closing socket.
    healthServer.setNotReady();
    stopSaturationMetrics();
    await Promise.all([respServer.shutdown(), healthServer.close(), adminServer.close()]);
    store.close();
    await telemetry.shutdown();
    logger.info('backendcache.stopped', {});
    process.exit(exitCode);
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
