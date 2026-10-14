import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { loadConfig } from '../../src/config.js';
import type { RespValue } from '../../src/resp/types.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { validateReplicationEvent } from '../../src/cluster/types.js';
import { entryToSnapshot, snapshotToEntry } from '../../src/cluster/snapshot.js';
import { formatRedisFloat, parseRedisFloat } from '../../src/store/floatCounter.js';
import { standaloneCluster } from '../helpers/cluster.js';
import { FakeDurableStore, FakeReplicationHub } from '../helpers/fakeCluster.js';
import { scriptCache } from '../../src/scripting/scriptCache.js';

const config = loadConfig({});

function fakeConn(): ConnectionContext {
  return {
    id: 'test-conn',
    authenticated: true,
    failedAuthCount: 0,
    protover: 2,
    mode: 'command',
    clientName: null,
    remoteAddress: '127.0.0.1:0',
    sendMessage() {},
    sendPMessage() {},
    totalSubscriptions: () => 0,
  };
}

function run(ctx: CommandContext, argv: string[]): RespValue {
  return dispatch(ctx, argv).frames[0];
}

const bulk = (value: string | null): RespValue => ({ type: 'bulk', value });

describe('float formatting', () => {
  it('formats like Redis: shortest digits, no exponent, no trailing zeros', () => {
    expect(formatRedisFloat(10.5)).toBe('10.5');
    expect(formatRedisFloat(5000)).toBe('5000');
    expect(formatRedisFloat(0.1)).toBe('0.1');
    expect(formatRedisFloat(-0)).toBe('0');
    expect(formatRedisFloat(-2.5)).toBe('-2.5');
    expect(formatRedisFloat(1e21)).toBe('1000000000000000000000');
    expect(formatRedisFloat(1.5e-7)).toBe('0.00000015');
    expect(formatRedisFloat(-1.25e22)).toBe('-12500000000000000000000');
    expect(formatRedisFloat(0.1 + 0.2)).toBe('0.30000000000000004'); // 17 significant digits max
  });

  it('parses only finite decimal floats', () => {
    expect(parseRedisFloat('1.5')).toBe(1.5);
    expect(parseRedisFloat('-.5')).toBe(-0.5);
    expect(parseRedisFloat('+3')).toBe(3);
    expect(parseRedisFloat('2e3')).toBe(2000);
    for (const bad of ['', ' 1', 'abc', 'inf', 'nan', '1e400', '0x10', '1.2.3']) expect(parseRedisFloat(bad)).toBeNull();
  });
});

