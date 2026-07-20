import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { loadConfig } from '../../src/config.js';
import type { RespValue } from '../../src/resp/types.js';
import { standaloneCluster } from '../helpers/cluster.js';
import { scriptCache, sha1hex } from '../../src/scripting/scriptCache.js';

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

/** Runs a command and returns its single reply frame. */
function run(ctx: CommandContext, argv: string[]): RespValue {
  return dispatch(ctx, argv).frames[0];
}

/** EVAL a body with the given keys/args and return the reply frame. */
function evalScript(ctx: CommandContext, source: string, keys: string[] = [], args: string[] = []): RespValue {
  return run(ctx, ['EVAL', source, String(keys.length), ...keys, ...args]);
}

describe('Lua scripting', () => {
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

  describe('return-value conversion (Lua -> RESP)', () => {
    it('number -> truncated integer', () => {
      expect(evalScript(ctx, 'return 42')).toEqual({ type: 'integer', value: 42 });
      expect(evalScript(ctx, 'return 3.99')).toEqual({ type: 'integer', value: 3 });
    });

    it('string -> bulk', () => {
      expect(evalScript(ctx, "return 'hello'")).toEqual({ type: 'bulk', value: 'hello' });
    });

    it('true -> :1, false -> nil, nil -> nil', () => {
      expect(evalScript(ctx, 'return true')).toEqual({ type: 'integer', value: 1 });
      expect(evalScript(ctx, 'return false')).toEqual({ type: 'bulk', value: null });
      expect(evalScript(ctx, 'return nil')).toEqual({ type: 'bulk', value: null });
    });

    it('table -> array, stopping at the first nil', () => {
      expect(evalScript(ctx, 'return {1, 2, 3}')).toEqual({
        type: 'array',
        value: [
          { type: 'integer', value: 1 },
          { type: 'integer', value: 2 },
          { type: 'integer', value: 3 },
        ],
      });
      // A hole terminates the array (Redis semantics).
      expect(evalScript(ctx, 'return {1, nil, 3}')).toEqual({
        type: 'array',
        value: [{ type: 'integer', value: 1 }],
      });
    });

    it('{ok=...} -> status, {err=...} -> error', () => {
      expect(evalScript(ctx, "return {ok='FINE'}")).toEqual({ type: 'simple', value: 'FINE' });
      expect(evalScript(ctx, "return {err='boom'}")).toEqual({ type: 'error', value: 'boom' });
      expect(evalScript(ctx, "return redis.error_reply('nope')")).toEqual({ type: 'error', value: 'ERR nope' });
      expect(evalScript(ctx, "return redis.status_reply('GOOD')")).toEqual({ type: 'simple', value: 'GOOD' });
    });
  });

  describe('KEYS / ARGV', () => {
    it('exposes 1-indexed KEYS and ARGV', () => {
      expect(evalScript(ctx, 'return {KEYS[1], KEYS[2], ARGV[1]}', ['k1', 'k2'], ['a1'])).toEqual({
        type: 'array',
        value: [
          { type: 'bulk', value: 'k1' },
          { type: 'bulk', value: 'k2' },
          { type: 'bulk', value: 'a1' },
        ],
      });
    });
  });

  describe('redis.call', () => {
    it('round-trips through the real command layer (SET then GET)', () => {
      evalScript(ctx, "redis.call('SET', KEYS[1], ARGV[1])", ['k'], ['v']);
      expect(ctx.store.get('k')).toBe('v');
      expect(evalScript(ctx, "return redis.call('GET', KEYS[1])", ['k'])).toEqual({ type: 'bulk', value: 'v' });
    });

    it('converts a numeric arg to a string (SET ... PX <number>)', () => {
      evalScript(ctx, "redis.call('SET', KEYS[1], 'v', 'PX', 50000)", ['k']);
      expect(ctx.store.pttlMs('k')).toBeGreaterThan(40_000);
    });

    it('a nil bulk reply becomes false in Lua', () => {
      expect(evalScript(ctx, "return redis.call('GET', KEYS[1]) == false", ['missing'])).toEqual({
        type: 'integer',
        value: 1,
      });
    });

    it('redis.call raises a command error, aborting the script', () => {
      ctx.store.set('h-is-string', 'x');
      const reply = evalScript(ctx, "redis.call('HGETALL', KEYS[1]) return 'unreached'", ['h-is-string']);
      expect(reply.type).toBe('error');
      expect(reply.type === 'error' && reply.value).toMatch(/WRONGTYPE/);
    });

    it('redis.pcall returns the error as a value instead of raising', () => {
      ctx.store.set('h-is-string', 'x');
      const reply = evalScript(
        ctx,
        "local ok = redis.pcall('HGETALL', KEYS[1]) if ok.err then return 'caught' end return 'no'",
        ['h-is-string'],
      );
      expect(reply).toEqual({ type: 'bulk', value: 'caught' });
    });

    it('rejects a command that is not allowed from a script', () => {
      const reply = evalScript(ctx, "return redis.call('SUBSCRIBE', 'chan')");
      expect(reply.type).toBe('error');
      expect(reply.type === 'error' && reply.value).toMatch(/not allowed from script/);
    });
  });

  describe('EVALSHA / SCRIPT', () => {
    it('SCRIPT LOAD returns the SHA1 and EVALSHA runs it', () => {
      const body = "return 'cached'";
      const loaded = run(ctx, ['SCRIPT', 'LOAD', body]);
      expect(loaded).toEqual({ type: 'bulk', value: sha1hex(body) });
      expect(run(ctx, ['EVALSHA', sha1hex(body), '0'])).toEqual({ type: 'bulk', value: 'cached' });
    });

    it('EVALSHA of an unknown SHA replies NOSCRIPT', () => {
      const reply = run(ctx, ['EVALSHA', 'deadbeef'.repeat(5), '0']);
      expect(reply.type).toBe('error');
      expect(reply.type === 'error' && reply.value).toMatch(/^NOSCRIPT/);
    });

    it('EVAL populates the cache so a later EVALSHA hits', () => {
      const body = "return 7";
      evalScript(ctx, body);
      expect(run(ctx, ['EVALSHA', sha1hex(body), '0'])).toEqual({ type: 'integer', value: 7 });
    });

    it('SCRIPT EXISTS reports per-SHA presence; FLUSH clears the cache', () => {
      const body = "return 1";
      const sha = sha1hex(body);
      run(ctx, ['SCRIPT', 'LOAD', body]);
      expect(run(ctx, ['SCRIPT', 'EXISTS', sha, 'ffffffffffffffffffffffffffffffffffffffff'])).toEqual({
        type: 'array',
        value: [
          { type: 'integer', value: 1 },
          { type: 'integer', value: 0 },
        ],
      });
      run(ctx, ['SCRIPT', 'FLUSH']);
      expect(run(ctx, ['SCRIPT', 'EXISTS', sha])).toEqual({ type: 'array', value: [{ type: 'integer', value: 0 }] });
    });
  });

  describe("rate-limit-redis's default store script", () => {
    // The exact Lua rate-limit-redis ships and runs via SCRIPT LOAD + EVALSHA.
    const RATE_LIMIT_LUA = `local windowMs = tonumber(ARGV[2])
local resetOnChange = ARGV[1] == "1"
local timeToExpire = redis.call("PTTL", KEYS[1])
if timeToExpire <= 0 then
    redis.call("SET", KEYS[1], 1, "PX", windowMs)
    return { 1, windowMs }
end
local totalHits = redis.call("INCR", KEYS[1])
if resetOnChange then
    redis.call("PEXPIRE", KEYS[1], windowMs)
    timeToExpire = windowMs
end
return { totalHits, timeToExpire }`;

    it('first hit creates the counter at 1 with the window TTL', () => {
      const reply = evalScript(ctx, RATE_LIMIT_LUA, ['rl:user1'], ['0', '60000']);
      expect(reply).toEqual({
        type: 'array',
        value: [
          { type: 'integer', value: 1 },
          { type: 'integer', value: 60000 },
        ],
      });
      expect(ctx.store.get('rl:user1')).toBe('1');
      expect(ctx.store.pttlMs('rl:user1')).toBeGreaterThan(0);
    });

    it('subsequent hits increment and report the remaining window', () => {
      evalScript(ctx, RATE_LIMIT_LUA, ['rl:user2'], ['0', '60000']);
      const second = evalScript(ctx, RATE_LIMIT_LUA, ['rl:user2'], ['0', '60000']);
      expect(second.type).toBe('array');
      const arr = second.type === 'array' ? second.value! : [];
      expect(arr[0]).toEqual({ type: 'integer', value: 2 });
      // remaining TTL is > 0 and <= the window
      expect(arr[1].type).toBe('integer');
      expect(arr[1].type === 'integer' && arr[1].value).toBeGreaterThan(0);
    });
  });

  describe('errors', () => {
    it('a compile error is reported, not thrown', () => {
      const reply = evalScript(ctx, 'this is not lua =');
      expect(reply.type).toBe('error');
      expect(reply.type === 'error' && reply.value).toMatch(/compiling script/i);
    });

    it('EVAL with numkeys greater than provided args errors', () => {
      const reply = run(ctx, ['EVAL', 'return 1', '5', 'onlyonekey']);
      expect(reply.type).toBe('error');
    });
  });
});
