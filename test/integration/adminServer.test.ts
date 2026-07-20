import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { RespServer } from '../../src/server/respServer.js';
import { AdminServer } from '../../src/http/adminServer.js';
import { loadConfig } from '../../src/config.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { standaloneCluster } from '../helpers/cluster.js';
import { FakeDurableStore, FakeReplicationHub } from '../helpers/fakeCluster.js';

interface Harness {
  store: Store;
  cluster: ClusterCoordinator;
  adminUrl: string;
  stop: () => Promise<void>;
}

/** A ClusterCoordinator plus the exact Store/PubSubRegistry it was built with — RespServer/AdminServer must use the same pair, or a command applied through one and read back through the other would silently diverge. */
interface HaOverride {
  store: Store;
  pubsub: PubSubRegistry;
  cluster: ClusterCoordinator;
}

async function startAdmin(ha?: HaOverride): Promise<Harness> {
  const config = { ...loadConfig({}), respPort: 0, healthPort: 0, adminPort: 0 };
  const store = ha?.store ?? new Store(0);
  const pubsub = ha?.pubsub ?? new PubSubRegistry();
  const resolvedCluster = ha?.cluster ?? standaloneCluster(store, pubsub);
  await resolvedCluster.start();
  const respServer = new RespServer(store, pubsub, config, resolvedCluster);
  const adminServer = new AdminServer(store, pubsub, respServer, config, resolvedCluster);
  await adminServer.listen(0);
  const port = (adminServer as unknown as { server: { address(): { port: number } } }).server.address().port;
  return {
    store,
    cluster: resolvedCluster,
    adminUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await adminServer.close();
      await resolvedCluster.stop();
      store.close();
    },
  };
}

describe('Admin API (standalone mode)', () => {
  let harness: Harness;
  afterEach(() => harness?.stop());

  it('GET /admin/stats reports nodeId/haEnabled/hydrated and no cluster field', async () => {
    harness = await startAdmin();
    const res = await fetch(`${harness.adminUrl}/admin/stats`);
    const body = (await res.json()) as any;
    expect(body.nodeId).toBe('test-node');
    expect(body.haEnabled).toBe(false);
    expect(body.hydrated).toBe(true);
    expect(body.cluster).toBeUndefined();
  });

  it('GET /admin/pubsub returns the local topology shape directly (no cluster wrapper)', async () => {
    harness = await startAdmin();
    const res = await fetch(`${harness.adminUrl}/admin/pubsub`);
    const body = (await res.json()) as any;
    expect(body).toEqual({ channels: [], patterns: [] });
  });

  it('GET /admin/nodes lists just this node, marked self', async () => {
    harness = await startAdmin();
    const res = await fetch(`${harness.adminUrl}/admin/nodes`);
    const body = (await res.json()) as any;
    expect(body.haEnabled).toBe(false);
    expect(body.nodes).toEqual([{ nodeId: 'test-node', self: true }]);
  });

  it('DELETE /admin/keys/:key removes the key and reports success', async () => {
    harness = await startAdmin();
    harness.store.set('k', 'v');
    const res = await fetch(`${harness.adminUrl}/admin/keys/k`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(harness.store.get('k')).toBeNull();
  });
});

describe('Admin API (HA mode)', () => {
  let harnessA: Harness;
  let harnessB: Harness;
  let durable: FakeDurableStore;

  afterEach(async () => {
    await Promise.all([harnessA?.stop(), harnessB?.stop()]);
  });

  async function startPair() {
    durable = new FakeDurableStore();
    const hub = new FakeReplicationHub();
    const build = (nodeId: string): HaOverride => {
      const store = new Store(0);
      const pubsub = new PubSubRegistry();
      const cluster = new ClusterCoordinator({
        store,
        pubsub,
        durable,
        transport: hub.createTransport(nodeId),
        nodeId,
        haEnabled: true,
        heartbeatIntervalMs: 20,
        nodeStaleMs: 30_000,
        connectionCount: () => 0,
        commandsTotal: () => 0,
      });
      return { store, pubsub, cluster };
    };
    harnessA = await startAdmin(build('node-a'));
    harnessB = await startAdmin(build('node-b'));
    // let at least one heartbeat land from each node
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  it('GET /admin/stats includes a cluster-wide aggregate', async () => {
    await startPair();
    const res = await fetch(`${harnessA.adminUrl}/admin/stats`);
    const body = (await res.json()) as any;
    expect(body.haEnabled).toBe(true);
    expect(body.cluster.nodeCount).toBe(2);
    expect(body.cluster.nodes.map((n: { nodeId: string }) => n.nodeId).sort()).toEqual(['node-a', 'node-b']);
  });

  it('GET /admin/nodes lists both nodes with the queried one marked self', async () => {
    await startPair();
    const res = await fetch(`${harnessA.adminUrl}/admin/nodes`);
    const body = (await res.json()) as any;
    expect(body.haEnabled).toBe(true);
    const self = body.nodes.find((n: { nodeId: string; self: boolean }) => n.nodeId === 'node-a');
    expect(self.self).toBe(true);
  });

  it('DELETE /admin/keys/:key propagates the delete to the other node via the durable store', async () => {
    await startPair();
    harnessA.store.set('shared', 'v');
    harnessA.cluster.publishKeyChange('shared');
    // Prove the key actually reached the durable store first — otherwise
    // the delete-propagation assertion below would be trivially true even
    // if propagation were completely broken (nothing to begin with).
    const setStart = Date.now();
    while (!durable.keys.has('shared') && Date.now() - setStart < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(durable.keys.has('shared')).toBe(true);

    const res = await fetch(`${harnessA.adminUrl}/admin/keys/shared`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const start = Date.now();
    while (durable.keys.has('shared') && Date.now() - start < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(durable.keys.has('shared')).toBe(false);
  });
});
