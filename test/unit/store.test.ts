import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { WrongTypeError } from '../../src/store/types.js';
import { parseScoreBound } from '../../src/store/scoreRange.js';

describe('Store strings', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(0); // disable active sweep, test lazy expiry directly
  });
  afterEach(() => store.close());

  it('returns null for a missing key', () => {
    expect(store.get('missing')).toBeNull();
  });

  it('set/get round-trips a value', () => {
    store.set('k', 'v');
    expect(store.get('k')).toBe('v');
  });

  it('DEL removes a key and reports how many were removed', () => {
    store.set('a', '1');
    store.set('b', '2');
    expect(store.del(['a', 'b', 'missing'])).toBe(2);
    expect(store.get('a')).toBeNull();
  });

  it('INCR creates the key at 0 then increments', () => {
    expect(store.incr('counter')).toBe(1);
    expect(store.incr('counter')).toBe(2);
  });

  it('INCR errors on a non-numeric existing value', () => {
    store.set('k', 'not-a-number');
    expect(() => store.incr('k')).toThrow(/not an integer/);
  });

  it('a command against the wrong type throws WrongTypeError', () => {
    store.hset('h', [['f', 'v']]);
    expect(() => store.get('h')).toThrow(WrongTypeError);
    expect(() => store.incr('h')).toThrow(WrongTypeError);
  });
});

describe('Store TTL', () => {
  let store: Store;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(0);
  });
  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('SET PX expires the key after the given milliseconds (lazy expiry)', () => {
    store.set('k', 'v', { pxMs: 100 });
    expect(store.get('k')).toBe('v');
    vi.advanceTimersByTime(101);
    expect(store.get('k')).toBeNull();
  });

  it('PEXPIRE sets a TTL on an existing key', () => {
    store.set('k', 'v');
    expect(store.pexpire('k', 50)).toBe(true);
    vi.advanceTimersByTime(51);
    expect(store.get('k')).toBeNull();
  });

  it('PEXPIRE on a missing key returns false', () => {
    expect(store.pexpire('missing', 50)).toBe(false);
  });

  it('EXPIRE NX only sets a TTL if none exists yet', () => {
    store.set('k', 'v');
    expect(store.expire('k', 1, 'NX')).toBe(true); // 1s TTL
    expect(store.expire('k', 500, 'NX')).toBe(false); // already has a TTL, NX is a no-op
    vi.advanceTimersByTime(1001);
    expect(store.get('k')).toBeNull(); // original 1s TTL won, not overridden to 500s
  });

  it('active sweep evicts expired keys without a read triggering it', () => {
    const sweeping = new Store(50);
    sweeping.set('k', 'v', { pxMs: 10 });
    vi.advanceTimersByTime(120);
    expect(sweeping.stats().keyCounts.string).toBe(0);
    sweeping.close();
  });
});

describe('Store hashes', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(0);
  });
  afterEach(() => store.close());

  it('HSET/HGETALL/HDEL round-trip', () => {
    expect(store.hset('h', [['f1', 'v1'], ['f2', 'v2']])).toBe(2);
    expect(store.hset('h', [['f1', 'v1-updated']])).toBe(0); // existing field, not counted as added
    expect(new Map(store.hgetall('h')).get('f1')).toBe('v1-updated');
    expect(store.hdel('h', ['f1'])).toBe(1);
    expect(store.hgetall('h')).toEqual([['f2', 'v2']]);
  });

  it('HGETALL on a missing key returns an empty array', () => {
    expect(store.hgetall('missing')).toEqual([]);
  });

  it('deletes the key once its last field is removed', () => {
    store.hset('h', [['f', 'v']]);
    store.hdel('h', ['f']);
    expect(store.exists('h')).toBe(false);
  });
});

