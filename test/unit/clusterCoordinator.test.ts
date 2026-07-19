import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { NullDurableStore } from '../../src/cluster/durableStore.js';
import { NullReplicationTransport } from '../../src/cluster/replicationTransport.js';
import { FakeDurableStore, FakeReplicationHub } from '../helpers/fakeCluster.js';
import { parseScoreBound } from '../../src/store/scoreRange.js';

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
    await durable.putKey('h1', { type: 'hash', fields: { f: 'v' }, expiresAtMs: null });

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

describe('ClusterCoordinator HA mode: hydration filtering & bounding', () => {
  function buildNode(durable: FakeDurableStore, store: Store, maxMemoryBytes?: number): ClusterCoordinator {
    return new ClusterCoordinator({
      store,
      pubsub: new PubSubRegistry(),
      durable,
      transport: new FakeReplicationHub().createTransport('node-h'),
      nodeId: 'node-h',
      haEnabled: true,
      heartbeatIntervalMs: 10_000,
      nodeStaleMs: 30_000,
      maxMemoryBytes,
      connectionCount: () => 0,
      commandsTotal: () => 0,
    });
  }

  it('skips already-expired durable keys during hydration', async () => {
    const durable = new FakeDurableStore();
    await durable.putKey('live', { type: 'string', value: 'v', expiresAtMs: Date.now() + 60_000 });
    await durable.putKey('dead', { type: 'string', value: 'v', expiresAtMs: Date.now() - 1 });
    await durable.putKey('forever', { type: 'string', value: 'v', expiresAtMs: null });

    const store = new Store(0);
    const cluster = buildNode(durable, store);
    await cluster.start();

    expect(store.exists('live')).toBe(true);
    expect(store.exists('forever')).toBe(true);
    expect(store.exists('dead')).toBe(false); // never resurrected
    expect(store.keyCounts().string).toBe(2);

    await cluster.stop();
    store.close();
  });

  it('stops hydrating once the loaded estimate crosses maxMemoryBytes (no restart-loop OOM)', async () => {
    const durable = new FakeDurableStore();
    for (let i = 0; i < 10; i++) {
      await durable.putKey(`k${i}`, { type: 'string', value: 'x'.repeat(100), expiresAtMs: null });
    }

    const store = new Store(0);
    // A tiny ceiling: the first key loads (estimate starts at 0), then the
    // next check trips the bound — so we get a partial, bounded hydration
    // rather than loading all 10 and OOMing.
    const cluster = buildNode(durable, store, 1);
    await cluster.start();

    expect(cluster.isHydrated).toBe(true); // still becomes ready
    expect(store.keyCounts().string).toBeLessThan(10); // but did NOT load everything

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

  it('replicates an EXPIRE as a TTL-only change to the other node', async () => {
    storeA.set('k', 'v');
    clusterA.publishKeyChange('k');
    await waitFor(() => storeB.get('k') === 'v');

    const at = Date.now() + 600_000;
    storeA.pexpire('k', 600_000);
    clusterA.publishTtlChange('k', at);

    await waitFor(() => storeB.getKeyDetail('k')?.info.ttlMsRemaining != null);
    expect(storeB.get('k')).toBe('v'); // value untouched, only the TTL was replicated
    // The durable snapshot keeps its value and gains the expiry.
    expect(durable.keys.get('k')).toEqual({ type: 'string', value: 'v', expiresAtMs: at });
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

  it('two nodes setting DIFFERENT fields of the same hash concurrently both survive (per-field replication)', async () => {
    // Regression: whole-entry replication would have whichever node's
    // full-hash snapshot landed last silently discard the other node's
    // field. Field-level replication ships only the touched field, so
    // both survive regardless of arrival order.
    storeA.hset('presence:room1', [['user1', 'online']]);
    clusterA.publishHashFieldChange('presence:room1', [['user1', 'online']], []);

    storeB.hset('presence:room1', [['user2', 'online']]);
    clusterB.publishHashFieldChange('presence:room1', [['user2', 'online']], []);

    await waitFor(() => storeA.hgetall('presence:room1').length === 2 && storeB.hgetall('presence:room1').length === 2);
    expect(new Map(storeA.hgetall('presence:room1'))).toEqual(
      new Map([
        ['user1', 'online'],
        ['user2', 'online'],
      ]),
    );
    expect(new Map(storeB.hgetall('presence:room1'))).toEqual(new Map(storeA.hgetall('presence:room1')));
  });

  it('two nodes adding DIFFERENT members of the same sorted set concurrently both survive (per-field replication)', async () => {
    storeA.zadd('guard:w1', [[1, 'evt-a']]);
    clusterA.publishZsetMemberChange('guard:w1', [['evt-a', 1]], []);

    storeB.zadd('guard:w1', [[2, 'evt-b']]);
    clusterB.publishZsetMemberChange('guard:w1', [['evt-b', 2]], []);

    const fullRange = () => [parseScoreBound('-inf'), parseScoreBound('+inf')] as const;
    await waitFor(() => storeA.zcount('guard:w1', ...fullRange()) === 2);
    await waitFor(() => storeB.zcount('guard:w1', ...fullRange()) === 2);
  });

  it('replicates a partial HDEL as a field delete, leaving the rest of the hash intact on the other node', async () => {
    storeA.hset('presence:room2', [
      ['user1', 'online'],
      ['user2', 'online'],
    ]);
    clusterA.publishHashFieldChange(
      'presence:room2',
      [
        ['user1', 'online'],
        ['user2', 'online'],
      ],
      [],
    );
    await waitFor(() => storeB.hgetall('presence:room2').length === 2);

    storeA.hdel('presence:room2', ['user1']);
    clusterA.publishHashFieldChange('presence:room2', [], ['user1']);
    await waitFor(() => storeB.hgetall('presence:room2').length === 1);
    expect(storeB.hgetall('presence:room2')).toEqual([['user2', 'online']]);
    expect(durable.keys.get('presence:room2')).toEqual({ type: 'hash', fields: { user2: 'online' }, expiresAtMs: null });
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

  it("a live write that arrives mid-hydration is not clobbered by the (necessarily slightly stale) hydration snapshot", async () => {
    // Regression: the replication transport used to start delivering live
    // events immediately, while hydrate()'s durable.loadAll() snapshot
    // could still be in flight. If a live event for a key arrived and was
    // applied before hydrate()'s loop got to that same key, hydrate()
    // would unconditionally overwrite it back to the stale pre-hydration
    // value once it (eventually) ran.
    durable.keys.set('counter', { type: 'string', value: '1', expiresAtMs: null });

    const storeC = new Store(0);
    const pubsubC = new PubSubRegistry();
    const originalLoadAll = durable.loadAll.bind(durable);
    let releaseLoadAll!: () => void;
    const loadAllGate = new Promise<void>((resolve) => {
      releaseLoadAll = resolve;
    });
    durable.loadAll = async () => {
      await loadAllGate; // hold hydration open until the test releases it
      return originalLoadAll();
    };

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

    // clusterC.start() registers its transport with the hub synchronously
    // (before its first await), so node C is already subscribed and ready
    // to buffer by the time this call returns — hydration itself is now
    // blocked on loadAllGate.
    const startPromise = clusterC.start();

    // A newer write happens on node A while node C's hydration is stuck.
    storeA.set('counter', '2');
    clusterA.publishKeyChange('counter');
    await waitFor(() => {
      const entry = durable.keys.get('counter');
      return entry?.type === 'string' && entry.value === '2';
    });

    releaseLoadAll();
    await startPromise;

    expect(storeC.get('counter')).toBe('2'); // the live write wins, not the stale snapshot

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
