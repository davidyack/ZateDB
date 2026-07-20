#!/usr/bin/env tsx
/**
 * Repo-native performance harness for BackendCache.
 *
 * Standard Redis benchmark tools (redis-benchmark, memtier_benchmark) work
 * against BackendCache because it is RESP2 wire-compatible, but they default
 * to commands BackendCache deliberately does not implement (LPUSH, SPOP, …),
 * so every run needs hand-tuned flags to stay inside the supported command
 * surface (see docs/command-reference.md). This script does the same job
 * using the same `redis` (node-redis v5) client the consuming app uses, and
 * only ever issues commands BackendCache actually supports — so `npm run
 * bench` is meaningful out of the box with nothing else installed.
 *
 * By default it boots an in-process BackendCache server on an ephemeral
 * loopback port (the same way the integration tests do), benchmarks against
 * it, and shuts it down. Point it at an already-running instance with
 * --url / REDIS_URL to measure the real network path instead.
 *
 * Usage:
 *   npm run bench                          # in-process server, default mix
 *   npm run bench -- -n 200000 -c 100      # 200k ops per command, 100 in flight
 *   npm run bench -- -t set,get,incr       # only these commands
 *   npm run bench -- --url redis://host:6379   # against a running instance
 *   npm run bench -- --url redis://:pw@host:6379   # with AUTH
 *
 * This is a client-side throughput/latency probe, not a formal benchmark:
 * numbers depend on the machine, Node version, and (for --url) the network
 * hop. Use it to catch regressions and compare configurations, not as an
 * absolute figure. It measures a single BackendCache node driven directly
 * by one client connection pool; it deliberately does not exercise
 * cross-node HA replication (see docs/architecture.md).
 */
import { createClient, type RedisClientType } from 'redis';
import { Store } from '../src/store/store.js';
import { PubSubRegistry } from '../src/pubsub/registry.js';
import { RespServer } from '../src/server/respServer.js';
import { createClusterCoordinator } from '../src/cluster/factory.js';
import { loadConfig } from '../src/config.js';

/** A single benchmarkable command: how to issue one operation against the client. */
interface Benchmark {
  name: string;
  /** Issues exactly one operation; `i` is the monotonically increasing op index. */
  run: (client: RedisClientType, i: number) => Promise<unknown>;
}

/**
 * Every benchmark issues only commands from the supported table
 * (docs/command-reference.md). Keys are namespaced per command so parallel
 * benchmarks in one run never collide.
 */
const BENCHMARKS: Record<string, Benchmark> = {
  set: { name: 'SET', run: (c, i) => c.set(`bench:set:${i % 10000}`, 'value') },
  get: { name: 'GET', run: (c, i) => c.get(`bench:set:${i % 10000}`) },
  incr: { name: 'INCR', run: (c, i) => c.incr(`bench:incr:${i % 1000}`) },
  hset: { name: 'HSET', run: (c, i) => c.hSet(`bench:hash:${i % 1000}`, `f${i % 16}`, 'v') },
  hgetall: { name: 'HGETALL', run: (c, i) => c.hGetAll(`bench:hash:${i % 1000}`) },
  zadd: { name: 'ZADD', run: (c, i) => c.zAdd(`bench:zset:${i % 1000}`, { score: i, value: `m${i}` }) },
  zcount: { name: 'ZCOUNT', run: (c, i) => c.zCount(`bench:zset:${i % 1000}`, '-inf', '+inf') },
  del: { name: 'DEL', run: (c, i) => c.del(`bench:set:${i % 10000}`) },
  publish: { name: 'PUBLISH', run: (c, i) => c.publish(`bench:chan:${i % 8}`, 'msg') },
  ping: { name: 'PING', run: (c) => c.ping() },
};

const DEFAULT_ORDER = ['set', 'get', 'incr', 'hset', 'hgetall', 'zadd', 'zcount', 'publish'];

interface Options {
  ops: number;
  concurrency: number;
  commands: string[];
  url: string | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { ops: 50000, concurrency: 50, commands: DEFAULT_ORDER, url: process.env.REDIS_URL || null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`Missing value for ${arg}`);
        process.exit(2);
      }
      return v;
    };
    switch (arg) {
      case '-n':
      case '--ops':
        opts.ops = parsePositiveInt(next(), arg);
        break;
      case '-c':
      case '--concurrency':
        opts.concurrency = parsePositiveInt(next(), arg);
        break;
      case '-t':
      case '--commands': {
        const requested = next().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const unknown = requested.filter((c) => !(c in BENCHMARKS));
        if (unknown.length > 0) {
          console.error(`Unknown/unsupported command(s): ${unknown.join(', ')}`);
          console.error(`Supported: ${Object.keys(BENCHMARKS).join(', ')}`);
          process.exit(2);
        }
        opts.commands = requested;
        break;
      }
      case '--url':
        opts.url = next();
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(2);
    }
  }
  return opts;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    console.error(`${flag} expects a positive integer, got "${raw}"`);
    process.exit(2);
  }
  return n;
}

