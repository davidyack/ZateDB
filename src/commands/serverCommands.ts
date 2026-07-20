import * as os from 'node:os';
import { bulk } from '../resp/types.js';
import { result } from './context.js';
import type { CommandContext, CommandResult } from './context.js';
import { wrongArgsError } from './errors.js';
import { getActiveConnectionCount, getCommandsProcessedTotal } from '../telemetry/commandTelemetry.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

/**
 * One INFO section: a `# Name` header followed by `field:value` lines. Kept
 * as structured data (rather than pre-formatted text) so `INFO <section>`
 * can filter by name and the CRLF framing lives in one place.
 */
interface Section {
  name: string;
  fields: Array<[string, string | number]>;
}

/**
 * Redis-compatible INFO. Returns a bulk string of `# Section` blocks with
 * `key:value` lines, CRLF-terminated — the format node-redis / ioredis and
 * monitoring tools parse. `INFO`, `INFO default`, `INFO all` and
 * `INFO everything` return every section; `INFO <section>` returns just
 * that one (empty string for an unknown section, matching real Redis).
 *
 * The numbers are sourced from the same places the admin API and telemetry
 * read: O(1) store counters (keyCounts/memoryBytesEstimate), the running
 * command total, and the live connection count — so INFO stays cheap enough
 * to call on a hot monitoring loop and never walks the keyspace.
 */
export function info(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length > 1) return result(wrongArgsError('info'));

  const requested = (args[0] ?? 'default').toLowerCase();
  const everything = requested === 'default' || requested === 'all' || requested === 'everything';
  const sections = buildSections(ctx);
  const selected = everything ? sections : sections.filter((s) => s.name.toLowerCase() === requested);

  return result(bulk(render(selected)));
}

function buildSections(ctx: CommandContext): Section[] {
  const uptimeSeconds = Math.floor(process.uptime());
  const commandsTotal = getCommandsProcessedTotal();
  const keyCounts = ctx.store.keyCounts();
  const totalKeys = keyCounts.string + keyCounts.hash + keyCounts.sortedset;
  const usedMemory = ctx.store.memoryBytesEstimate();
  const pubsub = ctx.pubsub.stats();

  const keyspace: Section = { name: 'Keyspace', fields: [] };
  // Redis omits empty databases from the Keyspace section entirely.
  if (totalKeys > 0) {
    keyspace.fields.push(['db0', `keys=${totalKeys},expires=0,avg_ttl=0`]);
  }

  return [
    {
      name: 'Server',
      fields: [
        // redis_version is what clients feature-gate on; keep it in step with
        // the version HELLO already advertises. zatedb_version is the
        // same value under an unambiguous key.
        ['redis_version', SERVER_VERSION],
        ['zatedb_version', SERVER_VERSION],
        ['server_name', SERVER_NAME],
        ['os', `${os.type()} ${os.release()} ${os.arch()}`],
        ['arch_bits', 64],
        ['process_id', process.pid],
        ['run_id', ctx.cluster.nodeId],
        ['tcp_port', ctx.config.respPort],
        ['uptime_in_seconds', uptimeSeconds],
        ['uptime_in_days', Math.floor(uptimeSeconds / 86400)],
      ],
    },
    {
      name: 'Clients',
      fields: [
        ['connected_clients', getActiveConnectionCount()],
        ['maxclients', ctx.config.maxClients],
        ['blocked_clients', 0],
      ],
    },
    {
      name: 'Memory',
      fields: [
        ['used_memory', usedMemory],
        ['used_memory_human', humanBytes(usedMemory)],
        ['maxmemory', ctx.config.maxMemoryBytes],
        ['maxmemory_human', humanBytes(ctx.config.maxMemoryBytes)],
        ['maxmemory_policy', 'noeviction'],
        ['mem_allocator', 'nodejs'],
      ],
    },
    {
      name: 'Stats',
      fields: [
        ['total_commands_processed', commandsTotal],
        ['instantaneous_ops_per_sec', uptimeSeconds > 0 ? Math.round(commandsTotal / uptimeSeconds) : 0],
        ['pubsub_channels', pubsub.channelCount],
        ['pubsub_patterns', pubsub.patternCount],
      ],
    },
    {
      name: 'Replication',
      fields: [
        // This cache has no read-replica protocol; every node is a writable
        // primary and replicates peer-to-peer through the durable store.
        ['role', 'master'],
        ['connected_slaves', 0],
      ],
    },
    {
      name: 'Cluster',
      fields: [['cluster_enabled', ctx.cluster.haEnabled ? 1 : 0]],
    },
    keyspace,
  ];
}

/** Frames sections into Redis's CRLF wire format: `# Name` header, `k:v` lines, blank line between sections. */
function render(sections: Section[]): string {
  return sections
    .map((section) => {
      const lines = [`# ${section.name}`, ...section.fields.map(([k, v]) => `${k}:${v}`)];
      return `${lines.join('\r\n')}\r\n`;
    })
    .join('\r\n');
}

function humanBytes(bytes: number): string {
  if (bytes <= 0) return '0B';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(2);
  return `${rounded}${units[unit]}`;
}
