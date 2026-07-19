import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { RespServer } from '../../src/server/respServer.js';
import type { ServerConfig } from '../../src/config.js';

export interface TestServer {
  port: number;
  url: string;
  store: Store;
  pubsub: PubSubRegistry;
  stop: () => Promise<void>;
}

/**
 * Boots a real BackendCache RESP server on an ephemeral loopback port, for
 * integration tests that connect with the actual client libraries the
 * consuming app uses (node-redis, rate-limit-redis, @socket.io/redis-adapter).
 */
export async function startTestServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
  const config: ServerConfig = {
    respPort: 0,
    healthPort: 0,
    adminPort: 0,
    authPassword: null,
    adminToken: null,
    ttlSweepIntervalMs: 0,
    otelServiceName: 'backendcache-test',
    appInsightsConnectionString: null,
    otlpTraceEndpoint: null,
    otlpMetricsEndpoint: null,
    ...overrides,
  };

  const store = new Store(config.ttlSweepIntervalMs);
  const pubsub = new PubSubRegistry();
  const respServer = new RespServer(store, pubsub, config);
  await respServer.listen(0);
  const port = respServer.port;

  return {
    port,
    url: config.authPassword ? `redis://:${config.authPassword}@127.0.0.1:${port}` : `redis://127.0.0.1:${port}`,
    store,
    pubsub,
    stop: async () => {
      await respServer.shutdown(500);
      store.close();
    },
  };
}
