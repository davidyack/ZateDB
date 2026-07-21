import { array, bulk, integer, OK, simple } from '../resp/types.js';
import type { RespValue } from '../resp/types.js';
import type { CommandContext, CommandResult } from './context.js';
import { result } from './context.js';
import { invalidPasswordError, noProtoError, wrongArgsError } from './errors.js';
import { secureEqual } from '../util/secureCompare.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

export function ping(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length > 1) return result(wrongArgsError('ping'));
  return result(args.length === 1 ? bulk(args[0]) : simple('PONG'));
}

/**
 * Negotiates the connection's RESP protocol version. Both RESP2 and RESP3
 * are supported side by side, per-connection — a client that asks for
 * RESP3 (e.g. node-redis v6+, which sends HELLO 3 by default) gets real
 * RESP3 replies (maps, push frames, `_` nulls); a client that never sends
 * HELLO, or explicitly asks for RESP2, keeps getting today's RESP2 wire
 * format. Anything other than 2 or 3 is rejected with NOPROTO, matching
 * real Redis.
 */
export function hello(ctx: CommandContext, args: string[]): CommandResult {
  // args may include: [protover] [AUTH username password] [SETNAME clientname]
  let i = 0;
  let protover = ctx.conn.protover;
  if (args.length > 0 && /^\d+$/.test(args[0])) {
    const requested = Number(args[0]);
    if (requested !== 2 && requested !== 3) return result(noProtoError());
    protover = requested;
    i = 1;
  }

  for (; i < args.length; i++) {
    const sub = args[i].toUpperCase();
    if (sub === 'AUTH' && i + 2 < args.length) {
      const password = args[i + 2];
      if (!checkAuth(ctx, password)) return failedAuth(ctx);
      ctx.conn.authenticated = true;
      ctx.conn.failedAuthCount = 0;
      i += 2;
    } else if (sub === 'SETNAME' && i + 1 < args.length) {
      ctx.conn.clientName = args[i + 1];
      i += 1;
    }
  }

  ctx.conn.protover = protover;

  const fields: Array<[string, RespValue]> = [
    ['server', bulk(SERVER_NAME)],
    ['version', bulk(SERVER_VERSION)],
    ['proto', integer(protover)],
    ['id', integer(hashConnId(ctx.conn.id))],
    ['mode', bulk('standalone')],
    ['role', bulk('master')],
    ['modules', array([])],
  ];
  return result({ type: 'map', value: fields.map(([k, v]) => [bulk(k), v]) });
}

export function auth(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 1 || args.length > 2) return result(wrongArgsError('auth'));
  const password = args.length === 2 ? args[1] : args[0];
  if (!checkAuth(ctx, password)) return failedAuth(ctx);
  ctx.conn.authenticated = true;
  ctx.conn.failedAuthCount = 0;
  return result(OK);
}

function checkAuth(ctx: CommandContext, password: string): boolean {
  if (!ctx.config.authPassword) return true;
  return secureEqual(password, ctx.config.authPassword);
}

/**
 * Records a failed AUTH and, once a connection crosses
 * maxFailedAuthAttempts consecutive failures, closes it after the error
 * reply. That turns "unlimited back-to-back guesses on one socket" into "N
 * guesses per TCP connection," forcing a full reconnect + handshake per
 * burst — a large constant-factor slowdown for a line-speed brute force,
 * and one that makes the connection cap and any upstream connection-rate
 * limit actually bite. The reply is unchanged (a generic invalid-password
 * error) so it leaks nothing about how close a guess was.
 */
function failedAuth(ctx: CommandContext): CommandResult {
  ctx.conn.failedAuthCount++;
  const limit = ctx.config.maxFailedAuthAttempts;
  const closeAfter = limit > 0 && ctx.conn.failedAuthCount >= limit;
  return { frames: [invalidPasswordError()], closeAfter };
}

export function client(ctx: CommandContext, args: string[]): CommandResult {
  const sub = (args[0] ?? '').toUpperCase();
  if (sub === 'SETINFO') {
    // Ignored: node-redis sends lib-name/lib-ver on connect. Must not error.
    return result(OK);
  }
  if (sub === 'GETNAME') {
    return result(bulk(ctx.conn.clientName ?? ''));
  }
  if (sub === 'SETNAME' && args.length >= 2) {
    ctx.conn.clientName = args[1];
    return result(OK);
  }
  if (sub === 'ID') {
    return result(integer(hashConnId(ctx.conn.id)));
  }
  // Unrecognized CLIENT subcommands are accepted as no-ops rather than erroring,
  // since this is metadata plumbing that must never block a real client's handshake.
  return result(OK);
}

export function quit(): CommandResult {
  return { frames: [OK], closeAfter: true };
}

function hashConnId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}
