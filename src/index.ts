import { loadConfig } from './config.js';
import { Store } from './store/store.js';
import { PubSubRegistry } from './pubsub/registry.js';
import { RespServer } from './server/respServer.js';
import { HealthServer } from './http/healthServer.js';
import { AdminServer } from './http/adminServer.js';
import { initTelemetry } from './telemetry/otel.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = await initTelemetry(config);

  const store = new Store(config.ttlSweepIntervalMs);
  const pubsub = new PubSubRegistry();
  const respServer = new RespServer(store, pubsub, config);
  const healthServer = new HealthServer(respServer);
  const adminServer = new AdminServer(store, pubsub, respServer, config);

  await Promise.all([
    respServer.listen(config.respPort),
    healthServer.listen(config.healthPort),
    adminServer.listen(config.adminPort),
  ]);

  logger.info('backendcache.started', {
    respPort: config.respPort,
    healthPort: config.healthPort,
    adminPort: config.adminPort,
    authRequired: Boolean(config.authPassword),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('backendcache.shutting_down', { signal });
    await Promise.all([respServer.shutdown(), healthServer.close(), adminServer.close()]);
    store.close();
    await telemetry.shutdown();
    logger.info('backendcache.stopped', {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('backendcache.fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