describe('HMGET / HINCRBYFLOAT (standalone)', () => {
  let ctx: CommandContext;
  beforeEach(() => {
    const store = new Store(0);
    const pubsub = new PubSubRegistry();
    ctx = { store, pubsub, conn: fakeConn(), config, cluster: standaloneCluster(store, pubsub) };
  });
  afterEach(() => {
    ctx.store.close();
    scriptCache.flush();
  });

  it('HMGET returns one entry per field in order, nil for missing fields and keys', () => {
    run(ctx, ['HSET', 'h', 'a', '1', 'c', '3']);
    expect(run(ctx, ['HMGET', 'h', 'c', 'b', 'a', 'a'])).toEqual({ type: 'array', value: [bulk('3'), bulk(null), bulk('1'), bulk('1')] });
    expect(run(ctx, ['HMGET', 'missing', 'x', 'y'])).toEqual({ type: 'array', value: [bulk(null), bulk(null)] });
  });

  it('HMGET errors on arity and on a non-hash key', () => {
    expect(run(ctx, ['HMGET', 'h'])).toEqual({ type: 'error', value: "ERR wrong number of arguments for 'hmget' command" });
    run(ctx, ['SET', 's', 'v']);
    expect(run(ctx, ['HMGET', 's', 'f']).type).toBe('error');
  });

  it('HINCRBYFLOAT creates, adds, debits, and formats like Redis', () => {
    expect(run(ctx, ['HINCRBYFLOAT', 'bal', 'credits', '10.5'])).toEqual(bulk('10.5'));
    expect(run(ctx, ['HINCRBYFLOAT', 'bal', 'credits', '0.1'])).toEqual(bulk('10.6'));
    expect(run(ctx, ['HINCRBYFLOAT', 'bal', 'credits', '-5.6'])).toEqual(bulk('5'));
    expect(run(ctx, ['HINCRBYFLOAT', 'bal', 'credits', '5.0e3'])).toEqual(bulk('5005'));
    expect(run(ctx, ['HMGET', 'bal', 'credits'])).toEqual({ type: 'array', value: [bulk('5005')] });
  });

  it('HINCRBYFLOAT builds on a value HSET left, and HSET resets a counter', () => {
    run(ctx, ['HSET', 'bal', 'credits', '100']);
    expect(run(ctx, ['HINCRBYFLOAT', 'bal', 'credits', '-0.25'])).toEqual(bulk('99.75'));
    run(ctx, ['HSET', 'bal', 'credits', '7']);
    expect(run(ctx, ['HINCRBYFLOAT', 'bal', 'credits', '1'])).toEqual(bulk('8'));
    run(ctx, ['HDEL', 'bal', 'credits']);
    expect(run(ctx, ['HINCRBYFLOAT', 'bal', 'credits', '2'])).toEqual(bulk('2'));
  });

  it('HINCRBYFLOAT rejects bad input with Redis errors and leaves state unchanged', () => {
    run(ctx, ['HSET', 'h', 'name', 'alice', 'n', '1']);
    expect(run(ctx, ['HINCRBYFLOAT', 'h', 'name', '1'])).toEqual({ type: 'error', value: 'ERR hash value is not a float' });
    expect(run(ctx, ['HINCRBYFLOAT', 'h', 'n', 'abc'])).toEqual({ type: 'error', value: 'ERR value is not a valid float' });
    expect(run(ctx, ['HINCRBYFLOAT', 'h', 'n'])).toEqual({ type: 'error', value: "ERR wrong number of arguments for 'hincrbyfloat' command" });
    run(ctx, ['HINCRBYFLOAT', 'h', 'big', '1.7e308']);
    expect(run(ctx, ['HINCRBYFLOAT', 'h', 'big', '1.7e308'])).toEqual({ type: 'error', value: 'ERR increment would produce NaN or Infinity' });
    expect(run(ctx, ['HMGET', 'h', 'n', 'big'])).toEqual({ type: 'array', value: [bulk('1'), bulk(formatRedisFloat(1.7e308))] });
    run(ctx, ['SET', 's', 'v']);
    expect(run(ctx, ['HINCRBYFLOAT', 's', 'f', '1'])).toMatchObject({ type: 'error', value: expect.stringContaining('WRONGTYPE') });
  });

  it('works from redis.call inside EVAL; a missing HMGET field is false in Lua', () => {
    // Shape of a token-bucket read: HMGET tokens/ts, default when absent.
    const bucket = `
      local v = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
      local tokens = v[1]
      if tokens == false then tokens = 'none' end
      local ts = v[2]
      if ts == false then ts = 'none' end
      return {tokens, ts, #v}`;
    expect(run(ctx, ['EVAL', bucket, '1', 'tb'])).toEqual({ type: 'array', value: [bulk('none'), bulk('none'), { type: 'integer', value: 2 }] });
    run(ctx, ['HSET', 'tb', 'tokens', '4']);
    expect(run(ctx, ['EVAL', bucket, '1', 'tb'])).toEqual({ type: 'array', value: [bulk('4'), bulk('none'), { type: 'integer', value: 2 }] });

    // Shape of a balance gate: debit, return the new balance string.
    const debit = `return redis.call('HINCRBYFLOAT', KEYS[1], 'balance', ARGV[1])`;
    run(ctx, ['HSET', 'gate', 'balance', '10']);
    expect(run(ctx, ['EVAL', debit, '1', 'gate', '-2.5'])).toEqual(bulk('7.5'));
    expect(run(ctx, ['EVAL', debit, '1', 'gate', '-0.1'])).toEqual(bulk('7.4'));
  });
});