describe('Store sorted sets', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(0);
  });
  afterEach(() => store.close());

  it('ZADD adds members and reports how many were newly added', () => {
    expect(store.zadd('z', [[1, 'a'], [2, 'b']])).toBe(2);
    expect(store.zadd('z', [[99, 'a']])).toBe(0); // updates score, not a new member
  });

  it('ZCOUNT supports inclusive bare-number bounds', () => {
    store.zadd('z', [[1, 'a'], [2, 'b'], [3, 'c']]);
    const min = parseScoreBound('1');
    const max = parseScoreBound('2');
    expect(store.zcount('z', min, max)).toBe(2);
  });

  it('ZCOUNT supports exclusive "(" bounds and -inf/+inf', () => {
    store.zadd('z', [[1, 'a'], [2, 'b'], [3, 'c']]);
    expect(store.zcount('z', parseScoreBound('(1'), parseScoreBound('+inf'))).toBe(2);
    expect(store.zcount('z', parseScoreBound('-inf'), parseScoreBound('(3'))).toBe(2);
  });

  it('ZCOUNT matches the sliding-window pattern used by the outbound-guard caller', () => {
    // ZCOUNT key "(<now - 60000>" "+inf" — count sends in the last minute
    const now = 1_700_000_000_000;
    store.zadd('workspace:w1', [
      [now - 120_000, 'evt-old'],
      [now - 30_000, 'evt-recent-1'],
      [now - 1_000, 'evt-recent-2'],
    ]);
    const min = parseScoreBound(`(${now - 60_000}`);
    const max = parseScoreBound('+inf');
    expect(store.zcount('workspace:w1', min, max)).toBe(2);
  });

  it('ZREMRANGEBYSCORE prunes entries older than a cutoff, matching the pruning caller', () => {
    const now = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    store.zadd('workspace:w1', [
      [now - dayMs - 1, 'too-old'],
      [now - 1000, 'recent'],
    ]);
    const removed = store.zremrangebyscore('workspace:w1', parseScoreBound('0'), parseScoreBound(String(now - dayMs)));
    expect(removed).toEqual(['too-old']);
    expect(store.zcount('workspace:w1', parseScoreBound('-inf'), parseScoreBound('+inf'))).toBe(1);
  });

  it('deletes the key once its last member is removed', () => {
    store.zadd('z', [[1, 'a']]);
    store.zremrangebyscore('z', parseScoreBound('-inf'), parseScoreBound('+inf'));
    expect(store.exists('z')).toBe(false);
  });
});

describe('Store fast counters (memoryBytesEstimate / keyCounts)', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(0);
  });
  afterEach(() => store.close());

  it('tracks per-type key counts incrementally as keys are created and removed', () => {
    expect(store.keyCounts()).toEqual({ string: 0, hash: 0, sortedset: 0 });
    store.set('s1', 'v');
    store.set('s2', 'v');
    store.hset('h1', [['f', 'v']]);
    store.zadd('z1', [[1, 'm']]);
    expect(store.keyCounts()).toEqual({ string: 2, hash: 1, sortedset: 1 });

    store.del(['s1']);
    store.hdel('h1', ['f']); // empties the hash -> whole key removed
    expect(store.keyCounts()).toEqual({ string: 1, hash: 0, sortedset: 1 });
  });

  it('keyCounts() agrees with the independent stats() walk after a mix of writes', () => {
    store.set('a', 'x');
    store.incr('counter');
    store.hset('h', [['f1', 'v'], ['f2', 'v']]);
    store.zadd('z', [[1, 'm']]);
    store.set('a', 'y'); // in-place replace, not a new key
    expect(store.keyCounts()).toEqual(store.stats().keyCounts);
  });

  it('memoryBytesEstimate() moves with writes and matches the walked estimate', () => {
    expect(store.memoryBytesEstimate()).toBe(0);
    store.set('k', 'value');
    const afterSet = store.memoryBytesEstimate();
    expect(afterSet).toBeGreaterThan(0);
    expect(afterSet).toBe(store.stats().memoryEstimateBytes);

    store.del(['k']);
    expect(store.memoryBytesEstimate()).toBe(0);
  });

  it('counts stay exact when a replicated field-set creates a brand-new key', () => {
    store.applyReplicatedHashFieldSet('h', [['f', 'v']]);
    store.applyReplicatedZsetMemberSet('z', [['m', 1]]);
    expect(store.keyCounts()).toEqual({ string: 0, hash: 1, sortedset: 1 });
    expect(store.keyCounts()).toEqual(store.stats().keyCounts);
  });
});

describe('Store.applyReplicatedTtl', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(0);
  });
  afterEach(() => store.close());

  it('sets a TTL on an existing key without touching its value', () => {
    store.set('k', 'v');
    const at = Date.now() + 60_000;
    store.applyReplicatedTtl('k', at);
    expect(store.get('k')).toBe('v');
    const detail = store.getKeyDetail('k');
    expect(detail?.info.ttlMsRemaining).not.toBeNull();
  });

  it('leaves other hash fields intact (TTL-only, never a whole-entry overwrite)', () => {
    store.hset('h', [['f1', 'v1'], ['f2', 'v2']]);
    store.applyReplicatedTtl('h', Date.now() + 60_000);
    expect(new Map(store.hgetall('h'))).toEqual(new Map([['f1', 'v1'], ['f2', 'v2']]));
  });

  it('is a no-op for a key that does not exist locally (EXPIRE cannot create a key)', () => {
    store.applyReplicatedTtl('absent', Date.now() + 60_000);
    expect(store.exists('absent')).toBe(false);
    expect(store.keyCounts()).toEqual({ string: 0, hash: 0, sortedset: 0 });
  });

  it('can clear a TTL by passing null', () => {
    store.set('k', 'v', { exSeconds: 60 });
    store.applyReplicatedTtl('k', null);
    expect(store.getKeyDetail('k')?.info.ttlMsRemaining).toBeNull();
  });
});
