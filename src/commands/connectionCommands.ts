import { array, bulk, integer, OK, simple } from '../resp/types.js';
import type { RespValue } from '../resp/types.js';
import type { CommandContext, CommandResult } from './context.js';
import { result } from './context.js';
import { invalidPasswordError, wrongArgsError } from './errors.js';
import { secureEqual } from '../util/secureCompare.js';

export function ping(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length > 1) return result(wrongArgsError('ping'));
  return result(args.length === 1 ? bulk(args[0]) : simple('PONG'));
}

/**
 * Acknowledges HELLO without requiring RESP3 — the connection keeps
 * speaking RESP2 regardless of the requested protover. Real clients (e.g.
 * node-redis) use this to fetch server identity during the handshake.
 */
export function hello(ctx: CommandContext, args: string[]): CommandResult {
  // args may include: [protover] [AUTH username password] [SETNAME clientname]
  let i = 0;
  if (args.length > 0 && /^\d+$/.test(args[0])) i = 1;

  for (; i < args.length; i++) {
    const sub = args[i].toUpperCase();
    if (sub === 'AUTH' && i + 2 < args.length) {
      const password = args[i + 2];
      if (!checkAuth(ctx, password)) return result(invalidPasswordError());
      ctx.conn.authenticated = true;
      i += 2;
    } else if (sub === 'SETNAME' && i + 1 < args.length) {
      ctx.conn.clientName = args[i + 1];
      i += 1;
    }
  }

  const fields: Array<[string, RespValue]> = [
    ['server', bulk('backendcache')],
    ['version', bulk('1.0.0')],
    ['proto', integer(2)],
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
  if (!checkAuth(ctx, password)) return result(invalidPasswordError());
  ctx.conn.authenticated = true;
  return result(OK);
}

function checkAuth(ctx: CommandContext, password: string): boolean {
  if (!ctx.config.authPassword) return true;
  return secureEqual(password, ctx.config.authPassword);
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
