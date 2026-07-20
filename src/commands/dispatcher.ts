import type { CommandContext, CommandHandler, CommandResult } from './context.js';
import { notAuthenticatedError, subscriberModeError, unknownCommandError } from './errors.js';
import * as connectionCommands from './connectionCommands.js';
import * as stringCommands from './stringCommands.js';
import * as hashCommands from './hashCommands.js';
import * as sortedSetCommands from './sortedSetCommands.js';
import * as pubsubCommands from './pubsubCommands.js';
import * as scriptingCommands from './scriptingCommands.js';

export interface CommandSpec {
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
   * and connection-management commands, and for the field-level commands
   * below (they replicate at field/member granularity instead — see
   * `fieldReplication`).
   */
  mutatedKeys?: (args: string[]) => string[];
  /**
   * HSET/HDEL/ZADD/ZREMRANGEBYSCORE replicate only the specific
   * fields/members they touched (not the whole hash/sorted set) — see
   * replicateFieldLevelMutation. This flag routes them there instead of
   * through the generic whole-key `mutatedKeys` path.
   */
  fieldReplication?: 'hash' | 'zset';
  /**
   * EXPIRE/PEXPIRE replicate only the key's new TTL, not a whole-entry
   * snapshot — otherwise an EXPIRE on a hash/sorted set would ship (and
   * overwrite peers with) the entire entry, clobbering field/member writes
   * those peers hold but this node hasn't received yet. Routes to the
   * TTL-only path (ClusterCoordinator.publishTtlChange) instead of the
   * whole-key `mutatedKeys` path.
   */
  ttlReplication?: boolean;
  /**
   * INCR replicates as a commutative per-origin G-counter contribution, not
   * a whole-key last-write-wins upsert — otherwise concurrent cross-node
   * increments undercount under contention (the flagship rate-limit
   * failure). Routes to ClusterCoordinator.publishIncrement.
   */
  incrementReplication?: boolean;
}

function spec(
  handler: CommandHandler,
  opts: Partial<
    Pick<CommandSpec, 'allowedPreAuth' | 'allowedInSubscriberMode' | 'mutatedKeys' | 'fieldReplication' | 'ttlReplication' | 'incrementReplication'>
  > = {},
): CommandSpec {
  return {
    handler,
    allowedPreAuth: opts.allowedPreAuth ?? false,
    allowedInSubscriberMode: opts.allowedInSubscriberMode ?? false,
    mutatedKeys: opts.mutatedKeys,
    fieldReplication: opts.fieldReplication,
    ttlReplication: opts.ttlReplication,
    incrementReplication: opts.incrementReplication,
  };
}

const singleKey = (args: string[]): string[] => (args.length > 0 ? [args[0]] : []);
const allArgsAsKeys = (args: string[]): string[] => args;
/** MSET args are [key value key value ...]; the mutated keys are the even positions. */
const msetKeys = (args: string[]): string[] => args.filter((_, i) => i % 2 === 0);

