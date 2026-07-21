import { beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import { serialize } from '../../src/resp/serializer.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { loadConfig } from '../../src/config.js';
import { standaloneCluster } from '../helpers/cluster.js';

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

describe('RESP2/RESP3 dual protocol support', () => {
  let store: Store;
  let pubsub: PubSubRegistry;
  let ctx: CommandContext;

  beforeEach(() => {
    store = new Store(0);
    pubsub = new PubSubRegistry();
    ctx = { store, pubsub, conn: fakeConn(), config: loadConfig({}), cluster: standaloneCluster(store, pubsub) };
  });

  describe('HELLO negotiation', () => {
    it('defaults a fresh connection to RESP2', () => {
      expect(ctx.conn.protover).toBe(2);
    });

    it('HELLO 3 switches the connection to RESP3 and replies proto:3', () => {
      const outcome = dispatch(ctx, ['HELLO', '3']);
      expect(ctx.conn.protover).toBe(3);
      const frame = outcome.frames[0];
      expect(frame.type).toBe('map');
      const proto = (frame as { type: 'map'; value: Array<[unknown, { type: string; value: unknown }]> }).value.find(
        ([k]) => (k as { value: string }).value === 'proto',
      );
      expect(proto?.[1]).toEqual({ type: 'integer', value: 3 });
    });

    it('HELLO 2 keeps/reverts the connection to RESP2', () => {
      dispatch(ctx, ['HELLO', '3']);
      dispatch(ctx, ['HELLO', '2']);
      expect(ctx.conn.protover).toBe(2);
    });

    it('bare HELLO (no protover) leaves the current protocol version unchanged', () => {
      dispatch(ctx, ['HELLO', '3']);
      dispatch(ctx, ['HELLO']);
      expect(ctx.conn.protover).toBe(3);
    });

    it('HELLO with an unsupported protover replies NOPROTO and does not change protover', () => {
      const outcome = dispatch(ctx, ['HELLO', '4']);
      expect(outcome.frames[0]).toEqual({ type: 'error', value: 'NOPROTO unsupported protocol version' });
      expect(ctx.conn.protover).toBe(2);
    });
  });

  describe('subscriber-mode command gate', () => {
    it('RESP2: a subscribed connection is rejected running a normal command', () => {
      dispatch(ctx, ['SUBSCRIBE', 'chan']);
      const outcome = dispatch(ctx, ['GET', 'k']);
      expect(outcome.isError).toBe(true);
      expect(outcome.frames[0].type).toBe('error');
    });

    it('RESP3: a subscribed connection can still run normal commands', () => {
      dispatch(ctx, ['HELLO', '3']);
      dispatch(ctx, ['SUBSCRIBE', 'chan']);
      const outcome = dispatch(ctx, ['SET', 'k', 'v']);
      expect(outcome.isError).toBe(false);
      expect(getValue(ctx)).toBe('v');
    });
  });

  describe('HGETALL RESP3 map reply', () => {
    // The command handler always produces a 'map' RespValue; whether that
    // becomes a flat array or a real RESP3 map on the wire is decided by
    // serialize() from the connection's protover — see resp/serializer.ts.
    it('HGETALL replies a map-typed frame', () => {
      dispatch(ctx, ['HSET', 'h', 'f', 'v']);
      const outcome = dispatch(ctx, ['HGETALL', 'h']);
      expect(outcome.frames[0]).toEqual({
        type: 'map',
        value: [[{ type: 'bulk', value: 'f' }, { type: 'bulk', value: 'v' }]],
      });
    });

    it('serializes to a flat array under RESP2 and a real map under RESP3', () => {
      dispatch(ctx, ['HSET', 'h', 'f', 'v']);
      const frame = dispatch(ctx, ['HGETALL', 'h']).frames[0];
      expect(serialize(frame, 2).toString()).toBe('*2\r\n$1\r\nf\r\n$1\r\nv\r\n');
      expect(serialize(frame, 3).toString()).toBe('%1\r\n$1\r\nf\r\n$1\r\nv\r\n');
    });
  });

  describe('PUBSUB introspection command', () => {
    it('PUBSUB NUMSUB reports per-channel subscriber counts, 0 for unknown channels', () => {
      const other = { ...fakeConn(), id: 'other-conn' };
      dispatch({ ...ctx, conn: other }, ['SUBSCRIBE', 'room:1']);
      const outcome = dispatch(ctx, ['PUBSUB', 'NUMSUB', 'room:1', 'room:2']);
      expect(outcome.frames[0]).toEqual({
        type: 'array',
        value: [
          { type: 'bulk', value: 'room:1' },
          { type: 'integer', value: 1 },
          { type: 'bulk', value: 'room:2' },
          { type: 'integer', value: 0 },
        ],
      });
    });

    it('PUBSUB NUMPAT reports the number of active patterns', () => {
      const other = { ...fakeConn(), id: 'other-conn' };
      dispatch({ ...ctx, conn: other }, ['PSUBSCRIBE', 'room:*']);
      expect(dispatch(ctx, ['PUBSUB', 'NUMPAT']).frames[0]).toEqual({ type: 'integer', value: 1 });
    });

    it('PUBSUB CHANNELS lists active channels, optionally glob-filtered', () => {
      const other = { ...fakeConn(), id: 'other-conn' };
      dispatch({ ...ctx, conn: other }, ['SUBSCRIBE', 'room:1', 'lobby:1']);
      const all = dispatch(ctx, ['PUBSUB', 'CHANNELS']);
      expect((all.frames[0] as { type: 'array'; value: Array<{ value: string }> }).value.map((v) => v.value).sort()).toEqual([
        'lobby:1',
        'room:1',
      ]);
      const filtered = dispatch(ctx, ['PUBSUB', 'CHANNELS', 'room:*']);
      expect(filtered.frames[0]).toEqual({ type: 'array', value: [{ type: 'bulk', value: 'room:1' }] });
    });

    it('PUBSUB is allowed while the connection is itself subscribed', () => {
      dispatch(ctx, ['SUBSCRIBE', 'chan']);
      const outcome = dispatch(ctx, ['PUBSUB', 'NUMPAT']);
      expect(outcome.isError).toBe(false);
    });
  });
});

function getValue(ctx: CommandContext): string | null {
  const outcome = dispatch(ctx, ['GET', 'k']);
  const frame = outcome.frames[0];
  return frame.type === 'bulk' ? frame.value : null;
}
