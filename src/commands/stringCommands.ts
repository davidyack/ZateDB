import { array, bulk, integer, NIL, OK } from '../resp/types.js';
import { NotAnIntegerError, OutOfMemoryError, WrongTypeError } from '../store/types.js';
import type { EntryTypeName } from '../store/types.js';
import type { ExpireFlag } from '../store/store.js';
import { globToRegExp } from '../pubsub/glob.js';
import type { CommandContext, CommandResult } from './context.js';
import { result } from './context.js';
import {
  invalidCursorError,
  invalidExpireTimeError,
  notAnIntegerReplyError,
  syntaxError,
  unsupportedOptionError,
  wrongArgsError,
} from './errors.js';
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
  let keepTtl = false;
  let nx = false;
  let xx = false;
  let get = false;

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
    } else if (opt === 'KEEPTTL') {
      keepTtl = true;
    } else if (opt === 'NX') {
      nx = true;
    } else if (opt === 'XX') {
      xx = true;
    } else if (opt === 'GET') {
      get = true;
    } else {
      // EX/PX/KEEPTTL/NX/XX/GET are handled above. Any other token is a real
      // but unimplemented SET option (e.g. EXAT/PXAT/IDLE); error loudly rather
      // than accept-and-ignore, so a caller relying on it breaks at integration
      // time instead of silently getting the wrong semantics in prod.
      return result(unsupportedOptionError('set', rest[i]));
    }
  }

  // Mutually-exclusive combinations Redis rejects outright.
  if (nx && xx) return result(syntaxError());
  if (keepTtl && (exSeconds !== undefined || pxMs !== undefined)) return result(syntaxError());

  try {
    const { set: didSet, oldValue } = ctx.store.set(key, value, { exSeconds, pxMs, keepTtl, nx, xx, get });
    // With GET, the reply is always the prior value (nil if absent), whether or
    // not the NX/XX condition let the write through. Without GET, a skipped
    // conditional write replies nil and a successful write replies OK.
    if (get) return result(bulk(oldValue));
    return result(didSet ? OK : NIL);
  } catch (e) {
    return result(toRespError(e));
  }
}

export function mget(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 1) return result(wrongArgsError('mget'));
  return result(array(ctx.store.mget(args).map((v) => bulk(v))));
}

export function mset(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2 || args.length % 2 !== 0) return result(wrongArgsError('mset'));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  ctx.store.mset(pairs);
  return result(OK);
}

export function exists(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 1) return result(wrongArgsError('exists'));
  return result(integer(ctx.store.existsCount(args)));
}

export function ttl(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 1) return result(wrongArgsError('ttl'));
  const ms = ctx.store.pttlMs(args[0]);
  // -2 (missing) and -1 (no TTL) pass through unchanged; otherwise round to
  // the nearest second, as real Redis does.
  return result(integer(ms < 0 ? ms : Math.round(ms / 1000)));
}

export function pttl(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length !== 1) return result(wrongArgsError('pttl'));
  return result(integer(ctx.store.pttlMs(args[0])));
}

const SCANNABLE_TYPES: ReadonlySet<string> = new Set(['string', 'hash', 'sortedset']);

export function scan(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 1) return result(wrongArgsError('scan'));
  const [cursorRaw, ...rest] = args;
  // The cursor is opaque to callers; we always complete in one page, so any
  // valid non-negative integer cursor is accepted and iteration terminates at 0.
  if (!/^\d+$/.test(cursorRaw)) return result(invalidCursorError());

  let match: RegExp | null = null;
  let type: EntryTypeName | null = null;
  let impossibleType = false;

  for (let i = 0; i < rest.length; i++) {
    const opt = rest[i].toUpperCase();
    if (opt === 'MATCH') {
      const pattern = rest[i + 1];
      if (pattern === undefined) return result(syntaxError());
      match = globToRegExp(pattern);
      i++;
    } else if (opt === 'COUNT') {
      // COUNT is only a hint; validate it like Redis but otherwise ignore it.
      const parsed = parseIntStrict(rest[i + 1] ?? '');
      if (parsed === null || parsed < 1) return result(syntaxError());
      i++;
    } else if (opt === 'TYPE') {
      const raw = rest[i + 1];
      if (raw === undefined) return result(syntaxError());
      const t = raw.toLowerCase();
      // An unknown/unsupported type simply matches nothing, as in Redis.
      if (SCANNABLE_TYPES.has(t)) type = t as EntryTypeName;
      else impossibleType = true;
      i++;
    } else {
      return result(syntaxError());
    }
  }

  const keys = impossibleType ? [] : ctx.store.scanKeys(match, type);
  // [ nextCursor, [keys...] ]; cursor "0" signals iteration complete.
  return result(array([bulk('0'), array(keys.map((k) => bulk(k)))]));
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
