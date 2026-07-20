import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { loadConfig } from '../../src/config.js';
import type { RespValue } from '../../src/resp/types.js';
import { standaloneCluster } from '../helpers/cluster.js';

const config = loadConfig({});

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

function errorText(frame: RespValue): string | null {
  return frame.type === 'error' ? frame.value : null;
}

describe('SET expiry option validation', () => {
  let ctx: CommandContext;
  beforeEach(() => {
    const store = new Store(0);
    const pubsub = new PubSubRegistry();
    ctx = { store, pubsub, conn: fakeConn(), config, cluster: standaloneCluster(store, pubsub) };
  });
  afterEach(() => ctx.store.close());

  it('accepts a valid EX and applies the TTL', () => {
    const out = dispatch(ctx, ['SET', 'k', 'v', 'EX', '100']);
    expect(out.isError).toBe(false);
    expect(ctx.store.getKeyDetail('k')?.info.ttlMsRemaining).toBeGreaterThan(0);
  });

  it('rejects a non-integer EX instead of silently creating a never-expiring key', () => {
    // Regression: Number("abc") -> NaN expiry, whose <= now check never fires,
    // so the key would live forever with no error surfaced to the caller.
    const out = dispatch(ctx, ['SET', 'k', 'v', 'EX', 'abc']);
    expect(out.isError).toBe(true);
    expect(errorText(out.frames[0])).toMatch(/not an integer/);
    expect(ctx.store.get('k')).toBeNull(); // key was not created
  });

  it('rejects a fractional PX', () => {
    const out = dispatch(ctx, ['SET', 'k', 'v', 'PX', '1.5']);
    expect(out.isError).toBe(true);
    expect(errorText(out.frames[0])).toMatch(/not an integer/);
  });

  it('rejects a zero or negative expiry with the invalid-expire-time error', () => {
    const zero = dispatch(ctx, ['SET', 'k', 'v', 'EX', '0']);
    expect(errorText(zero.frames[0])).toMatch(/invalid expire time/);
    const negative = dispatch(ctx, ['SET', 'k', 'v', 'PX', '-5']);
    expect(errorText(negative.frames[0])).toMatch(/invalid expire time/);
    expect(ctx.store.get('k')).toBeNull();
  });

  it('still accepts a plain SET with no expiry options', () => {
    const out = dispatch(ctx, ['SET', 'k', 'v']);
    expect(out.isError).toBe(false);
    expect(ctx.store.get('k')).toBe('v');
    expect(ctx.store.getKeyDetail('k')?.info.ttlMsRemaining).toBeNull();
  });

  it('rejects a still-unimplemented SET option loudly instead of silently overwriting', () => {
    // NX/XX/GET/KEEPTTL are now implemented, but a real option we still don't
    // support (e.g. EXAT) must error rather than be silently dropped — a
    // silently-ignored option hands a caller the wrong semantics with no signal.
    const out = dispatch(ctx, ['SET', 'k', 'v', 'EXAT', '9999999999']);
    expect(out.isError).toBe(true);
    expect(errorText(out.frames[0])).toMatch(/unsupported option 'EXAT'/);
    expect(ctx.store.get('k')).toBeNull();
  });

  it('SET NX acquires only when absent; a contended NX write replies nil and does not overwrite', () => {
    const first = dispatch(ctx, ['SET', 'lock', 'owner-a', 'NX']);
    expect(first.isError).toBe(false);
    expect(first.frames[0]).toEqual({ type: 'simple', value: 'OK' });

    const second = dispatch(ctx, ['SET', 'lock', 'owner-b', 'NX']);
    expect(second.isError).toBe(false);
    expect(second.frames[0]).toEqual({ type: 'bulk', value: null }); // nil: not acquired
    expect(ctx.store.get('lock')).toBe('owner-a'); // first holder retained
  });
});

describe('EXPIRE / PEXPIRE integer validation', () => {
  let ctx: CommandContext;
  beforeEach(() => {
    const store = new Store(0);
    const pubsub = new PubSubRegistry();
    ctx = { store, pubsub, conn: fakeConn(), config, cluster: standaloneCluster(store, pubsub) };
    dispatch(ctx, ['SET', 'k', 'v']);
  });
  afterEach(() => ctx.store.close());

  it('applies an integer EXPIRE', () => {
    const out = dispatch(ctx, ['EXPIRE', 'k', '100']);
    expect(out.isError).toBe(false);
    expect(ctx.store.getKeyDetail('k')?.info.ttlMsRemaining).toBeGreaterThan(0);
  });

  it('rejects a fractional EXPIRE instead of applying a sub-second TTL', () => {
    const out = dispatch(ctx, ['EXPIRE', 'k', '1.5']);
    expect(out.isError).toBe(true);
    expect(errorText(out.frames[0])).toMatch(/not an integer/);
  });

  it('rejects a fractional PEXPIRE', () => {
    const out = dispatch(ctx, ['PEXPIRE', 'k', '2500.5']);
    expect(out.isError).toBe(true);
    expect(errorText(out.frames[0])).toMatch(/not an integer/);
  });
});
