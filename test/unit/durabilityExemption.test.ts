import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { loadConfig } from '../../src/config.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { FakeDurableStore, FakeReplicationHub } from '../helpers/fakeCluster.js';

function fakeConn(): ConnectionContext {
  return {
    id: 'c', authenticated: true, failedAuthCount: 0, protover: 2, mode: 'command', clientName: null,
    remoteAddress: '127.0.0.1:0', sendMessage() {}, sendPMessage() {}, totalSubscriptions: () => 0,
  };
}

/**
 * DURABILITY_MIN_TTL_MS: keys whose remaining TTL is under the threshold
 * skip the Cosmos write entirely (removing the dominant rate-limit-churn RU
 * source), while still converging cross-node over Service Bus. Keys with no
 * TTL, or a TTL above the threshold, are still persisted.
 */
describe('short-TTL persistence exemption', () => {
  let durable: FakeDurableStore;
  let storeA: Store, storeB: Store;
  let clusterA: ClusterCoordinator, clusterB: ClusterCoordinator;
  let ctxA: CommandContext;

  beforeEach(async () => {
    durable = new FakeDurableStore();
    const hub = new FakeReplicationHub();
    const build = (nodeId: string, store: Store, pubsub: PubSubRegistry) =>
      new ClusterCoordinator({
        store, pubsub, durable, transport: hub.createTransport(nodeId), nodeId,
        haEnabled: true, heartbeatIntervalMs: 10_000, nodeStaleMs: 30_000,
        durabilityMinTtlMs: 60_000, connectionCount: () => 0, commandsTotal: () => 0,
      });
    storeA = new Store(0);
    const pubsubA = new PubSubRegistry();
    clusterA = build('node-a', storeA, pubsubA);
    ctxA = { store: storeA, pubsub: pubsubA, conn: fakeConn(), config: loadConfig({}), cluster: clusterA };
    storeB = new Store(0);
    clusterB = build('node-b', storeB, new PubSubRegistry());
    await Promise.all([clusterA.start(), clusterB.start()]);
  });

  afterEach(async () => {
    await Promise.all([clusterA.stop(), clusterB.stop()]);
    storeA.close();
    storeB.close();
  });

  it('does NOT persist a short-TTL SET, but still replicates it over Service Bus', async () => {
    dispatch(ctxA, ['SET', 'rl', 'v', 'PX', '5000']); // 5s remaining < 60s threshold
    await Promise.all([clusterA.drain(1000), clusterB.drain(1000)]);
    expect(durable.keys.has('rl')).toBe(false); // no Cosmos RU spent
    expect(storeB.get('rl')).toBe('v'); // peer still converged via Service Bus
  });

  it('persists a key with no TTL', async () => {
    dispatch(ctxA, ['SET', 'durable', 'v']);
    await clusterA.drain(1000);
    expect(durable.keys.get('durable')).toEqual({ type: 'string', value: 'v', expiresAtMs: null });
  });

  it('persists a key whose TTL is above the threshold', async () => {
    dispatch(ctxA, ['SET', 'longlived', 'v', 'EX', '120']); // 120s > 60s threshold
    await clusterA.drain(1000);
    expect(durable.keys.has('longlived')).toBe(true);
  });

  it('stops persisting a counter once EXPIRE makes its TTL short', async () => {
    dispatch(ctxA, ['INCR', 'c']); // no TTL yet -> persisted
    await clusterA.drain(1000);
    expect(durable.keys.has('c')).toBe(true);

    dispatch(ctxA, ['EXPIRE', 'c', '5']); // 5s TTL now < threshold
    dispatch(ctxA, ['INCR', 'c']); // this INCR sees the short TTL -> not persisted
    await Promise.all([clusterA.drain(1000), clusterB.drain(1000)]);

    // The durable contribution is frozen at the pre-EXPIRE value (1); the
    // later increment lives only in memory + Service Bus.
    expect((durable.keys.get('c') as { contributions?: Record<string, number> }).contributions).toEqual({ 'node-a': 1 });
    expect(storeB.get('c')).toBe('2'); // peer still saw both increments
  });

  it('EXPIRE-to-short still stamps the durable copy so it cannot outlive the key (F1)', async () => {
    // Regression (F1): doPublishTtlChange used to SKIP the Cosmos patch when
    // the new TTL was short. A key that was durable with no/long expiry then
    // kept its OLD expiry in Cosmos, so hydration/anti-entropy could
    // resurrect it long after every live node expired it.
    dispatch(ctxA, ['SET', 'k', 'v']); // durable, no TTL
    await clusterA.drain(1000);
    expect(durable.keys.get('k')?.expiresAtMs).toBeNull();

    dispatch(ctxA, ['EXPIRE', 'k', '5']); // 5s < 60s threshold — the tier transition
    await clusterA.drain(1000);

    const snap = durable.keys.get('k');
    expect(snap).toBeDefined(); // still persisted (value kept)
    expect(snap?.expiresAtMs).not.toBeNull(); // but now carries the short expiry -> Cosmos native TTL evicts it
    expect(snap?.expiresAtMs! - Date.now()).toBeLessThanOrEqual(5000);
  });
});
