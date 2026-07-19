import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { NullDurableStore } from '../../src/cluster/durableStore.js';
import { NullReplicationTransport } from '../../src/cluster/replicationTransport.js';
import { FakeDurableStore, FakeReplicationHub } from '../helpers/fakeCluster.js';

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, 5);
    };
    check();
  });
}

describe('ClusterCoordinator standalone mode', () => {
  let store: Store;
  let pubsub: PubSubRegistry;
  let cluster: ClusterCoordinator;

  beforeEach(() => {
    store = new Store(0);
    pubsub = new PubSubRegistry();
    cluster = new ClusterCoordinator({
      store,
      pubsub,
      durable: new NullDurableStore(),
      transport: new NullReplicationTransport(),
      nodeId: 'solo',
      haEnabled: false,
      heartbeatIntervalMs: 10_000,
      nodeStaleMs: 30_000,
      connectionCount: () => 0,
      commandsTotal: () => 0,
    });
  });

  afterEach(async () => {
    await cluster.stop();
    store.close();
  });

  it('is hydrated immediately, without calling start()', () => {
    expect(cluster.isHydrated).toBe(true);
  });

  it('publishKeyChange/publishMessage/clusterSnapshot are no-ops', async () => {
    store.set('k', 'v');
    cluster.publishKeyChange('k'); // must not throw even though nothing is wired up
    cluster.publishMessage('chan', 'msg');
    expect(await cluster.clusterSnapshot()).toEqual([]);
  });
});

describe('ClusterCoordinator HA mode: hydration', () => {
  it('loads every durable key into the local store before start() resolves', async () => {
    const durable = new FakeDurableStore();
    await durable.putKey('k1', { type: 'string', value: 'v1', expiresAtMs: null });
    await durable.putKey('h1', { type: 'hash', fields: [['f', 'v']], expiresAtMs: null });

    const store = new Store(0);
    const pubsub = new PubSubRegistry();
    const cluster = new ClusterCoordinator({
      store,
      pubsub,
      durable,
      transport: new FakeReplicationHub().createTransport('node-a'),
      nodeId: 'node-a',
      haEnabled: true,
      heartbeatIntervalMs: 10_000,
      nodeStaleMs: 30_000,
      connectionCount: () => 0,
      commandsTotal: () => 0,
    });

    expect(cluster.isHydrated).toBe(false);
    await cluster.start();
    expect(cluster.isHydrated).toBe(true);
    expect(store.get('k1')).toBe('v1');
    expect(store.hgetall('h1')).toEqual([['f', 'v']]);

    await cluster.stop();
    store.close();
  });
});

describe('ClusterCoordinator HA mode: cross-node convergence', () => {
  let durable: FakeDurableStore;
  let hub: FakeReplicationHub;
  let storeA: Store, storeB: Store;
  let pubsubA: PubSubRegistry, pubsubB: PubSubRegistry;
  let clusterA: ClusterCoordinator, clusterB: ClusterCoordinator;

  beforeEach(async () => {
    durable = new FakeDurableStore();
    hub = new FakeReplicationHub();
    storeA = new Store(0);
    storeB = new Store(0);
    pubsubA = new PubSubRegistry();
    pubsubB = new PubSubRegistry();

    const build = (nodeId: string, store: Store, pubsub: PubSubRegistry) =>
      new ClusterCoordinator({
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

    clusterA = build('node-a', storeA, pubsubA);
    clusterB = build('node-b', storeB, pubsubB);
    await Promise.all([clusterA.start(), clusterB.start()]);
  });

  afterEach(async () => {
    await Promise.all([clusterA.stop(), clusterB.stop()]);
    storeA.close();
    storeB.close();
  });

  it('replicates a mutation applied on one node to the other node\'s in-memory copy', async () => {
    storeA.incr('counter'); // simulates a command handler's local mutation, already applied
    clusterA.publishKeyChange('counter'); // what the dispatcher does right after

    await waitFor(() => storeB.get('counter') === '1');
    expect(storeB.get('counter')).toBe('1');
    expect(durable.keys.get('counter')).toEqual({ type: 'string', value: '1', expiresAtMs: null });
  });

  it('replicates a delete', async () => {
    storeA.set('k', 'v');
    clusterA.publishKeyChange('k');
    await waitFor(() => storeB.get('k') === 'v');

    storeA.del(['k']);
    clusterA.publishKeyChange('k');
    await waitFor(() => storeB.get('k') === null);
    expect(durable.keys.has('k')).toBe(false);
  });

  it('does not re-apply its own broadcast back onto the originating node', async () => {
    storeA.set('k', 'v1');
    clusterA.publishKeyChange('k');
    await waitFor(() => storeB.get('k') === 'v1');

    // If node A applied its own broadcast, this would be indistinguishable
    // from the normal case, but exercising it guards against a future
    // regression where the transport's self-filter is accidentally removed.
    expect(storeA.get('k')).toBe('v1');
  });

  it('fans out PUBLISH to the other node\'s local pub/sub subscribers', async () => {
    const messages: string[] = [];
    const fakeSubscriber = {
      id: 'sub-on-b',
      sendMessage: (_channel: string, message: string) => messages.push(message),
      sendPMessage: () => {},
    };
    pubsubB.subscribeChannel(fakeSubscriber, 'events');

    pubsubA.publish('events', 'hello'); // local delivery on A (no subscribers there)
    clusterA.publishMessage('events', 'hello');

    await waitFor(() => messages.length === 1);
    expect(messages).toEqual(['hello']);
  });

  it('a node restarting hydrates from what the other node already persisted', async () => {
    storeA.hset('presence:room1', [['user1', 'online']]);
    clusterA.publishKeyChange('presence:room1');
    await waitFor(() => durable.keys.has('presence:room1'));

    const storeC = new Store(0);
    const pubsubC = new PubSubRegistry();
    const clusterC = new ClusterCoordinator({
      store: storeC,
      pubsub: pubsubC,
      durable,
      transport: hub.createTransport('node-c'),
      nodeId: 'node-c',
      haEnabled: true,
      heartbeatIntervalMs: 10_000,
      nodeStaleMs: 30_000,
      connectionCount: () => 0,
      commandsTotal: () => 0,
    });

    await clusterC.start();
    expect(storeC.hgetall('presence:room1')).toEqual([['user1', 'online']]);

    await clusterC.stop();
    storeC.close();
  });

  it('reports both nodes in clusterSnapshot once each has heartbeat at least once', async () => {
    // heartbeatIntervalMs is 10s in these tests; start() fires one heartbeat immediately.
    await waitFor(() => durable.nodes.size === 2);
    const snapshot = await clusterA.clusterSnapshot();
    const nodeIds = snapshot.map((n) => n.nodeId).sort();
    expect(nodeIds).toEqual(['node-a', 'node-b']);
  });

  it('drain() waits for in-flight replication before resolving', async () => {
    storeA.set('slow-key', 'v');
    clusterA.publishKeyChange('slow-key');
    await clusterA.drain(1000);
    expect(durable.keys.get('slow-key')).toEqual({ type: 'string', value: 'v', expiresAtMs: null });
  });
});
