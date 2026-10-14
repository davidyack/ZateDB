import { array, bulk, error, integer } from '../resp/types.js';
import { FloatOverflowError, NotAFloatError, OutOfMemoryError, WrongTypeError } from '../store/types.js';
import { parseRedisFloat } from '../store/floatCounter.js';
import type { CommandContext, CommandResult } from './context.js';
import { result } from './context.js';
import { wrongArgsError } from './errors.js';

export function hset(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 3 || args.length % 2 !== 1) return result(wrongArgsError('hset'));
  const [key, ...rest] = args;
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
  try {
    return result(integer(ctx.store.hset(key, pairs)));
  } catch (e) {
    if (e instanceof WrongTypeError || e instanceof OutOfMemoryError) return result(error(e.message));
    throw e;
  }
}

export function hdel(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2) return result(wrongArgsError('hdel'));
  const [key, ...fields] = args;
  try {
    return result(integer(ctx.store.hdel(key, fields)));
  } catch (e) {
    if (e instanceof WrongTypeError) return result(error(e.message));
    throw e;
  }
}

export function hgetall(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 1) return result(wrongArgsError('hgetall'));
  try {
    const pairs = ctx.store.hgetall(args[0]);
    // 'map' serializes as a real RESP3 map for a HELLO-3 connection and as
    // today's flat array for RESP2 — see resp/serializer.ts. node-redis's
    // RESP3 type mapping expects HGETALL to be a map reply; handing it a
    // flat array there would mis-shape the result for callers.
    return result({ type: 'map', value: pairs.map(([f, v]) => [bulk(f), bulk(v)]) });
  } catch (e) {
    if (e instanceof WrongTypeError) return result(error(e.message));
    throw e;
  }
}

export function hmget(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2) return result(wrongArgsError('hmget'));
  const [key, ...fields] = args;
  try {
    // One entry per requested field, in request order; a missing field or
    // key is a nil bulk — which a script sees as `false`, as in Redis.
    return result(array(ctx.store.hmget(key, fields).map((v) => bulk(v))));
  } catch (e) {
    if (e instanceof WrongTypeError) return result(error(e.message));
    throw e;
  }
}

export function hincrbyfloat(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 3) return result(wrongArgsError('hincrbyfloat'));
  const [key, field, incrementRaw] = args;
  const increment = parseRedisFloat(incrementRaw);
  if (increment === null) return result(error('ERR value is not a valid float'));
  try {
    // Attributed to this node so the field replicates as a per-origin
    // PN-counter contribution (see Store.hincrbyfloat), not a field write.
    return result(bulk(ctx.store.hincrbyfloat(key, field, increment, ctx.cluster.nodeId)));
  } catch (e) {
    if (e instanceof WrongTypeError || e instanceof OutOfMemoryError || e instanceof NotAFloatError || e instanceof FloatOverflowError) {
      return result(error(e.message));
    }
    throw e;
  }
}