export const COMMANDS: Record<string, CommandSpec> = {
  PING: spec(connectionCommands.ping, { allowedPreAuth: true, allowedInSubscriberMode: true }),
  HELLO: spec(connectionCommands.hello, { allowedPreAuth: true }),
  AUTH: spec(connectionCommands.auth, { allowedPreAuth: true }),
  CLIENT: spec(connectionCommands.client, { allowedPreAuth: true }),
  QUIT: spec(connectionCommands.quit, { allowedPreAuth: true, allowedInSubscriberMode: true }),

  GET: spec(stringCommands.get),
  SET: spec(stringCommands.set, { mutatedKeys: singleKey }),
  MGET: spec(stringCommands.mget),
  MSET: spec(stringCommands.mset, { mutatedKeys: msetKeys }),
  DEL: spec(stringCommands.del, { mutatedKeys: allArgsAsKeys }),
  EXISTS: spec(stringCommands.exists),
  INCR: spec(stringCommands.incr, { incrementReplication: true }),
  EXPIRE: spec(stringCommands.expire, { ttlReplication: true }),
  PEXPIRE: spec(stringCommands.pexpire, { ttlReplication: true }),
  TTL: spec(stringCommands.ttl),
  PTTL: spec(stringCommands.pttl),
  SCAN: spec(stringCommands.scan),

  HSET: spec(hashCommands.hset, { fieldReplication: 'hash' }),
  HDEL: spec(hashCommands.hdel, { fieldReplication: 'hash' }),
  HGETALL: spec(hashCommands.hgetall),

  ZADD: spec(sortedSetCommands.zadd, { fieldReplication: 'zset' }),
  ZREMRANGEBYSCORE: spec(sortedSetCommands.zremrangebyscore, { fieldReplication: 'zset' }),
  ZCOUNT: spec(sortedSetCommands.zcount),

  EVAL: spec(scriptingCommands.evalCommand),
  EVALSHA: spec(scriptingCommands.evalshaCommand),
  SCRIPT: spec(scriptingCommands.scriptCommand),

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

/**
 * HDEL/ZREMRANGEBYSCORE both need to know *which* fields/members actually
 * existed before the command ran, not just which ones the client asked to
 * remove: a client can (and defensively often does) name fields that were
 * never present on this node — e.g. HDEL h a b where b only exists on
 * another node's copy, not yet replicated here. Replicating "b was
 * deleted" in that case would destroy a real value that node holds.
 * ZREMRANGEBYSCORE never gets an explicit field list to begin with (a
 * score range doesn't say which members it will match until the command
 * actually runs), so it always needs the before-snapshot; HDEL only needs
 * it to filter its explicit args down to the ones that actually existed.
 * HSET/ZADD don't need any of this — they only ever set fields/members
 * named directly in their own args, never delete anything.
 */
interface FieldReplicationPrep {
  hashFieldsBefore: Set<string> | null;
  zsetMembersBefore: Set<string> | null;
}

function prepareFieldReplication(ctx: CommandContext, command: string, key: string): FieldReplicationPrep {
  if (command !== 'HDEL' && command !== 'ZREMRANGEBYSCORE') {
    return { hashFieldsBefore: null, zsetMembersBefore: null };
  }
  const entry = ctx.store.getRawEntry(key);
  return {
    hashFieldsBefore: command === 'HDEL' && entry?.type === 'hash' ? new Set(entry.fields.keys()) : null,
    zsetMembersBefore: command === 'ZREMRANGEBYSCORE' && entry?.type === 'sortedset' ? new Set(entry.members.keys()) : null,
  };
}

/**
 * Called after a successful HSET/HDEL/ZADD/ZREMRANGEBYSCORE to replicate
 * only the fields/members it actually touched, reading the authoritative
 * post-mutation value back from the local store rather than re-deriving
 * it from args (so replication can never drift from whatever the command
 * actually stored).
 *
 * HDEL/ZREMRANGEBYSCORE never fall back to a whole-key delete even when
 * removing the last field/member empties this node's local copy: another
 * node may still hold fields/members that haven't replicated in yet, and
 * there's no client-observable difference anyway between "hash/sorted-set
 * exists with zero fields/members" and "key is gone" (HGETALL/ZCOUNT
 * return the same empty result either way, and no EXISTS/TYPE command is
 * exposed) — so it's strictly safer to always replicate at field/member
 * granularity here and let each node clean up its own empty local entry
 * independently (see Store.applyReplicatedHashFieldDelete/
 * applyReplicatedZsetMemberDelete).
 */
function replicateFieldLevelMutation(ctx: CommandContext, command: string, args: string[], prep: FieldReplicationPrep): void {
  const key = args[0];

  if (command === 'HSET') {
    const entry = ctx.store.getRawEntry(key);
    if (entry?.type !== 'hash') return;
    const setFields: Array<[string, string]> = [];
    for (let i = 1; i < args.length; i += 2) {
      const field = args[i];
      const value = entry.fields.get(field);
      if (value !== undefined) setFields.push([field, value]);
    }
    ctx.cluster.publishHashFieldChange(key, setFields, []);
    return;
  }

  if (command === 'HDEL') {
    const requested = args.slice(1);
    const actuallyRemoved = prep.hashFieldsBefore ? requested.filter((field) => prep.hashFieldsBefore!.has(field)) : [];
    if (actuallyRemoved.length > 0) ctx.cluster.publishHashFieldChange(key, [], actuallyRemoved);
    return;
  }

  if (command === 'ZADD') {
    const entry = ctx.store.getRawEntry(key);
    if (entry?.type !== 'sortedset') return;
    const setMembers: Array<[string, number]> = [];
    for (let i = 2; i < args.length; i += 2) {
      const member = args[i];
      const score = entry.members.get(member);
      if (score !== undefined) setMembers.push([member, score]);
    }
    ctx.cluster.publishZsetMemberChange(key, setMembers, []);
    return;
  }

  if (command === 'ZREMRANGEBYSCORE') {
    if (!prep.zsetMembersBefore) return;
    const entry = ctx.store.getRawEntry(key);
    const afterMembers = entry?.type === 'sortedset' ? entry.members : null;
    const removed = Array.from(prep.zsetMembersBefore).filter((member) => !afterMembers?.has(member));
    if (removed.length > 0) ctx.cluster.publishZsetMemberChange(key, [], removed);
  }
}

/** True when a command's reply is the integer `:1` — how EXPIRE/PEXPIRE signal "the TTL was actually applied". */
function didApply(outcome: CommandResult): boolean {
  const frame = outcome.frames[0];
  return frame?.type === 'integer' && frame.value === 1;
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

  return runCommand(ctx, command, args, cmdSpec);
}

/**
 * Runs an already-resolved command: captures any pre-mutation state HA
 * replication needs, invokes the handler, then ships the resulting effects to
 * the cluster. Shared by dispatch() (top-level client commands) and by script
 * execution (redis.call inside EVAL) so a mutation performed inside a script
 * replicates exactly like the same command sent directly — Redis's "effects
 * replication". The connection-level gates (auth, subscriber mode) live in
 * dispatch() and are intentionally NOT repeated here: a script runs with the
 * privileges its already-authenticated connection holds.
 */
export function runCommand(ctx: CommandContext, command: string, args: string[], cmdSpec: CommandSpec): DispatchOutcome {
  // Everything captured here happens *before* running the handler, and is
  // skipped entirely in standalone mode (the default/common case), where
  // it would just be discarded — no reason to pay for existence checks or
  // member-name snapshots when nothing downstream consumes them.
  const replicatingWholeKey = ctx.cluster.haEnabled && cmdSpec.mutatedKeys !== undefined;
  const replicatingFields = ctx.cluster.haEnabled && cmdSpec.fieldReplication !== undefined;

  // Candidate keys and their prior existence are captured *before* running
  // the handler — a command like EXPIRE/DEL against a key this node
  // doesn't have is a true no-op (nothing changed here), and must not
  // replicate at all: doing so would broadcast a phantom "this key is
  // deleted" fact that could clobber a real value another node already
  // holds (e.g. one this node hasn't replicated in yet). SET/INCR always
  // leave the key existing afterward, so they still replicate correctly
  // regardless of whether it existed before.
  const candidateKeys = replicatingWholeKey ? cmdSpec.mutatedKeys!(args) : [];
  const existedBefore = replicatingWholeKey ? candidateKeys.map((key) => ctx.store.exists(key)) : [];
  const fieldPrep = replicatingFields ? prepareFieldReplication(ctx, command, args[0]) : null;

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
    } else if (replicatingFields && fieldPrep) {
      replicateFieldLevelMutation(ctx, command, args, fieldPrep);
    } else if (ctx.cluster.haEnabled && cmdSpec.incrementReplication) {
      // INCR always mutates (creates or increments), so there's no no-op to
      // filter — replicate this node's new cumulative contribution.
      ctx.cluster.publishIncrement(args[0]);
    } else if (ctx.cluster.haEnabled && cmdSpec.ttlReplication) {
      // Replicate only when the TTL actually changed. EXPIRE/PEXPIRE reply
      // :1 when they applied and :0 when they didn't (key absent, or an
      // NX/XX/GT/LT flag condition not met) — a :0 changed nothing here, so
      // replicating it would be a wasted write at best and, for the
      // key-absent case, a phantom TTL for a key another node may hold.
      const key = args[0];
      if (didApply(outcome) && ctx.store.exists(key)) {
        ctx.cluster.publishTtlChange(key, ctx.store.getRawEntry(key)?.expiresAtMs ?? null);
      }
    } else if (replicatingWholeKey) {
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
