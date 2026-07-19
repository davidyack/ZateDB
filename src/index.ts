import { loadConfig, isHaConfigured } from './config.js';
import { Store } from './store/store.js';
import { PubSubRegistry } from './pubsub/registry.js';
import { RespServer } from './server/respServer.js';
import { HealthServer } from './http/healthServer.js';
import { AdminServer } from './http/adminServer.js';
import { initTelemetry } from './telemetry/otel.js';
import { bindKeyCountsSource, getCommandsProcessedTotal } from './telemetry/commandTelemetry.js';
import { createClusterCoordinator } from './cluster/factory.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = await initTelemetry(config);

  const store = new Store(config.ttlSweepIntervalMs);
  const pubsub = new PubSubRegistry();
  bindKeyCountsSource(() => store.stats());

  // RespServer.activeConnectionCount() is only available once the server
  // exists, but the cluster coordinator's heartbeat needs it as a
  // callback — resolved through this indirection rather than a
  // construction-order cycle (cluster -> respServer -> cluster).
  let connectionCount = (): number => 0;
  const cluster = await createClusterCoordinator(config, {
    store,
    pubsub,
    connectionCount: () => connectionCount(),
    commandsTotal: getCommandsProcessedTotal,
  });

  const respServer = new RespServer(store, pubsub, config, cluster);
  connectionCount = () => respServer.activeConnectionCount();

  const healthServer = new HealthServer(respServer, cluster);
  const adminServer = new AdminServer(store, pubsub, respServer, config, cluster);

  // Health/admin listen immediately so /readyz is reachable (reporting
  // not-ready) while hydration is in progress; the RESP port itself only
  // starts accepting client connections once hydration completes, so a
  // scaled-out node never serves a cold cache.
  await Promise.all([healthServer.listen(config.healthPort), adminServer.listen(config.adminPort)]);
  await cluster.start();
  await respServer.listen(config.respPort);

  logger.info('backendcache.started', {
    respPort: config.respPort,
    healthPort: config.healthPort,
    adminPort: config.adminPort,
    authRequired: Boolean(config.authPassword),
    nodeId: cluster.nodeId,
    haEnabled: isHaConfigured(config),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('backendcache.shutting_down', { signal });
    await Promise.all([respServer.shutdown(), healthServer.close(), adminServer.close()]);
    await cluster.stop();
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
