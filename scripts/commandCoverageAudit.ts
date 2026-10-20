#!/usr/bin/env tsx
/**
 * CI gate (design spec §13.4): scans the consuming app's source tree for
 * Redis commands and diffs the set actually used against the command table
 * ZateDB implements (§7 — `src/commands/commandNames.ts`, which tsc holds
 * identical to the dispatcher's table). Fails when the consuming app uses a
 * command ZateDB doesn't support — the same class of gap that let the
 * sorted-set commands slip out of the first draft of this spec.
 *
 * Usage:
 *   npm run coverage-audit -- <path-to-consuming-app-src> [--include-tests]
 *
 * Two independent scans:
 *
 * 1. **Client call sites.** Tracks variables assigned from a call to a
 *    configurable "get client" factory (default names: getRedisClient,
 *    redisClient, getRedisPubSubClients) and reports node-redis method calls
 *    made on those variables, mapped to their RESP command names.
 *
 * 2. **Commands inside Lua scripts.** Every string / template literal in the
 *    source is scanned for `redis.call(...)` / `redis.pcall(...)`, so a script
 *    held in a module constant is caught no matter how it reaches
 *    EVAL / EVALSHA / SCRIPT LOAD. A literal command name is checked against
 *    the commands a script may call; a few literal OPTIONS ZateDB rejects are
 *    checked too (ZADD flags, SET options other than EX/PX/KEEPTTL/NX/XX/GET).
 *    A command name that isn't a literal (`redis.call(cmd, ...)`) can't be
 *    checked and is reported as a warning, not a failure.
 *
 * Test files (`__tests__/`, `test/`, `*.test.*`, `*.spec.*`) are skipped
 * unless `--include-tests` is passed: their scripts run against fakes, not
 * against ZateDB.
 *
 * Heuristic, not a full type-checker or Lua parser: it will not catch every
 * aliasing pattern (e.g. a client passed through several layers of
 * indirection, or a script assembled by string concatenation that splits a
 * `redis.call(` across pieces). Treat a clean run as a strong signal, not a
 * formal proof, and extend the heuristic if it misses a real call site.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isKnownCommand, isScriptCallableCommand } from '../src/commands/commandNames.js';

const CLIENT_FACTORY_NAMES = new Set(['getRedisClient', 'redisClient', 'getRedisPubSubClients']);

/** node-redis v5 camelCase method name -> RESP command name, for every command this audit understands. */
const METHOD_TO_COMMAND: Record<string, string> = {
  ping: 'PING',
  hello: 'HELLO',
  auth: 'AUTH',
  quit: 'QUIT',
  get: 'GET',
  set: 'SET',
  mGet: 'MGET',
  mSet: 'MSET',
  del: 'DEL',
  exists: 'EXISTS',
  incr: 'INCR',
  expire: 'EXPIRE',
  pExpire: 'PEXPIRE',
  ttl: 'TTL',
  pTTL: 'PTTL',
  scan: 'SCAN',
  hSet: 'HSET',
  hDel: 'HDEL',
  hGetAll: 'HGETALL',
  hmGet: 'HMGET',
  hIncrByFloat: 'HINCRBYFLOAT',
  zAdd: 'ZADD',
  zAddIncr: 'ZADD',
  zRemRangeByScore: 'ZREMRANGEBYSCORE',
  zCount: 'ZCOUNT',
  publish: 'PUBLISH',
  subscribe: 'SUBSCRIBE',
  pSubscribe: 'PSUBSCRIBE',
  unsubscribe: 'UNSUBSCRIBE',
  pUnsubscribe: 'PUNSUBSCRIBE',
  eval: 'EVAL',
  evalSha: 'EVALSHA',
  scriptLoad: 'SCRIPT',
  // Commonly-used commands ZateDB deliberately does not implement (§3) —
  // listed explicitly so a hit produces an actionable message, not a silent miss.
  incrBy: 'INCRBY',
  incrByFloat: 'INCRBYFLOAT',
  decr: 'DECR',
  decrBy: 'DECRBY',
  getDel: 'GETDEL',
  setNX: 'SETNX',
  setEx: 'SETEX',
  pSetEx: 'PSETEX',
  append: 'APPEND',
  expireAt: 'EXPIREAT',
  persist: 'PERSIST',
  rename: 'RENAME',
  unlink: 'UNLINK',
  keys: 'KEYS',
  type: 'TYPE',
  hGet: 'HGET',
  hExists: 'HEXISTS',
  hIncrBy: 'HINCRBY',
  hLen: 'HLEN',
  hKeys: 'HKEYS',
  hVals: 'HVALS',
  zCard: 'ZCARD',
  zRem: 'ZREM',
  zScore: 'ZSCORE',
  zIncrBy: 'ZINCRBY',
  zRange: 'ZRANGE',
  zRangeByScore: 'ZRANGEBYSCORE',
  zRank: 'ZRANK',
  lPush: 'LPUSH',
  rPush: 'RPUSH',
  lPop: 'LPOP',
  rPop: 'RPOP',
  lLen: 'LLEN',
  lRange: 'LRANGE',
  lRem: 'LREM',
  lTrim: 'LTRIM',
  sAdd: 'SADD',
  sRem: 'SREM',
  sMembers: 'SMEMBERS',
  sIsMember: 'SISMEMBER',
  sCard: 'SCARD',
  xAdd: 'XADD',
};

