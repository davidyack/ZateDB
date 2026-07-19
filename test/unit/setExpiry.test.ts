import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import type { ServerConfig } from '../../src/config.js';
import type { RespValue } from '../../src/resp/types.js';

const config: ServerConfig = {
  respPort: 0,
  healthPort: 0,
  adminPort: 0,
  authPassword: null,
  adminToken: null,
  ttlSweepIntervalMs: 0,
  maxKeys: 0,
  maxMemoryBytes: 0,
  maxClients: 0,
  idleTimeoutMs: 0,
  maxBulkBytes: 0,
  maxBufferBytes: 0,
  outboundHighWaterMarkBytes: 0,
  otelServiceName: 'test',
  appInsightsConnectionString: null,
  otlpTraceEndpoint: null,
  otlpMetricsEndpoint: null,
};

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

function errorText(frame: RespValue): string | null {
  return frame.type === 'error' ? frame.value : null;
}

describe('SET expiry option validation', () => {
  let ctx: CommandContext;
  beforeEach(() => {
    ctx = { store: new Store(0), pubsub: new PubSubRegistry(), conn: fakeConn(), config };
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

  it('rejects an unsupported SET option loudly instead of silently overwriting', () => {
    // Previously `SET k v NX` returned +OK and unconditionally overwrote —
    // silently wrong lock/idempotency semantics. It must error, and must not
    // have written the key.
    const out = dispatch(ctx, ['SET', 'k', 'v', 'NX']);
    expect(out.isError).toBe(true);
    expect(errorText(out.frames[0])).toMatch(/unsupported option 'NX'/);
    expect(ctx.store.get('k')).toBeNull();
  });
});

describe('EXPIRE / PEXPIRE integer validation', () => {
  let ctx: CommandContext;
  beforeEach(() => {
    ctx = { store: new Store(0), pubsub: new PubSubRegistry(), conn: fakeConn(), config };
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
