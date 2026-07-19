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
  /**
   * Keys this command can mutate, given its args — declared once per
   * command right alongside its handler (rather than a separate
   * hand-maintained list elsewhere) so a future mutating command can't be
   * added to COMMANDS without a reviewer having to also remember a second
   * place to register it for cluster replication. Absent for read-only
   * and connection-management commands.
   */
  mutatedKeys?: (args: string[]) => string[];
}

function spec(
  handler: CommandHandler,
  opts: Partial<Pick<CommandSpec, 'allowedPreAuth' | 'allowedInSubscriberMode' | 'mutatedKeys'>> = {},
): CommandSpec {
  return {
    handler,
    allowedPreAuth: opts.allowedPreAuth ?? false,
    allowedInSubscriberMode: opts.allowedInSubscriberMode ?? false,
    mutatedKeys: opts.mutatedKeys,
  };
}

const singleKey = (args: string[]): string[] => (args.length > 0 ? [args[0]] : []);
const allArgsAsKeys = (args: string[]): string[] => args;

const COMMANDS: Record<string, CommandSpec> = {
  PING: spec(connectionCommands.ping, { allowedPreAuth: true, allowedInSubscriberMode: true }),
  HELLO: spec(connectionCommands.hello, { allowedPreAuth: true }),
  AUTH: spec(connectionCommands.auth, { allowedPreAuth: true }),
  CLIENT: spec(connectionCommands.client, { allowedPreAuth: true }),
  QUIT: spec(connectionCommands.quit, { allowedPreAuth: true, allowedInSubscriberMode: true }),

  GET: spec(stringCommands.get),
  SET: spec(stringCommands.set, { mutatedKeys: singleKey }),
  DEL: spec(stringCommands.del, { mutatedKeys: allArgsAsKeys }),
  INCR: spec(stringCommands.incr, { mutatedKeys: singleKey }),
  EXPIRE: spec(stringCommands.expire, { mutatedKeys: singleKey }),
  PEXPIRE: spec(stringCommands.pexpire, { mutatedKeys: singleKey }),

  HSET: spec(hashCommands.hset, { mutatedKeys: singleKey }),
  HDEL: spec(hashCommands.hdel, { mutatedKeys: singleKey }),
  HGETALL: spec(hashCommands.hgetall),

  ZADD: spec(sortedSetCommands.zadd, { mutatedKeys: singleKey }),
  ZREMRANGEBYSCORE: spec(sortedSetCommands.zremrangebyscore, { mutatedKeys: singleKey }),
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

  // Candidate keys and their prior existence are captured *before* running
  // the handler — a command like EXPIRE/HDEL/ZREMRANGEBYSCORE/DEL against
  // a key this node doesn't have is a true no-op (nothing changed here),
  // and must not replicate at all: doing so would broadcast a phantom
  // "this key is deleted" fact that could clobber a real value another
  // node already holds (e.g. one this node hasn't replicated in yet).
  // SET/INCR/HSET/ZADD always leave the key existing afterward, so they
  // still replicate correctly regardless of whether it existed before.
  // Skipped entirely in standalone mode (the default/common case), where
  // ctx.cluster.publishKeyChange is a no-op anyway — no reason to pay for
  // an existence check per key on every command when nothing consumes it.
  const replicating = ctx.cluster.haEnabled && cmdSpec.mutatedKeys !== undefined;
  const candidateKeys = replicating ? cmdSpec.mutatedKeys!(args) : [];
  const existedBefore = replicating ? candidateKeys.map((key) => ctx.store.exists(key)) : [];

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
    } else if (replicating) {
      candidateKeys.forEach((key, i) => {
        if (existedBefore[i] || ctx.store.exists(key)) ctx.cluster.publishKeyChange(key);
      });
    }
  }

  return { command, ...outcome, isError };
}

export function isKnownCommand(command: string): boolean {
  return command.toUpperCase() in COMMANDS;
}
