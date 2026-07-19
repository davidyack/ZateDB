import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { OutOfMemoryError } from '../../src/store/types.js';
import { secureEqual } from '../../src/util/secureCompare.js';

describe('Store capacity limits', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('rejects a new key once maxKeys is reached but still allows overwriting existing keys', () => {
    store = new Store(0, { maxKeys: 2 });
    store.set('a', '1');
    store.set('b', '2');
    expect(() => store.set('c', '3')).toThrow(OutOfMemoryError);
    // Overwriting an existing key is not a new-key write, so it succeeds.
    expect(() => store.set('a', 'updated')).not.toThrow();
    expect(store.get('a')).toBe('updated');
  });

  it('frees capacity when a key is deleted', () => {
    store = new Store(0, { maxKeys: 1 });
    store.set('a', '1');
    expect(() => store.set('b', '2')).toThrow(OutOfMemoryError);
    store.del(['a']);
    expect(() => store.set('b', '2')).not.toThrow();
  });

  it('rejects a new key once the estimated memory ceiling is crossed', () => {
    // One small string entry estimates ~60 bytes (key*2 + 48 overhead + value*2),
    // which crosses this deliberately tiny ceiling.
    store = new Store(0, { maxMemoryBytes: 50 });
    store.set('first', 'x');
    expect(() => store.set('second', 'y')).toThrow(OutOfMemoryError);
  });

  it('applies OOM to hash and sorted-set key creation too', () => {
    store = new Store(0, { maxKeys: 1 });
    store.hset('h', [['f', 'v']]);
    expect(() => store.zadd('z', [[1, 'm']])).toThrow(OutOfMemoryError);
    // But growing the existing hash is allowed.
    expect(() => store.hset('h', [['f2', 'v2']])).not.toThrow();
  });

  it('treats maxKeys/maxMemoryBytes of 0 as unlimited', () => {
    store = new Store(0, { maxKeys: 0, maxMemoryBytes: 0 });
    for (let i = 0; i < 1000; i++) store.set(`k${i}`, 'v');
    expect(store.stats().totalKeys).toBe(1000);
  });
});

describe('secureEqual', () => {
  it('returns true only for identical strings', () => {
    expect(secureEqual('hunter2', 'hunter2')).toBe(true);
    expect(secureEqual('hunter2', 'hunter3')).toBe(false);
  });

  it('returns false for differing lengths without throwing', () => {
    expect(secureEqual('short', 'a-much-longer-secret')).toBe(false);
    expect(secureEqual('', 'x')).toBe(false);
  });
});
