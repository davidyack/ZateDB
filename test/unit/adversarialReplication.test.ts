import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { FakeDurableStore, FakeReplicationHub } from '../helpers/fakeCluster.js';

/**
 * The consistency model in docs/high-availability.md makes claims that only
 * mean something under an adversarial transport — one that reorders,
 * duplicates, or drops events. The default fake delivers synchronously and
 * in order, which can't falsify any of them. These tests drive the
 * documented guarantees against each failure mode explicitly.
 */
describe('replication convergence under an adversarial transport', () => {
  let durable: FakeDurableStore;
  let hub: FakeReplicationHub;
  let storeA: Store, storeB: Store;
  let clusterA: ClusterCoordinator, clusterB: ClusterCoordinator;

  function build(nodeId: string, store: Store): ClusterCoordinator {
    return new ClusterCoordinator({
      store,
      pubsub: new PubSubRegistry(),
      durable,
      transport: hub.createTransport(nodeId),
      nodeId,
      haEnabled: true,
      heartbeatIntervalMs: 10_000,
      nodeStaleMs: 30_000,
      connectionCount: () => 0,
      commandsTotal: () => 0,
    });
  }

  beforeEach(() => {
    durable = new FakeDurableStore();
    hub = new FakeReplicationHub();
    storeA = new Store(0);
    storeB = new Store(0);
  });

  afterEach(async () => {
    await Promise.all([clusterA?.stop(), clusterB?.stop()]);
    storeA.close();
    storeB.close();
  });

  it('two different-field writes converge even when delivered out of order (reorder)', async () => {
    hub.setPolicy({ hold: true }); // buffer, then release reversed
    clusterA = build('node-a', storeA);
    clusterB = build('node-b', storeB);
    await Promise.all([clusterA.start(), clusterB.start()]);

    storeA.hset('h', [['f1', 'v1']]);
    clusterA.publishHashFieldChange('h', [['f1', 'v1']], []);
    storeA.hset('h', [['f2', 'v2']]);
    clusterA.publishHashFieldChange('h', [['f2', 'v2']], []);
    await clusterA.drain(1000);

    hub.flushReversed(); // node B sees f2 then f1 — the opposite of the origin order

    expect(new Map(storeB.hgetall('h'))).toEqual(
      new Map([
        ['f1', 'v1'],
        ['f2', 'v2'],
      ]),
    );
  });

  it('a duplicated whole-key upsert is idempotent (at-least-once delivery)', async () => {
    hub.setPolicy({ duplicate: true });
    clusterA = build('node-a', storeA);
    clusterB = build('node-b', storeB);
    await Promise.all([clusterA.start(), clusterB.start()]);

    storeA.set('k', 'v');
    clusterA.publishKeyChange('k');
    await clusterA.drain(1000);

    expect(storeB.get('k')).toBe('v'); // applied twice, still just 'v'
  });

  it('a duplicated hash-field set is idempotent', async () => {
    hub.setPolicy({ duplicate: true });
    clusterA = build('node-a', storeA);
    clusterB = build('node-b', storeB);
    await Promise.all([clusterA.start(), clusterB.start()]);

    storeA.hset('h', [['f', 'v']]);
    clusterA.publishHashFieldChange('h', [['f', 'v']], []);
    await clusterA.drain(1000);

    expect(storeB.hgetall('h')).toEqual([['f', 'v']]); // exactly one field
  });

  it('a duplicated INCR contribution does not double-count (idempotent G-counter)', async () => {
    hub.setPolicy({ duplicate: true });
    clusterA = build('node-a', storeA);
    clusterB = build('node-b', storeB);
    await Promise.all([clusterA.start(), clusterB.start()]);

    storeA.incr('rl', 'node-a');
    clusterA.publishIncrement('rl');
    await clusterA.drain(1000);

    // The increment event was delivered to B twice; merging by max (not
    // adding) means B still shows 1, not 2.
    expect(storeB.get('rl')).toBe('1');
  });

  it('INCR contributions delivered out of order still converge (reorder)', async () => {
    hub.setPolicy({ hold: true });
    clusterA = build('node-a', storeA);
    clusterB = build('node-b', storeB);
    await Promise.all([clusterA.start(), clusterB.start()]);

    storeA.incr('rl', 'node-a'); // total 1
    clusterA.publishIncrement('rl');
    storeA.incr('rl', 'node-a'); // total 2
    clusterA.publishIncrement('rl');
    await clusterA.drain(1000);

    hub.flushReversed(); // B sees the cumulative "2" before the "1"

    // Max-merge means the older "1" can't undo the newer "2".
    expect(storeB.get('rl')).toBe('2');
  });

  it('a dropped event leaves a node stale until anti-entropy repairs it (drop + reconcile)', async () => {
    hub.setPolicy({ drop: (event, toNodeId) => toNodeId === 'node-b' && event.key === 'missed' });
    clusterA = build('node-a', storeA);
    clusterB = build('node-b', storeB);
    await Promise.all([clusterA.start(), clusterB.start()]);

    storeA.set('missed', 'v');
    clusterA.publishKeyChange('missed'); // durable gets it; delivery to B is dropped
    await clusterA.drain(1000);
    // Guarantee the durable watermark is unambiguously newer than B's last sync.
    durable.setUpdatedAt('missed', Date.now() + 1_000_000);

    expect(storeB.exists('missed')).toBe(false); // B genuinely missed the event

    await clusterB.reconcile(); // the backstop
    expect(storeB.get('missed')).toBe('v'); // converged
  });
});
