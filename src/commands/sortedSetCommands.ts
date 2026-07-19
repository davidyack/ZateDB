import { error, integer } from '../resp/types.js';
import { OutOfMemoryError, WrongTypeError } from '../store/types.js';
import { InvalidScoreRangeError, parseScoreBound } from '../store/scoreRange.js';
import type { CommandContext, CommandResult } from './context.js';
import { result } from './context.js';
import { wrongArgsError } from './errors.js';

export function zadd(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 3 || args.length % 2 !== 1) return result(wrongArgsError('zadd'));
  const [key, ...rest] = args;
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i < rest.length; i += 2) {
    const score = Number(rest[i]);
    if (Number.isNaN(score)) return result(error('ERR value is not a valid float'));
    pairs.push([score, rest[i + 1]]);
  }
  try {
    return result(integer(ctx.store.zadd(key, pairs)));
  } catch (e) {
    if (e instanceof WrongTypeError || e instanceof OutOfMemoryError) return result(error(e.message));
    throw e;
  }
}

export function zremrangebyscore(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 3) return result(wrongArgsError('zremrangebyscore'));
  const [key, minRaw, maxRaw] = args;
  try {
    const min = parseScoreBound(minRaw);
    const max = parseScoreBound(maxRaw);
    return result(integer(ctx.store.zremrangebyscore(key, min, max)));
  } catch (e) {
    if (e instanceof InvalidScoreRangeError) return result(error(e.message));
    if (e instanceof WrongTypeError) return result(error(e.message));
    throw e;
  }
}

export function zcount(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 3) return result(wrongArgsError('zcount'));
  const [key, minRaw, maxRaw] = args;
  try {
    const min = parseScoreBound(minRaw);
    const max = parseScoreBound(maxRaw);
    return result(integer(ctx.store.zcount(key, min, max)));
  } catch (e) {
    if (e instanceof InvalidScoreRangeError) return result(error(e.message));
    if (e instanceof WrongTypeError) return result(error(e.message));
    throw e;
  }
}