/** ZADD takes plain score/member pairs — every Redis flag is rejected. */
const ZADD_FLAGS: ReadonlySet<string> = new Set(['NX', 'XX', 'GT', 'LT', 'CH', 'INCR']);
/** The SET options ZateDB accepts (docs/command-reference.md); any other option word is `ERR unsupported option`. */
const SET_OPTIONS: ReadonlySet<string> = new Set(['EX', 'PX', 'KEEPTTL', 'NX', 'XX', 'GET']);

export interface CallSite {
  file: string;
  line: number;
  command: string;
  /** Set when the call passes options ZateDB rejects even though it implements the command. */
  unsupportedOption?: string;
}

export type ScriptFindingKind = 'ok' | 'unknown-command' | 'not-allowed-in-script' | 'unsupported-option' | 'dynamic-command';

export interface ScriptCommandSite {
  file: string;
  /** Line of the `redis.call(` inside the literal (1-based). */
  line: number;
  via: 'redis.call' | 'redis.pcall';
  /** Upper-cased command name; null when the first argument isn't a literal. */
  command: string | null;
  kind: ScriptFindingKind;
  detail?: string;
}

export interface AuditReport {
  clientSites: CallSite[];
  scriptSites: ScriptCommandSite[];
  /** Client call sites using a command ZateDB doesn't implement, or an option it rejects. */
  clientFailures: CallSite[];
  /** In-script commands that will fail at runtime on ZateDB. */
  scriptFailures: ScriptCommandSite[];
  /** In-script commands the audit could not check. */
  warnings: ScriptCommandSite[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'].includes(extname(full)) && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

/** Node-redis client method calls on variables obtained from a client factory. */
function findCallSites(file: string, sourceFile: ts.SourceFile): CallSite[] {
  const trackedIdentifiers = new Set<string>();
  const sites: CallSite[] = [];

  function isClientFactoryCall(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    return name !== null && CLIENT_FACTORY_NAMES.has(name);
  }

  function visit(node: ts.Node): void {
    // Track: const client = await getRedisClient(); / const client = getRedisClient();
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (isClientFactoryCall(init)) {
        trackedIdentifiers.add(node.name.text);
      }
    }

    // Report: client.methodName(...)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      const methodName = node.expression.name.text;
      if (ts.isIdentifier(target) && trackedIdentifiers.has(target.text) && Object.hasOwn(METHOD_TO_COMMAND, methodName)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const site: CallSite = { file, line: line + 1, command: METHOD_TO_COMMAND[methodName] };
        // node-redis: zAdd(key, members, options) — any options object is a ZADD flag; zAddIncr is ZADD INCR.
        if (methodName === 'zAddIncr') site.unsupportedOption = 'INCR';
        else if (methodName === 'zAdd' && node.arguments.length >= 3) site.unsupportedOption = 'NX/XX/GT/LT/CH (options argument)';
        sites.push(site);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

/** Stands in for a `${...}` substitution in a template literal — never a literal character. */
const SUBSTITUTION = '\u0000';

interface LiteralText {
  text: string;
  /** 1-based line of the first character of `text`. */
  startLine: number;
}

/** Cooked text of a string / template literal, with each substitution replaced by SUBSTITUTION. */
function literalText(node: ts.Node, sourceFile: ts.SourceFile): LiteralText | null {
  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, startLine: lineOf(node.getStart()) };
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += SUBSTITUTION + span.literal.text;
    return { text, startLine: lineOf(node.getStart()) };
  }
  return null;
}

interface LuaArg {
  raw: string;
  /** The value when the argument is a quoted string literal (or a bare number), else null. */
  literal: string | null;
}

/**
 * Splits the argument list of a Lua call starting just after its `(`.
 * Understands quoted strings (with escapes), `--` line comments and nesting,
 * which is all a `redis.call` argument list realistically contains.
 */
function splitLuaArgs(text: string, start: number): LuaArg[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else {
      current += ch;
    }
    i += 1;
  }
  if (current.trim() !== '') args.push(current);
  return args.map((raw) => {
    const trimmed = raw.trim();
    const quoted = /^(['"])((?:\\.|(?!\1).)*)\1$/s.exec(trimmed);
    if (quoted && !quoted[2].includes(SUBSTITUTION)) return { raw: trimmed, literal: quoted[2] };
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { raw: trimmed, literal: trimmed };
    return { raw: trimmed, literal: null };
  });
}

/** Literal option words in a call ZateDB would reject; null when none. */
function unsupportedLuaOption(command: string, args: LuaArg[]): string | null {
  const word = (a: LuaArg | undefined): string | null =>
    a?.literal != null && /^[A-Za-z]+$/.test(a.literal) ? a.literal.toUpperCase() : null;
  if (command === 'ZADD') {
    // ZADD key [NX|XX] [GT|LT] [CH] [INCR] score member ... — flags sit between the key and the first score.
    const flags: string[] = [];
    for (let i = 2; i < args.length; i += 1) {
      const w = word(args[i]);
      if (w === null || !ZADD_FLAGS.has(w)) break;
      flags.push(w);
    }
    return flags.length > 0 ? flags.join(' ') : null;
  }
  if (command === 'SET') {
    // SET key value [options] — numbers after EX/PX are values, not option words.
    const rejected = args.slice(3).map(word).filter((w): w is string => w !== null && !SET_OPTIONS.has(w));
    return rejected.length > 0 ? rejected.join(' ') : null;
  }
  return null;
}

/** Every `redis.call` / `redis.pcall` in one piece of literal text. */
function scanLuaText(file: string, lit: LiteralText): ScriptCommandSite[] {
  const sites: ScriptCommandSite[] = [];
  const pattern = /\bredis\s*\.\s*(p?call)\s*\(/g;
  for (let m = pattern.exec(lit.text); m !== null; m = pattern.exec(lit.text)) {
    const line = lit.startLine + (lit.text.slice(0, m.index).match(/\n/g)?.length ?? 0);
    const via = m[1] === 'pcall' ? 'redis.pcall' : 'redis.call';
    const args = splitLuaArgs(lit.text, m.index + m[0].length);
    const name = args[0]?.literal ?? null;
    if (name === null || !/^[A-Za-z][A-Za-z0-9_|]*$/.test(name)) {
      sites.push({
        file,
        line,
        via,
        command: null,
        kind: 'dynamic-command',
        detail: `command name is not a literal: ${(args[0]?.raw ?? '').replaceAll(SUBSTITUTION, '${…}') || '(none)'}`,
      });
      continue;
    }
    const command = name.toUpperCase();
    if (!isKnownCommand(command)) {
      sites.push({ file, line, via, command, kind: 'unknown-command' });
    } else if (!isScriptCallableCommand(command)) {
      sites.push({ file, line, via, command, kind: 'not-allowed-in-script' });
    } else {
      const option = unsupportedLuaOption(command, args);
      sites.push(option ? { file, line, via, command, kind: 'unsupported-option', detail: option } : { file, line, via, command, kind: 'ok' });
    }
  }
  return sites;
}

/** `redis.call`/`redis.pcall` inside every string and template literal in a file. */
function findScriptCommandSites(file: string, source: string, sourceFile: ts.SourceFile): ScriptCommandSite[] {
  if (!/redis\s*\.\s*p?call/.test(source)) return [];
  const sites: ScriptCommandSite[] = [];
  function visit(node: ts.Node): void {
    const lit = literalText(node, sourceFile);
    if (lit !== null && lit.text.includes('redis')) sites.push(...scanLuaText(file, lit));
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sites;
}

/** Audits in-memory sources — the testable core of the CLI below. */
export function auditSources(sources: Array<{ file: string; source: string }>): AuditReport {
  const clientSites: CallSite[] = [];
  const scriptSites: ScriptCommandSite[] = [];
  for (const { file, source } of sources) {
    const sourceFile = parse(file, source);
    clientSites.push(...findCallSites(file, sourceFile));
    scriptSites.push(...findScriptCommandSites(file, source, sourceFile));
  }
  return {
    clientSites,
    scriptSites,
    clientFailures: clientSites.filter((s) => !isKnownCommand(s.command) || s.unsupportedOption !== undefined),
    scriptFailures: scriptSites.filter((s) => s.kind !== 'ok' && s.kind !== 'dynamic-command'),
    warnings: scriptSites.filter((s) => s.kind === 'dynamic-command'),
  };
}

const TEST_PATH = /(^|[\\/])(__tests__|__mocks__|test|tests)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/;

function describeScriptFailure(site: ScriptCommandSite): string {
  switch (site.kind) {
    case 'unknown-command':
      return `${site.command}  (${site.via} — not implemented by ZateDB)`;
    case 'not-allowed-in-script':
      return `${site.command}  (${site.via} — not callable from a script)`;
    case 'unsupported-option':
      return `${site.command} ${site.detail}  (${site.via} — option rejected by ZateDB)`;
    default:
      return `${site.command}`;
  }
}

function main(argv: string[]): number {
  const includeTests = argv.includes('--include-tests');
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage: npm run coverage-audit -- <path-to-consuming-app-src> [--include-tests]');
    return 2;
  }

  const files = walk(target).filter((f) => includeTests || !TEST_PATH.test(f.slice(target.length)));
  const report = auditSources(files.map((file) => ({ file, source: readFileSync(file, 'utf8') })));
  const { clientSites, scriptSites, clientFailures, scriptFailures, warnings } = report;

  if (clientSites.length === 0 && scriptSites.length === 0) {
    console.log(`No tracked Redis client call sites or Lua redis.call sites found under ${target} (factory names: ${[...CLIENT_FACTORY_NAMES].join(', ')}).`);
    console.log('If the consuming app uses a different factory function name, add it to CLIENT_FACTORY_NAMES in this script.');
    return 0;
  }

  console.log(
    `Scanned ${files.length} file(s)${includeTests ? '' : ' (test files skipped; --include-tests to scan them)'}: ` +
      `${clientSites.length} client call site(s), ${scriptSites.length} Lua redis.call/pcall site(s).`,
  );
  const covered = (cmds: Array<string | null>): string => [...new Set(cmds)].sort().join(', ') || '(none)';
  console.log(`  Client commands covered by ZateDB: ${covered(clientSites.filter((s) => !clientFailures.includes(s)).map((s) => s.command))}`);
  console.log(`  Script commands covered by ZateDB: ${covered(scriptSites.filter((s) => s.kind === 'ok').map((s) => s.command))}`);

  if (warnings.length > 0) {
    console.warn('\nWarning — Lua redis.call sites whose command name could not be checked (verify by hand):');
    for (const site of warnings) console.warn(`  ${site.file}:${site.line}  ${site.via}: ${site.detail}`);
  }

  if (clientFailures.length > 0) {
    console.error('\nClient calls ZateDB will reject:');
    for (const site of clientFailures) {
      const why = site.unsupportedOption
        ? `${site.command} ${site.unsupportedOption}  (option rejected by ZateDB)`
        : `${site.command}  (not implemented by ZateDB)`;
      console.error(`  ${why}  at ${site.file}:${site.line}`);
    }
  }
  if (scriptFailures.length > 0) {
    console.error('\nLua script commands ZateDB will reject (the script errors at runtime):');
    for (const site of scriptFailures) console.error(`  ${describeScriptFailure(site)}  at ${site.file}:${site.line}`);
  }
  if (clientFailures.length > 0 || scriptFailures.length > 0) {
    console.error(
      '\nEither extend src/commands (and the §7 table in the design spec) to cover these commands,' +
        ' or change the consuming app to avoid them.',
    );
    return 1;
  }

  console.log('\nAll detected commands are covered.');
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main(process.argv.slice(2)));
