import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { RespServer } from '../../src/server/respServer.js';
import { HealthServer } from '../../src/http/healthServer.js';
import { loadConfig } from '../../src/config.js';
import { standaloneCluster } from '../helpers/cluster.js';
import type { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';

interface Harness {
  store: Store;
  baseUrl: string;
  stop: () => Promise<void>;
}

async function startHealth(): Promise<Harness> {
  const config = { ...loadConfig({}), respPort: 0, healthPort: 0, adminPort: 0 };
  const store = new Store(0);
  const pubsub = new PubSubRegistry();
  const cluster: ClusterCoordinator = standaloneCluster(store, pubsub);
  await cluster.start();
  const respServer = new RespServer(store, pubsub, config, cluster);
  const healthServer = new HealthServer(respServer, config, cluster, store, pubsub);
  await healthServer.listen(0);
  const port = (healthServer as unknown as { server: { address(): { port: number } } }).server.address().port;
  return {
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await healthServer.close();
      await cluster.stop();
      store.close();
    },
  };
}

describe('GET /metrics (Prometheus exposition)', () => {
  let harness: Harness;
  afterEach(() => harness?.stop());

  it('serves Prometheus text format with the expected content type', async () => {
    harness = await startHealth();
    const res = await fetch(`${harness.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');

    const body = await res.text();
    // Every metric family carries HELP and TYPE lines.
    expect(body).toContain('# HELP backendcache_up ');
    expect(body).toContain('# TYPE backendcache_up gauge');
    expect(body).toMatch(/^backendcache_up 1$/m);
    expect(body).toContain('# TYPE backendcache_commands_processed_total counter');
    expect(body).toContain('backendcache_ha_enabled 0');
    expect(body).toMatch(/backendcache_build_info\{version="1\.0\.0",node_id="test-node"\} 1/);
    // Exposition format must end with a newline.
    expect(body.endsWith('\n')).toBe(true);
  });

  it('exposes per-type key counts reflecting store contents', async () => {
    harness = await startHealth();
    harness.store.set('s1', 'v');
    harness.store.set('s2', 'v');
    harness.store.hset('h1', [['f', 'v']]);

    const body = await (await fetch(`${harness.baseUrl}/metrics`)).text();
    expect(body).toMatch(/backendcache_keys\{type="string"\} 2/);
    expect(body).toMatch(/backendcache_keys\{type="hash"\} 1/);
    expect(body).toMatch(/backendcache_keys\{type="sortedset"\} 0/);
  });

  it('still 404s unknown paths', async () => {
    harness = await startHealth();
    const res = await fetch(`${harness.baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