describe('HINCRBYFLOAT cluster replication', () => {
  let durable: FakeDurableStore;
  let hub: FakeReplicationHub;
  const stores: Store[] = [];
  const clusters: ClusterCoordinator[] = [];

  function node(nodeId: string): { store: Store; cluster: ClusterCoordinator; ctx: CommandContext } {
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
    stores.push(store);
    clusters.push(cluster);
    return { store, cluster, ctx: { store, pubsub, conn: fakeConn(), config, cluster } };
  }

  const balance = (ctx: CommandContext): RespValue => run(ctx, ['HMGET', 'gate', 'balance']);

  beforeEach(() => {
    durable = new FakeDurableStore();
    hub = new FakeReplicationHub();
  });
  afterEach(async () => {
    await Promise.all(clusters.splice(0).map((c) => c.stop()));
    for (const s of stores.splice(0)) s.close();
    scriptCache.flush();
  });

  it('concurrent debits on different nodes both land (no lost update), on every node and durably', async () => {
    hub.setPolicy({ hold: true }); // both debits happen before either node hears of the other
    const a = node('node-a');
    const b = node('node-b');
    await Promise.all([a.cluster.start(), b.cluster.start()]);

    // Seed the balance on A and let it reach B first.
    run(a.ctx, ['HSET', 'gate', 'balance', '100']);
    await a.cluster.drain(1000);
    hub.flush();
    expect(balance(b.ctx)).toEqual({ type: 'array', value: [bulk('100')] });

    // Same instant, different nodes, via the script path the app uses.
    const debit = `return redis.call('HINCRBYFLOAT', KEYS[1], 'balance', ARGV[1])`;
    expect(run(a.ctx, ['EVAL', debit, '1', 'gate', '-30.5'])).toEqual(bulk('69.5'));
    expect(run(b.ctx, ['EVAL', debit, '1', 'gate', '-20.25'])).toEqual(bulk('79.75'));
    await Promise.all([a.cluster.drain(1000), b.cluster.drain(1000)]);
    hub.flushReversed();

    expect(balance(a.ctx)).toEqual({ type: 'array', value: [bulk('49.25')] });
    expect(balance(b.ctx)).toEqual({ type: 'array', value: [bulk('49.25')] });

    // A fresh node hydrating from the durable store sees the true sum too.
    hub.setPolicy({});
    const c = node('node-c');
    await c.cluster.start();
    expect(balance(c.ctx)).toEqual({ type: 'array', value: [bulk('49.25')] });
  });

  it('duplicated and reordered contributions are idempotent', async () => {
    hub.setPolicy({ hold: true, duplicate: true });
    const a = node('node-a');
    const b = node('node-b');
    await Promise.all([a.cluster.start(), b.cluster.start()]);

    run(a.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '10']);
    await a.cluster.drain(1000);
    hub.flush();
    run(a.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '-3']);
    await a.cluster.drain(1000);
    run(a.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '-1.5']);
    await a.cluster.drain(1000);
    hub.flushReversed();
    hub.flush();

    expect(balance(b.ctx)).toEqual({ type: 'array', value: [bulk('5.5')] });
  });

  it('HSET resets the counter on peers and in the durable store', async () => {
    const a = node('node-a');
    const b = node('node-b');
    await Promise.all([a.cluster.start(), b.cluster.start()]);

    run(a.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '10']);
    run(b.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '-4']);
    await Promise.all([a.cluster.drain(1000), b.cluster.drain(1000)]);
    expect(balance(a.ctx)).toEqual({ type: 'array', value: [bulk('6')] });

    run(a.ctx, ['HSET', 'gate', 'balance', '50']);
    await a.cluster.drain(1000);
    expect(balance(b.ctx)).toEqual({ type: 'array', value: [bulk('50')] });
    const stored = durable.keys.get('gate');
    expect(stored?.type === 'hash' ? stored.counters?.balance : 'not a hash').toBeUndefined();

    // Debits after the reset build on the new value everywhere.
    run(b.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '-1']);
    await b.cluster.drain(1000);
    expect(balance(a.ctx)).toEqual({ type: 'array', value: [bulk('49')] });
    const c = node('node-c');
    await c.cluster.start();
    expect(balance(c.ctx)).toEqual({ type: 'array', value: [bulk('49')] });
  });

  it('HDEL of a counter field does not resurrect it on hydration', async () => {
    const a = node('node-a');
    await a.cluster.start();
    run(a.ctx, ['HSET', 'gate', 'other', 'x']);
    run(a.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '3']);
    run(a.ctx, ['HDEL', 'gate', 'balance']);
    await a.cluster.drain(1000);

    const c = node('node-c');
    await c.cluster.start();
    expect(run(c.ctx, ['HMGET', 'gate', 'balance', 'other'])).toEqual({ type: 'array', value: [bulk(null), bulk('x')] });
  });

  it('anti-entropy with a lagging durable snapshot does not revert local increments', async () => {
    const a = node('node-a');
    await a.cluster.start();
    run(a.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '5']);
    await a.cluster.drain(1000);
    // Snapshot of the persisted state, then a further local debit whose
    // durable write we pretend hasn't happened yet.
    const lagging = structuredClone(durable.keys.get('gate'))!;
    run(a.ctx, ['HINCRBYFLOAT', 'gate', 'balance', '-2']);
    await a.cluster.drain(1000);
    durable.keys.set('gate', lagging);
    durable.setUpdatedAt('gate', Date.now() + 1_000_000);

    await a.cluster.reconcile();
    expect(balance(a.ctx)).toEqual({ type: 'array', value: [bulk('3')] });
  });

  it('snapshots round-trip counters and the wire event validates', () => {
    const store = new Store(0);
    stores.push(store);
    store.hset('h', [['plain', 'v']]);
    store.hincrbyfloat('h', 'balance', -1.5, 'node-a');
    store.hincrbyfloat('h', 'balance', 4, 'node-b');
    const snapshot = JSON.parse(JSON.stringify(entryToSnapshot(store.getRawEntry('h')!)));
    const entry = snapshotToEntry(snapshot);
    expect(entry.type === 'hash' && Object.fromEntries(entry.fields)).toEqual({ plain: 'v', balance: '2.5' });

    const event = { kind: 'hashFieldIncrement', originNodeId: 'n', seq: 1, timestampMs: 1, key: 'h', field: 'balance', floatContribution: [1, 2] };
    expect(validateReplicationEvent(event)).not.toBeNull();
    expect(validateReplicationEvent({ ...event, floatContribution: [1, -2] })).toBeNull();
    expect(validateReplicationEvent({ ...event, field: undefined })).toBeNull();
  });
});
