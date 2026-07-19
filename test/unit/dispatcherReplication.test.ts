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
    id: 'test-conn',
    authenticated: true,
    mode: 'command',
    clientName: null,
    remoteAddress: '127.0.0.1:0',
    sendMessage() {},
    sendPMessage() {},
    totalSubscriptions: () => 0,
  };
}

/**
 * These tests exercise the dispatcher's cluster-replication decision
 * directly (not through a RESP client), against a real ClusterCoordinator
 * wired to fake Cosmos DB / Service Bus doubles, since the bugs they guard
 * against live specifically in *when* the dispatcher decides to replicate
 * a key, not in the RESP protocol layer above it.
 */
describe('dispatcher cluster replication correctness', () => {
  let durable: FakeDurableStore;
  let store: Store;
  let pubsub: PubSubRegistry;
  let cluster: ClusterCoordinator;
  let ctx: CommandContext;

  beforeEach(async () => {
    durable = new FakeDurableStore();
    const hub = new FakeReplicationHub();
    store = new Store(0);
    pubsub = new PubSubRegistry();
    cluster = new ClusterCoordinator({
      store,
      pubsub,
      durable,
      transport: hub.createTransport('node-a'),
      nodeId: 'node-a',
      haEnabled: true,
      heartbeatIntervalMs: 10_000,
      nodeStaleMs: 30_000,
      connectionCount: () => 0,
      commandsTotal: () => 0,
    });
    await cluster.start();
    ctx = { store, pubsub, conn: fakeConn(), config: loadConfig({}), cluster };
  });

  afterEach(async () => {
    await cluster.stop();
    store.close();
  });

  it('does not replicate a no-op DEL/EXPIRE/HDEL/ZREMRANGEBYSCORE against a key this node never had', async () => {
    // Regression: these used to unconditionally call publishKeyChange for
    // every candidate key regardless of whether anything actually
    // changed locally. Since publishKeyChange treats "key absent" as "key
    // was just deleted," this broadcast a phantom delete for a key that
    // might genuinely exist on another node but hadn't replicated here
    // yet — silently destroying real data cluster-wide.
    dispatch(ctx, ['DEL', 'never-existed-1', 'never-existed-2']);
    dispatch(ctx, ['EXPIRE', 'never-existed-3', '10']);
    dispatch(ctx, ['PEXPIRE', 'never-existed-4', '10000']);
    dispatch(ctx, ['HDEL', 'never-existed-5', 'field']);
    dispatch(ctx, ['ZREMRANGEBYSCORE', 'never-existed-6', '-inf', '+inf']);

    await cluster.drain(500);
    expect(durable.keys.size).toBe(0);
  });

  it('still replicates SET/INCR/HSET/ZADD creating a brand new key', async () => {
    dispatch(ctx, ['SET', 'new-string', 'v']);
    dispatch(ctx, ['INCR', 'new-counter']);
    dispatch(ctx, ['HSET', 'new-hash', 'f', 'v']);
    dispatch(ctx, ['ZADD', 'new-zset', '1', 'member']);

    await cluster.drain(500);
    expect(durable.keys.has('new-string')).toBe(true);
    expect(durable.keys.has('new-counter')).toBe(true);
    expect(durable.keys.has('new-hash')).toBe(true);
    expect(durable.keys.has('new-zset')).toBe(true);
  });

  it('replicates a genuine DEL of an existing key', async () => {
    dispatch(ctx, ['SET', 'to-delete', 'v']);
    await cluster.drain(500);
    expect(durable.keys.has('to-delete')).toBe(true);

    dispatch(ctx, ['DEL', 'to-delete']);
    await cluster.drain(500);
    expect(durable.keys.has('to-delete')).toBe(false);
  });

  it('replicates sequential writes to the same key in call order, even if their network round trips would otherwise finish out of order', async () => {
    // Regression: two independent fire-and-forget publishes for the same
    // key raced on their own Cosmos/Service Bus round trips, so a slower
    // earlier write could land *after* a faster later one and leave the
    // cluster converged on a stale value even though this node's own
    // writes happened in the opposite, correct order.
    let firstPutResolve!: () => void;
    const firstPutGate = new Promise<void>((resolve) => {
      firstPutResolve = resolve;
    });
    const originalPutKey = durable.putKey.bind(durable);
    let callCount = 0;
    durable.putKey = async (key, entry) => {
      callCount++;
      if (callCount === 1) await firstPutGate; // the first SET's Cosmos write is artificially slow
      await originalPutKey(key, entry);
    };

    dispatch(ctx, ['SET', 'race-key', 'v1']);
    dispatch(ctx, ['SET', 'race-key', 'v2']);
    dispatch(ctx, ['SET', 'race-key', 'v3']);

    // Without per-key serialization, v2/v3's puts would already have
    // completed by now (nothing is blocking them) and durable would show
    // "v3" — the assertion below wouldn't distinguish that case, so first
    // confirm nothing has landed yet, proving v2/v3 are genuinely queued
    // behind v1, not just fast.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(durable.keys.has('race-key')).toBe(false);

    firstPutResolve();
    await cluster.drain(1000);
    expect(durable.keys.get('race-key')).toEqual({ type: 'string', value: 'v3', expiresAtMs: null });
  });
});
