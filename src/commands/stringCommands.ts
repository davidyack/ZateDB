import { bulk, integer, OK } from '../resp/types.js';
import { NotAnIntegerError, OutOfMemoryError, WrongTypeError } from '../store/types.js';
import type { ExpireFlag } from '../store/store.js';
import type { CommandContext, CommandResult } from './context.js';
import { result } from './context.js';
import { invalidExpireTimeError, notAnIntegerReplyError, unsupportedOptionError, wrongArgsError } from './errors.js';
import { error } from '../resp/types.js';

const EXPIRE_FLAGS: ReadonlySet<string> = new Set(['NX', 'XX', 'GT', 'LT']);

/** Strict Redis-style integer parse: rejects '', floats, and non-numeric text. */
function parseIntStrict(raw: string): number | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseExpireFlag(raw: string | undefined): ExpireFlag | undefined {
  if (raw === undefined) return undefined;
  const upper = raw.toUpperCase();
  return EXPIRE_FLAGS.has(upper) ? (upper as ExpireFlag) : undefined;
}

export function get(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 1) return result(wrongArgsError('get'));
  try {
    return result(bulk(ctx.store.get(args[0])));
  } catch (e) {
    return result(toRespError(e));
  }
}

export function set(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2) return result(wrongArgsError('set'));
  const [key, value, ...rest] = args;
  let exSeconds: number | undefined;
  let pxMs: number | undefined;

  for (let i = 0; i < rest.length; i++) {
    const opt = rest[i].toUpperCase();
    if (opt === 'EX' || opt === 'PX') {
      // A bad expiry value must be rejected, not silently coerced to NaN —
      // NaN produces a key whose expiry check never fires, i.e. one that
      // never expires. Mirror real Redis's two distinct errors.
      const parsed = parseIntStrict(rest[i + 1] ?? '');
      if (parsed === null) return result(notAnIntegerReplyError());
      if (parsed <= 0) return result(invalidExpireTimeError('set'));
      if (opt === 'EX') exSeconds = parsed;
      else pxMs = parsed;
      i++;
    } else {
      // NX/XX/GET/KEEPTTL and anything else are not implemented. Erroring
      // loudly (rather than accepting-and-ignoring) is the point: a silently
      // dropped `SET NX` hands a lock/idempotency caller success semantics it
      // never actually got. Better to break at integration time than in prod.
      return result(unsupportedOptionError('set', rest[i]));
    }
  }

  try {
    ctx.store.set(key, value, { exSeconds, pxMs });
    return result(OK);
  } catch (e) {
    return result(toRespError(e));
  }
}

export function del(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 1) return result(wrongArgsError('del'));
  return result(integer(ctx.store.del(args)));
}

export function incr(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 1) return result(wrongArgsError('incr'));
  try {
    // Attribute the increment to this node so INCR replicates as a
    // per-origin G-counter contribution (see Store.incr / the dispatcher's
    // increment-replication path). In standalone mode there's a single
    // origin, so the sum is just the count.
    return result(integer(ctx.store.incr(args[0], ctx.cluster.nodeId)));
  } catch (e) {
    return result(toRespError(e));
  }
}

export function expire(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2) return result(wrongArgsError('expire'));
  const [key, secondsRaw, flag] = args;
  // Real Redis EXPIRE takes an integer; a float would previously slip through
  // Number()/isFinite and be applied as a fractional-second TTL.
  const seconds = parseIntStrict(secondsRaw);
  if (seconds === null) return result(notAnIntegerReplyError());
  const ok = ctx.store.expire(key, seconds, parseExpireFlag(flag));
  return result(integer(ok ? 1 : 0));
}

export function pexpire(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2) return result(wrongArgsError('pexpire'));
  const [key, msRaw, flag] = args;
  const ms = parseIntStrict(msRaw);
  if (ms === null) return result(notAnIntegerReplyError());
  const ok = ctx.store.pexpire(key, ms, parseExpireFlag(flag));
  return result(integer(ok ? 1 : 0));
}

function toRespError(e: unknown) {
  if (e instanceof WrongTypeError) return error(e.message);
  if (e instanceof NotAnIntegerError) return error(e.message);
  if (e instanceof OutOfMemoryError) return error(e.message);
  throw e;
}
