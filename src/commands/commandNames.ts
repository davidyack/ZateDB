/**
 * The names of every command ZateDB implements, and which of them a Lua
 * script may invoke via `redis.call`/`redis.pcall`.
 *
 * Zero-import on purpose: the command coverage audit
 * (`scripts/commandCoverageAudit.ts`) runs in a consuming app's CI and must
 * not drag in the server (store, cluster, Lua VM, telemetry) just to learn
 * the command surface. `dispatcher.ts` declares its `COMMANDS` table with
 * `satisfies Record<ImplementedCommand, CommandSpec>`, so a command added to
 * one list and not the other fails `tsc` — this list cannot drift from what
 * the dispatcher actually serves.
 */
export const IMPLEMENTED_COMMANDS = [
  'PING',
  'INFO',
  'HELLO',
  'AUTH',
  'CLIENT',
  'QUIT',
  'GET',
  'SET',
  'MGET',
  'MSET',
  'DEL',
  'EXISTS',
  'INCR',
  'EXPIRE',
  'PEXPIRE',
  'TTL',
  'PTTL',
  'SCAN',
  'HSET',
  'HDEL',
  'HGETALL',
  'HMGET',
  'HINCRBYFLOAT',
  'ZADD',
  'ZREMRANGEBYSCORE',
  'ZCOUNT',
  'EVAL',
  'EVALSHA',
  'SCRIPT',
  'PUBLISH',
  'SUBSCRIBE',
  'PSUBSCRIBE',
  'UNSUBSCRIBE',
  'PUNSUBSCRIBE',
  'PUBSUB',
] as const;

export type ImplementedCommand = (typeof IMPLEMENTED_COMMANDS)[number];

const IMPLEMENTED: ReadonlySet<string> = new Set(IMPLEMENTED_COMMANDS);

/**
 * Commands a script may not invoke via redis.call. Connection/session state
 * (AUTH, subscriber mode), blocking or fan-out semantics, and nested scripting
 * have no coherent meaning inside a synchronous script, so Redis flags them
 * `noscript`; we mirror that. Everything else implemented — the data
 * commands — is callable.
 */
export const NOT_ALLOWED_IN_SCRIPT: ReadonlySet<string> = new Set<ImplementedCommand>([
  'EVAL',
  'EVALSHA',
  'SCRIPT',
  'SUBSCRIBE',
  'PSUBSCRIBE',
  'UNSUBSCRIBE',
  'PUNSUBSCRIBE',
  'AUTH',
  'HELLO',
  'CLIENT',
  'QUIT',
]);

/** True when ZateDB implements `command` (case-insensitive). */
export function isKnownCommand(command: string): boolean {
  return IMPLEMENTED.has(command.toUpperCase());
}

/** True when a Lua script may call `command` via `redis.call`/`redis.pcall` (case-insensitive). */
export function isScriptCallableCommand(command: string): boolean {
  const upper = command.toUpperCase();
  return IMPLEMENTED.has(upper) && !NOT_ALLOWED_IN_SCRIPT.has(upper);
}
