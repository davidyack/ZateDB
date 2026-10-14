#!/usr/bin/env tsx
/**
 * CI gate (design spec §13.4): greps the consuming app's source tree for
 * Redis call sites and diffs the RESP command set actually used against
 * the command table ZateDB implements (§7, mirrored in
 * src/commands/dispatcher.ts). Fails when the consuming app calls a
 * command ZateDB doesn't support — the same class of gap that let
 * the sorted-set commands slip out of the first draft of this spec.
 *
 * Usage:
 *   npm run coverage-audit -- <path-to-consuming-app-src>
 *
 * Heuristic, not a full type-checker: it tracks variables assigned from a
 * call to a configurable "get client" factory (default names:
 * getRedisClient, redisClient) and reports node-redis method calls made on
 * those variables, mapped to their RESP command names. It will not catch
 * every possible aliasing pattern (e.g. a client passed through several
 * layers of indirection) — treat a clean run as a strong signal, not a
 * formal proof, and extend the heuristic if it misses a real call site.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import ts from 'typescript';
import { isKnownCommand } from '../src/commands/dispatcher.js';

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
  lPush: 'LPUSH',
  rPush: 'RPUSH',
  sAdd: 'SADD',
  xAdd: 'XADD',
};

interface CallSite {
  file: string;
  line: number;
  command: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

function findCallSites(file: string): CallSite[] {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
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

    // Report: client.methodName(...) or client.methodName(...).methodName(...) chains
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      const methodName = node.expression.name.text;
      if (ts.isIdentifier(target) && trackedIdentifiers.has(target.text) && methodName in METHOD_TO_COMMAND) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        sites.push({ file, line: line + 1, command: METHOD_TO_COMMAND[methodName] });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

function main(): void {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: npm run coverage-audit -- <path-to-consuming-app-src>');
    process.exit(2);
  }

  const files = walk(target);
  const allSites = files.flatMap(findCallSites);

  if (allSites.length === 0) {
    console.log(`No tracked Redis client call sites found under ${target} (factory names: ${[...CLIENT_FACTORY_NAMES].join(', ')}).`);
    console.log('If the consuming app uses a different factory function name, add it to CLIENT_FACTORY_NAMES in this script.');
    process.exit(0);
  }

  const uncovered = allSites.filter((site) => !isKnownCommand(site.command));
  const covered = allSites.filter((site) => isKnownCommand(site.command));

  console.log(`Found ${allSites.length} Redis call site(s) across ${files.length} file(s):`);
  const usedCommands = new Set(covered.map((s) => s.command));
  console.log(`  Commands used and covered by ZateDB: ${[...usedCommands].sort().join(', ') || '(none)'}`);

  if (uncovered.length > 0) {
    console.error('\nCommands used by the consuming app but NOT implemented by ZateDB:');
    for (const site of uncovered) {
      console.error(`  ${site.command}  at ${site.file}:${site.line}`);
    }
    console.error(
      '\nEither extend src/commands (and the §7 table in the design spec) to cover these commands,' +
        ' or change the consuming app to avoid them.',
    );
    process.exit(1);
  }

  console.log('\nAll detected commands are covered. ✓');
}

main();
