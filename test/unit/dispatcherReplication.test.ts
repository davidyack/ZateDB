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
    failedAuthCount: 0,
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
    expect(durable.keys.get('new-hash')).toEqual({ type: 'hash', fields: { f: 'v' }, expiresAtMs: null });
    expect(durable.keys.get('new-zset')).toEqual({ type: 'sortedset', members: { member: 1 }, expiresAtMs: null });
  });

  it('a partial HDEL replicates only the removed field, leaving the rest of the hash in the durable store untouched', async () => {
    dispatch(ctx, ['HSET', 'presence:room1', 'user1', 'online', 'user2', 'online']);
    await cluster.drain(500);
    expect(durable.keys.get('presence:room1')).toEqual({
      type: 'hash',
      fields: { user1: 'online', user2: 'online' },
      expiresAtMs: null,
    });

    dispatch(ctx, ['HDEL', 'presence:room1', 'user1']);
    await cluster.drain(500);
    expect(durable.keys.get('presence:room1')).toEqual({ type: 'hash', fields: { user2: 'online' }, expiresAtMs: null });
  });

  it('HDEL removing the last field replicates a field-level delete, not a whole-key delete', async () => {
    // Deliberately NOT a whole-key delete: another node could still hold a
    // field on this same key that hasn't replicated here yet (see the
    // two-node test below), and a whole-key delete would destroy it. An
    // empty hash entry lingering in the durable store is harmless — no
    // exposed command can tell "hash exists with zero fields" apart from
    // "key doesn't exist" (see docs/high-availability.md).
    dispatch(ctx, ['HSET', 'presence:room2', 'user1', 'online']);
    await cluster.drain(500);
    expect(durable.keys.has('presence:room2')).toBe(true);

    dispatch(ctx, ['HDEL', 'presence:room2', 'user1']);
    await cluster.drain(500);
    expect(durable.keys.get('presence:room2')).toEqual({ type: 'hash', fields: {}, expiresAtMs: null });
    expect(ctx.store.hgetall('presence:room2')).toEqual([]); // locally, this node still correctly reports the key as empty/gone
  });

  it('a partial ZREMRANGEBYSCORE replicates only the removed members, leaving the rest of the set in the durable store untouched', async () => {
    const now = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    dispatch(ctx, ['ZADD', 'guard:w1', String(now - dayMs - 1), 'too-old', String(now - 1000), 'recent']);
    await cluster.drain(500);
    expect(durable.keys.get('guard:w1')).toEqual({
      type: 'sortedset',
      members: { 'too-old': now - dayMs - 1, recent: now - 1000 },
      expiresAtMs: null,
    });

    dispatch(ctx, ['ZREMRANGEBYSCORE', 'guard:w1', '0', String(now - dayMs)]);
    await cluster.drain(500);
    expect(durable.keys.get('guard:w1')).toEqual({ type: 'sortedset', members: { recent: now - 1000 }, expiresAtMs: null });
  });

  it('ZREMRANGEBYSCORE removing the last member replicates a member-level delete, not a whole-key delete', async () => {
    dispatch(ctx, ['ZADD', 'guard:w2', '1', 'evt']);
    await cluster.drain(500);
    expect(durable.keys.has('guard:w2')).toBe(true);

    dispatch(ctx, ['ZREMRANGEBYSCORE', 'guard:w2', '-inf', '+inf']);
    await cluster.drain(500);
    expect(durable.keys.get('guard:w2')).toEqual({ type: 'sortedset', members: {}, expiresAtMs: null });
  });

  it('replicates a genuine DEL of an existing key', async () => {
    dispatch(ctx, ['SET', 'to-delete', 'v']);
    await cluster.drain(500);
    expect(durable.keys.has('to-delete')).toBe(true);

    dispatch(ctx, ['DEL', 'to-delete']);
    await cluster.drain(500);
    expect(durable.keys.has('to-delete')).toBe(false);
  });

  it('replicates EXPIRE as a TTL-only update, preserving hash fields in the durable store', async () => {
    // EXPIRE/PEXPIRE must NOT ship a whole-entry snapshot: doing so would
    // overwrite peers with this node's entire entry, clobbering field/member
    // writes they hold but this node hasn't received. The durable snapshot
    // must keep its fields and just gain an expiry.
    dispatch(ctx, ['HSET', 'h', 'f1', 'v1', 'f2', 'v2']);
    await cluster.drain(500);
    dispatch(ctx, ['EXPIRE', 'h', '60']);
    await cluster.drain(500);

    const snap = durable.keys.get('h');
    expect(snap?.type).toBe('hash');
    if (snap?.type === 'hash') {
      expect(snap.fields).toEqual({ f1: 'v1', f2: 'v2' }); // fields survive
      expect(snap.expiresAtMs).not.toBeNull(); // and the TTL was applied
    }
  });

  it('does not replicate a no-op EXPIRE against a key this node never had', async () => {
    dispatch(ctx, ['EXPIRE', 'never-existed', '60']);
    await cluster.drain(500);
    expect(durable.keys.size).toBe(0);
  });

  it('does not replicate an EXPIRE whose flag condition was not met (reply :0)', async () => {
    dispatch(ctx, ['SET', 'k', 'v']); // no TTL yet
    await cluster.drain(500);
    // XX requires an existing TTL; there is none, so this changes nothing.
    dispatch(ctx, ['EXPIRE', 'k', '60', 'XX']);
    await cluster.drain(500);
    // The durable snapshot is still the plain SET (no expiry patched in).
    expect(durable.keys.get('k')).toEqual({ type: 'string', value: 'v', expiresAtMs: null });
  });

  it('coalesces a burst of same-key whole-key writes into far fewer durable writes', async () => {
    // Hold the first Cosmos write open so the rest of the burst queues
    // behind it, then confirm the queued writes collapsed to just the
    // latest one (one in-flight + one coalesced), not all five.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPutKey = durable.putKey.bind(durable);
    let putCalls = 0;
    durable.putKey = async (key, entry) => {
      putCalls++;
      if (putCalls === 1) await firstGate;
      await originalPutKey(key, entry);
    };

    for (let i = 0; i < 5; i++) dispatch(ctx, ['SET', 'hot', `v${i}`]);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the burst queue up behind the gated first write
    releaseFirst();
    await cluster.drain(1000);

    expect(putCalls).toBe(2); // first (gated) + one coalesced latest, not 5
    expect(durable.keys.get('hot')).toEqual({ type: 'string', value: 'v4', expiresAtMs: null });
  });

  it('coalesces a burst of INCRs into far fewer durable contribution writes', async () => {
    // The hot-counter path: N rapid INCRs from one node ship one in-flight
    // cumulative-total write plus one coalesced latest, not N — and the
    // final durable contribution is the running total.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPutIncrement = durable.putIncrement.bind(durable);
    let incrCalls = 0;
    durable.putIncrement = async (key, origin, total) => {
      incrCalls++;
      if (incrCalls === 1) await firstGate;
      await originalPutIncrement(key, origin, total);
    };

    for (let i = 0; i < 5; i++) dispatch(ctx, ['INCR', 'rl']);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the burst queue behind the gated first write
    releaseFirst();
    await cluster.drain(1000);

    expect(incrCalls).toBe(2); // first (gated) + one coalesced latest, not 5
    expect(ctx.store.get('rl')).toBe('5');
    expect((durable.keys.get('rl') as { contributions?: Record<string, number> }).contributions).toEqual({ 'node-a': 5 });
  });

  it('coalesces a burst of HSETs on the same key into far fewer durable patches', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPut = durable.putHashFields.bind(durable);
    let patchCalls = 0;
    durable.putHashFields = async (key, fields) => {
      patchCalls++;
      if (patchCalls === 1) await firstGate;
      await originalPut(key, fields);
    };

    // Seed one field (gated), then a burst of distinct fields queues behind it.
    dispatch(ctx, ['HSET', 'presence', 'u0', 'online']);
    for (let i = 1; i < 6; i++) dispatch(ctx, ['HSET', 'presence', `u${i}`, 'online']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await cluster.drain(1000);

    expect(patchCalls).toBe(2); // first (gated) + one merged patch of the other five, not six
    expect(durable.keys.get('presence')).toEqual({
      type: 'hash',
      fields: { u0: 'online', u1: 'online', u2: 'online', u3: 'online', u4: 'online', u5: 'online' },
      expiresAtMs: null,
    });
  });

  it('merges a queued HSET then HDEL of the same field to a net delete', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPut = durable.putHashFields.bind(durable);
    durable.putHashFields = async (key, fields) => {
      await firstGate; // hold every hash write so the flap queues and coalesces
      await originalPut(key, fields);
    };

    dispatch(ctx, ['HSET', 'presence', 'gate', 'x']); // gated in-flight
    dispatch(ctx, ['HSET', 'presence', 'u1', 'online']); // queued
    dispatch(ctx, ['HDEL', 'presence', 'u1']); // queued — folds into the set above → net delete
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await cluster.drain(1000);

    const snap = durable.keys.get('presence') as { fields: Record<string, string> };
    expect(snap.fields.u1).toBeUndefined(); // the flap collapsed to nothing durably
    expect(snap.fields.gate).toBe('x');
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

/**
 * Two-node reproduction of the exact failure scenario a code review
 * caught: HDEL used to replicate every field name the client *asked* to
 * delete, not the ones actually removed locally. A client naming a field
 * this node never had (because another node's concurrent HSET for it
 * hadn't replicated in yet) would broadcast a delete for that field too —
 * destroying the other node's real value.
 */
describe('HDEL only replicates fields that actually existed on this node (two nodes)', () => {
  let durable: FakeDurableStore;
  let storeA: Store, storeB: Store;
  let clusterA: ClusterCoordinator, clusterB: ClusterCoordinator;
  let ctxA: CommandContext, ctxB: CommandContext;

  beforeEach(async () => {
    durable = new FakeDurableStore();
    const hub = new FakeReplicationHub();

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

    storeA = new Store(0);
    const pubsubA = new PubSubRegistry();
    clusterA = build('node-a', storeA, pubsubA);
    ctxA = { store: storeA, pubsub: pubsubA, conn: fakeConn(), config: loadConfig({}), cluster: clusterA };

    storeB = new Store(0);
    const pubsubB = new PubSubRegistry();
    clusterB = build('node-b', storeB, pubsubB);
    ctxB = { store: storeB, pubsub: pubsubB, conn: fakeConn(), config: loadConfig({}), cluster: clusterB };

    await Promise.all([clusterA.start(), clusterB.start()]);
  });

  afterEach(async () => {
    await Promise.all([clusterA.stop(), clusterB.stop()]);
    storeA.close();
    storeB.close();
  });

  it("naming a field on HDEL that only exists on the other node doesn't delete it there", async () => {
    dispatch(ctxA, ['HSET', 'h', 'a', 'v1']); // node A has field 'a' locally now
    dispatch(ctxB, ['HSET', 'h', 'b', 'v2']); // node B has field 'b' locally now — its replication to A is fire-and-forget and hasn't been delivered yet (delivery always takes at least one microtask tick; nothing here has awaited yet)

    // Node A defensively deletes both names — at this exact moment, before
    // any `await`, node A's local store only has 'a' (B's HSET for 'b'
    // hasn't arrived): this is the race window the fix has to get right.
    dispatch(ctxA, ['HDEL', 'h', 'a', 'b']);

    await Promise.all([clusterA.drain(1000), clusterB.drain(1000)]); // let everything (including B's now-delivered HSET) settle

    expect(storeB.hgetall('h')).toEqual([['b', 'v2']]); // node B's field survives
    expect(storeA.hgetall('h')).toEqual([['b', 'v2']]); // and converges onto node A too, once B's HSET arrives
    expect(durable.keys.get('h')).toEqual({ type: 'hash', fields: { b: 'v2' }, expiresAtMs: null });
  });

  it("an EXPIRE on one node doesn't clobber a field the other node wrote but hasn't replicated yet", async () => {
    // The core of finding #2: EXPIRE used to replicate as a whole-entry
    // upsert. Node A snapshotting its entire hash and shipping it on EXPIRE
    // would overwrite node B's copy, destroying field 'b' (which A hadn't
    // received yet). TTL-only replication ships just the expiry, so 'b'
    // survives.
    dispatch(ctxA, ['HSET', 'h', 'a', 'v1']); // A has 'a'
    dispatch(ctxB, ['HSET', 'h', 'b', 'v2']); // B has 'b'; not delivered to A yet (no await has run)
    dispatch(ctxA, ['EXPIRE', 'h', '600']); // A expires the hash while it only knows about 'a'

    await Promise.all([clusterA.drain(1000), clusterB.drain(1000)]);

    // Both fields survive everywhere, and the TTL landed.
    expect(new Map(storeA.hgetall('h'))).toEqual(new Map([['a', 'v1'], ['b', 'v2']]));
    expect(new Map(storeB.hgetall('h'))).toEqual(new Map([['a', 'v1'], ['b', 'v2']]));
    const snap = durable.keys.get('h');
    expect(snap?.type).toBe('hash');
    if (snap?.type === 'hash') {
      expect(snap.fields).toEqual({ a: 'v1', b: 'v2' });
      expect(snap.expiresAtMs).not.toBeNull();
    }
  });
});
