import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { startTestServer } from '../helpers/startServer.js';
import type { TestServer } from '../helpers/startServer.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { FakeDurableStore, FakeReplicationHub } from '../helpers/fakeCluster.js';

function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, 10);
    };
    void check();
  });
}

/**
 * End-to-end proof of the HA architecture using two full BackendCache RESP
 * servers (real `redis` clients, one per node) sharing a fake Cosmos DB /
 * Service Bus pair — the same ClusterCoordinator wiring production uses,
 * with only the Azure SDK calls swapped for in-memory doubles (see
 * test/helpers/fakeCluster.ts). A client can talk to either node and see
 * the same shared state, which is the whole point of running BackendCache
 * as more than one replica.
 */
describe('multi-node HA replication (RESP-level, two nodes)', () => {
  let nodeA: TestServer;
  let nodeB: TestServer;
  let clientA: RedisClientType;
  let clientB: RedisClientType;

  beforeAll(async () => {
    const durable = new FakeDurableStore();
    const hub = new FakeReplicationHub();

    function buildNodeCluster(nodeId: string): { store: Store; pubsub: PubSubRegistry; cluster: ClusterCoordinator } {
      const store = new Store(0);
      const pubsub = new PubSubRegistry();
      const cluster = new ClusterCoordinator({
        store,
        pubsub,
        durable,
        transport: hub.createTransport(nodeId),
        nodeId,
        haEnabled: true,
        heartbeatIntervalMs: 10_000,
        nodeStaleMs: 30_000,
        connectionCount: () => 0,
        commandsTotal: () => 0,
      });
      return { store, pubsub, cluster };
    }

    const a = buildNodeCluster('node-a');
    const b = buildNodeCluster('node-b');

    nodeA = await startTestServer({}, a);
    nodeB = await startTestServer({}, b);

    clientA = createClient({ url: nodeA.url });
    clientB = createClient({ url: nodeB.url });
    await Promise.all([clientA.connect(), clientB.connect()]);
  });

  afterAll(async () => {
    await Promise.all([clientA.quit(), clientB.quit()]);
    await Promise.all([nodeA.stop(), nodeB.stop()]);
  });

  it('an INCR on node A is visible from node B (shared rate-limit counter)', async () => {
    await clientA.incr('rl:workspace1');
    await clientA.incr('rl:workspace1');

    await waitFor(async () => (await clientB.get('rl:workspace1')) === '2');
    expect(await clientB.get('rl:workspace1')).toBe('2');
  });

  it('an HSET on node B (presence mirror) is visible from node A', async () => {
    await clientB.hSet('presence:room1', { user1: 'online' });

    await waitFor(async () => (await clientA.hGetAll('presence:room1')).user1 === 'online');
    expect(await clientA.hGetAll('presence:room1')).toEqual({ user1: 'online' });
  });

  it('a ZADD sliding-window entry added on node A is counted from node B', async () => {
    const now = 1_700_000_000_000;
    await clientA.zAdd('guard:workspace1', { score: now, value: 'evt-1' });

    await waitFor(async () => (await clientB.zCount('guard:workspace1', `(${now - 1}`, '+inf')) === 1);
    expect(await clientB.zCount('guard:workspace1', `(${now - 1}`, '+inf')).toBe(1);
  });

  it('a DEL on node A removes the key from node B too', async () => {
    await clientA.set('shared', 'v');
    await waitFor(async () => (await clientB.get('shared')) === 'v');

    await clientA.del('shared');
    await waitFor(async () => (await clientB.get('shared')) === null);
    expect(await clientB.get('shared')).toBeNull();
  });

  it('PUBLISH on node A reaches a subscriber connected only to node B (Socket.IO adapter cross-node fan-out)', async () => {
    const subscriber = createClient({ url: nodeB.url });
    await subscriber.connect();
    const received: string[] = [];
    await subscriber.subscribe('room:1', (message) => received.push(message));

    await clientA.publish('room:1', 'hello-from-a');

    await waitFor(() => received.length === 1);
    expect(received).toEqual(['hello-from-a']);
    await subscriber.quit();
  });
});
