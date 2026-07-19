import type { CommandContext, CommandHandler, CommandResult } from './context.js';
import { notAuthenticatedError, subscriberModeError, unknownCommandError } from './errors.js';
import * as connectionCommands from './connectionCommands.js';
import * as stringCommands from './stringCommands.js';
import * as hashCommands from './hashCommands.js';
import * as sortedSetCommands from './sortedSetCommands.js';
import * as pubsubCommands from './pubsubCommands.js';

interface CommandSpec {
  handler: CommandHandler;
  /** Allowed before AUTH completes, when auth is required. */
  allowedPreAuth: boolean;
  /** Allowed while the connection is in subscriber-only mode. */
  allowedInSubscriberMode: boolean;
}

function spec(handler: CommandHandler, opts: Partial<Pick<CommandSpec, 'allowedPreAuth' | 'allowedInSubscriberMode'>> = {}): CommandSpec {
  return {
    handler,
    allowedPreAuth: opts.allowedPreAuth ?? false,
    allowedInSubscriberMode: opts.allowedInSubscriberMode ?? false,
  };
}

const COMMANDS: Record<string, CommandSpec> = {
  PING: spec(connectionCommands.ping, { allowedPreAuth: true, allowedInSubscriberMode: true }),
  HELLO: spec(connectionCommands.hello, { allowedPreAuth: true }),
  AUTH: spec(connectionCommands.auth, { allowedPreAuth: true }),
  CLIENT: spec(connectionCommands.client, { allowedPreAuth: true }),
  QUIT: spec(connectionCommands.quit, { allowedPreAuth: true, allowedInSubscriberMode: true }),

  GET: spec(stringCommands.get),
  SET: spec(stringCommands.set),
  DEL: spec(stringCommands.del),
  INCR: spec(stringCommands.incr),
  EXPIRE: spec(stringCommands.expire),
  PEXPIRE: spec(stringCommands.pexpire),

  HSET: spec(hashCommands.hset),
  HDEL: spec(hashCommands.hdel),
  HGETALL: spec(hashCommands.hgetall),

  ZADD: spec(sortedSetCommands.zadd),
  ZREMRANGEBYSCORE: spec(sortedSetCommands.zremrangebyscore),
  ZCOUNT: spec(sortedSetCommands.zcount),

  PUBLISH: spec(pubsubCommands.publish),
  SUBSCRIBE: spec(pubsubCommands.subscribe, { allowedInSubscriberMode: true }),
  PSUBSCRIBE: spec(pubsubCommands.psubscribe, { allowedInSubscriberMode: true }),
  UNSUBSCRIBE: spec(pubsubCommands.unsubscribe, { allowedInSubscriberMode: true }),
  PUNSUBSCRIBE: spec(pubsubCommands.punsubscribe, { allowedInSubscriberMode: true }),
};

export interface DispatchOutcome extends CommandResult {
  command: string;
  isError: boolean;
}

/** Single-key mutating commands — the affected key is always args[0]. */
const SINGLE_KEY_MUTATORS: ReadonlySet<string> = new Set([
  'SET',
  'INCR',
  'EXPIRE',
  'PEXPIRE',
  'HSET',
  'HDEL',
  'ZADD',
  'ZREMRANGEBYSCORE',
]);

/** Keys touched by a successful mutating command, for cluster replication. DEL can touch several. */
function mutatedKeysFor(command: string, args: string[]): string[] {
  if (command === 'DEL') return args;
  if (SINGLE_KEY_MUTATORS.has(command) && args.length > 0) return [args[0]];
  return [];
}

export function dispatch(ctx: CommandContext, rawArgs: string[]): DispatchOutcome {
  const command = (rawArgs[0] ?? '').toUpperCase();
  const args = rawArgs.slice(1);
  const cmdSpec = COMMANDS[command];

  if (!cmdSpec) {
    return { command, frames: [unknownCommandError(rawArgs[0] ?? '', args)], isError: true };
  }

  if (ctx.config.authPassword && !ctx.conn.authenticated && !cmdSpec.allowedPreAuth) {
    return { command, frames: [notAuthenticatedError()], isError: true };
  }

  if (ctx.conn.mode === 'subscriber' && !cmdSpec.allowedInSubscriberMode) {
    return { command, frames: [subscriberModeError(command)], isError: true };
  }

  const outcome = cmdSpec.handler(ctx, args);
  const isError = outcome.frames.some((f) => f.type === 'error');

  // Cluster replication is centralized here (rather than in each command
  // handler) so the handlers stay unaware of HA at all: the in-memory
  // mutation already happened synchronously above, and this only decides
  // what to ship out to the durable store / other nodes. Fire-and-forget —
  // the client's reply already reflects the fast local result.
  if (!isError) {
    if (command === 'PUBLISH') {
      ctx.cluster.publishMessage(args[0], args[1]);
    } else {
      for (const key of mutatedKeysFor(command, args)) ctx.cluster.publishKeyChange(key);
    }
  }

  return { command, ...outcome, isError };
}

export function isKnownCommand(command: string): boolean {
  return command.toUpperCase() in COMMANDS;
}
