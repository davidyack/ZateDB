import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { RespServer } from '../../src/server/respServer.js';
import { loadConfig, type ServerConfig } from '../../src/config.js';
import type { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { standaloneCluster } from './cluster.js';

export interface TestServer {
  port: number;
  url: string;
  store: Store;
  pubsub: PubSubRegistry;
  cluster: ClusterCoordinator;
  stop: () => Promise<void>;
}

/** A ClusterCoordinator plus the exact Store/PubSubRegistry it was constructed against — it must be RespServer's too. */
export interface HaOverride {
  store: Store;
  pubsub: PubSubRegistry;
  cluster: ClusterCoordinator;
}

/**
 * Boots a real BackendCache RESP server on an ephemeral loopback port, for
 * integration tests that connect with the actual client libraries the
 * consuming app uses (node-redis, rate-limit-redis, @socket.io/redis-adapter).
 * Runs standalone (HA disabled) by default; pass `ha` to exercise
 * multi-node replication against fake durable-store/transport doubles
 * (see test/integration/haReplication.test.ts) — the store/pubsub must be
 * the same instances the given ClusterCoordinator was built with, since a
 * mismatched pair would mutate one store while replicating from another.
 */
export async function startTestServer(overrides: Partial<ServerConfig> = {}, ha?: HaOverride): Promise<TestServer> {
  const config: ServerConfig = {
    ...loadConfig({}),
    respPort: 0,
    healthPort: 0,
    adminPort: 0,
    ttlSweepIntervalMs: 0,
    otelServiceName: 'backendcache-test',
    ...overrides,
  };

  const store = ha?.store ?? new Store(config.ttlSweepIntervalMs);
  const pubsub = ha?.pubsub ?? new PubSubRegistry();
  const cluster = ha?.cluster ?? standaloneCluster(store, pubsub);
  await cluster.start();
  const respServer = new RespServer(store, pubsub, config, cluster);
  await respServer.listen(0);
  const port = respServer.port;

  return {
    port,
    url: config.authPassword ? `redis://:${config.authPassword}@127.0.0.1:${port}` : `redis://127.0.0.1:${port}`,
    store,
    pubsub,
    cluster,
    stop: async () => {
      await respServer.shutdown(500);
      await cluster.stop();
      store.close();
    },
  };
}