function printHelp(): void {
  console.log(
    [
      'Usage: npm run bench -- [options]',
      '',
      '  -n, --ops <n>           operations per command (default 50000)',
      '  -c, --concurrency <n>   in-flight operations (default 50)',
      '  -t, --commands <list>   comma-separated subset (default: the full mix)',
      '      --url <redis-url>   benchmark a running instance instead of an in-process one',
      '  -h, --help              show this help',
      '',
      `  supported commands: ${Object.keys(BENCHMARKS).join(', ')}`,
    ].join('\n'),
  );
}

interface Result {
  name: string;
  ops: number;
  elapsedMs: number;
  opsPerSec: number;
  latencyMs: { avg: number; p50: number; p95: number; p99: number; max: number };
}

/**
 * Runs `ops` operations keeping at most `concurrency` in flight at once, and
 * records per-operation latency. A fixed pool of workers pulls from a shared
 * index so a slow op never stalls the others — this mirrors how a real
 * concurrent caller drives the server.
 */
async function runBenchmark(client: RedisClientType, bench: Benchmark, ops: number, concurrency: number): Promise<Result> {
  const latencies = new Float64Array(ops);
  let issued = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = issued++;
      if (i >= ops) return;
      const start = performance.now();
      await bench.run(client, i);
      latencies[i] = performance.now() - start;
    }
  };

  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, ops) }, () => worker()));
  const elapsedMs = performance.now() - start;

  const sorted = Float64Array.prototype.slice.call(latencies).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;

  return {
    name: bench.name,
    ops,
    elapsedMs,
    opsPerSec: (ops / elapsedMs) * 1000,
    latencyMs: { avg, p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1] },
  };
}

/**
 * Boots an in-process BackendCache server on an ephemeral loopback port. The
 * cluster coordinator comes from the same factory index.ts uses; with no
 * Cosmos DB / Service Bus configured it resolves to a standalone (single-node,
 * HA-disabled) coordinator, so this benchmarks one node in isolation.
 */
async function startInProcessServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const config = { ...loadConfig(), respPort: 0, healthPort: 0, adminPort: 0, ttlSweepIntervalMs: 0 };
  const store = new Store(config.ttlSweepIntervalMs);
  const pubsub = new PubSubRegistry();
  const cluster = await createClusterCoordinator(config, {
    store,
    pubsub,
    connectionCount: () => 0,
    commandsTotal: () => 0,
  });
  const server = new RespServer(store, pubsub, config, cluster);
  await cluster.start();
  await server.listen(0);
  const url = config.authPassword
    ? `redis://:${config.authPassword}@127.0.0.1:${server.port}`
    : `redis://127.0.0.1:${server.port}`;
  return {
    url,
    stop: async () => {
      await server.shutdown(500);
      await cluster.stop();
      store.close();
    },
  };
}

function printResults(results: Result[]): void {
  const fmt = (n: number, digits = 2) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const cols = ['command', 'ops', 'ops/sec', 'avg ms', 'p50', 'p95', 'p99', 'max'];
  const rows = results.map((r) => [
    r.name,
    String(r.ops),
    fmt(r.opsPerSec, 0),
    fmt(r.latencyMs.avg),
    fmt(r.latencyMs.p50),
    fmt(r.latencyMs.p95),
    fmt(r.latencyMs.p99),
    fmt(r.latencyMs.max),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padStart(widths[i])).join('  ');
  console.log('\n' + line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  let url = opts.url;
  let stopServer: (() => Promise<void>) | null = null;
  if (!url) {
    const server = await startInProcessServer();
    url = server.url;
    stopServer = server.stop;
    console.log(`Started in-process BackendCache at ${url}`);
  } else {
    console.log(`Benchmarking running instance at ${url}`);
  }

  console.log(`Config: ${opts.ops} ops/command, ${opts.concurrency} concurrent, commands: ${opts.commands.join(', ')}`);

  const client: RedisClientType = createClient({ url });
  client.on('error', (err) => console.error('redis client error:', err));
  await client.connect();

  const results: Result[] = [];
  try {
    for (const key of opts.commands) {
      const result = await runBenchmark(client, BENCHMARKS[key], opts.ops, opts.concurrency);
      results.push(result);
      console.log(`  ${result.name.padEnd(8)} done: ${Math.round(result.opsPerSec).toLocaleString('en-US')} ops/sec`);
    }
  } finally {
    await client.quit();
    if (stopServer) await stopServer();
  }

  printResults(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
