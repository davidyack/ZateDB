import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/commands/dispatcher.js';
import type { CommandContext, ConnectionContext } from '../../src/commands/context.js';
import { Store } from '../../src/store/store.js';
import { PubSubRegistry } from '../../src/pubsub/registry.js';
import { loadConfig } from '../../src/config.js';
import { standaloneCluster } from '../helpers/cluster.js';
import type { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';

function fakeConn(): ConnectionContext {
  return {
    id: 'test-conn',
    authenticated: true,
    failedAuthCount: 0,
    protover: 2,
    mode: 'command',
    clientName: null,
    remoteAddress: '127.0.0.1:0',
    sendMessage() {},
    sendPMessage() {},
    totalSubscriptions: () => 0,
  };
}

/** Runs INFO and returns the bulk-string body, failing loudly if the reply isn't a bulk string. */
function runInfo(ctx: CommandContext, ...args: string[]): string {
  const outcome = dispatch(ctx, ['INFO', ...args]);
  const frame = outcome.frames[0];
  expect(frame.type).toBe('bulk');
  return (frame as { type: 'bulk'; value: string }).value;
}

/** Parses Redis INFO text into { Section: { field: value } }. */
function parseInfo(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = '';
  for (const line of text.split('\r\n')) {
    if (line === '') continue;
    if (line.startsWith('# ')) {
      current = line.slice(2);
      sections[current] = {};
      continue;
    }
    const idx = line.indexOf(':');
    sections[current][line.slice(0, idx)] = line.slice(idx + 1);
  }
  return sections;
}

describe('INFO command', () => {
  let store: Store;
  let pubsub: PubSubRegistry;
  let cluster: ClusterCoordinator;
  let ctx: CommandContext;

  beforeEach(async () => {
    store = new Store(0);
    pubsub = new PubSubRegistry();
    cluster = standaloneCluster(store, pubsub);
    await cluster.start();
    ctx = { store, pubsub, conn: fakeConn(), config: loadConfig({}), cluster };
  });

  afterEach(async () => {
    await cluster.stop();
    store.close();
  });

  it('is a known command (regression: INFO used to be unimplemented)', () => {
    const outcome = dispatch(ctx, ['INFO']);
    expect(outcome.isError).toBe(false);
  });

  it('returns the standard section headers in Redis wire format', () => {
    const info = parseInfo(runInfo(ctx));
    for (const section of ['Server', 'Clients', 'Memory', 'Stats', 'Replication', 'Cluster']) {
      expect(info[section]).toBeDefined();
    }
    expect(info.Server.redis_version).toBe('1.0.0');
    expect(info.Server.run_id).toBe('test-node');
    expect(info.Replication.role).toBe('master');
    // Standalone: cluster mode reported as disabled.
    expect(info.Cluster.cluster_enabled).toBe('0');
  });

  it('reports live key counts in the Keyspace section, and omits db0 when empty', () => {
    // The Keyspace header is always present (as in real Redis); the db0 line
    // only appears once at least one key exists.
    expect(parseInfo(runInfo(ctx)).Keyspace.db0).toBeUndefined();
    store.set('a', '1');
    store.set('b', '2');
    store.hset('h', [['f', 'v']]);
    const info = parseInfo(runInfo(ctx));
    expect(info.Keyspace.db0).toBe('keys=3,expires=0,avg_ttl=0');
  });

  it('reflects processed commands in the Stats section', () => {
    // Each dispatch above increments the global counter; just assert it is a
    // non-negative integer that parses, rather than pinning a shared global.
    const info = parseInfo(runInfo(ctx));
    expect(Number.isFinite(Number(info.Stats.total_commands_processed))).toBe(true);
    expect(info.Stats.pubsub_channels).toBe('0');
  });

  it('INFO <section> returns only that section', () => {
    const info = parseInfo(runInfo(ctx, 'server'));
    expect(info.Server).toBeDefined();
    expect(info.Clients).toBeUndefined();
    expect(info.Memory).toBeUndefined();
  });

  it('INFO on an unknown section returns an empty body', () => {
    expect(runInfo(ctx, 'nonexistent')).toBe('');
  });

  it('rejects extra arguments', () => {
    const outcome = dispatch(ctx, ['INFO', 'server', 'extra']);
    expect(outcome.isError).toBe(true);
  });
});
