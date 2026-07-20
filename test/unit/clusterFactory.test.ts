import { afterEach, describe, expect, it } from 'vitest';
import { createClusterCoordinator } from '../../src/cluster/factory.js';
import { loadConfig } from '../../src/config.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';

/**
 * The split-brain guard: at minReplicas >= 2 (the production Bicep), a
 * typo'd env var or a missed secret must not silently drop the process into
 * standalone mode — that yields several independent, non-replicating nodes
 * behind one connection-spraying load balancer. REQUIRE_HA turns the silent
 * fallback into a startup failure so the orchestrator crash-loops instead
 * of serving divergent per-connection keyspaces.
 */
describe('createClusterCoordinator REQUIRE_HA guard', () => {
  let store: Store;

  const deps = () => {
    store = new Store(0);
    return { store, pubsub: new PubSubRegistry(), connectionCount: () => 0, commandsTotal: () => 0 };
  };

  afterEach(() => {
    store?.close();
  });

  it('throws when REQUIRE_HA is set but no HA config is present', async () => {
    const config = loadConfig({ REQUIRE_HA: 'true' } as unknown as NodeJS.ProcessEnv);
    await expect(createClusterCoordinator(config, deps())).rejects.toThrow(/REQUIRE_HA is set/);
  });

  it('throws on a partial HA config even without REQUIRE_HA (never a valid mode)', async () => {
    const config = loadConfig({
      COSMOS_CONNECTION_STRING: 'AccountEndpoint=https://x;AccountKey=y',
      // SERVICE_BUS_CONNECTION_STRING deliberately missing
    } as unknown as NodeJS.ProcessEnv);
    await expect(createClusterCoordinator(config, deps())).rejects.toThrow(/Partial HA configuration/);
  });

  it('throws on a partial HA config regardless of REQUIRE_HA', async () => {
    const config = loadConfig({
      REQUIRE_HA: 'true',
      SERVICE_BUS_CONNECTION_STRING: 'Endpoint=sb://x;SharedAccessKeyName=y;SharedAccessKey=z',
      // COSMOS_CONNECTION_STRING deliberately missing
    } as unknown as NodeJS.ProcessEnv);
    await expect(createClusterCoordinator(config, deps())).rejects.toThrow(/Partial HA configuration/);
  });

  it('builds a standalone coordinator when REQUIRE_HA is unset and nothing is configured', async () => {
    const cluster = await createClusterCoordinator(loadConfig({} as NodeJS.ProcessEnv), deps());
    expect(cluster.haEnabled).toBe(false);
    expect(cluster.isHydrated).toBe(true);
  });
});
