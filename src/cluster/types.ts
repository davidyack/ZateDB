import type { EntryTypeName } from '../store/types.js';

/**
 * Wire-safe (JSON-serializable) representation of a store Entry. The
 * in-memory Store uses Map for hash fields / sorted-set members, which
 * doesn't survive JSON.stringify — this is the array-based shape actually
 * written to Cosmos DB documents and Service Bus message bodies.
 */
export type EntrySnapshot =
  | { type: 'string'; value: string; expiresAtMs: number | null }
  | { type: 'hash'; fields: Array<[string, string]>; expiresAtMs: number | null }
  | { type: 'sortedset'; members: Array<[string, number]>; expiresAtMs: number | null };

export type ReplicationEventKind = 'upsert' | 'delete' | 'publish';

/**
 * A single fact broadcast over the replication transport: "key X is now
 * this" / "key X is gone" / "a message was published on this channel".
 * Every event carries the originating node so a node can ignore its own
 * broadcasts when the transport loops them back.
 */
export interface ReplicationEvent {
  kind: ReplicationEventKind;
  originNodeId: string;
  seq: number;
  timestampMs: number;
  key?: string;
  entry?: EntrySnapshot;
  channel?: string;
  message?: string;
}

export interface NodeSnapshot {
  nodeId: string;
  lastHeartbeatMs: number;
  connectionCount: number;
  keyCounts: Record<EntryTypeName, number>;
  commandsTotal: number;
  subscriptions: {
    channels: Array<{ channel: string; subscriberCount: number }>;
    patterns: Array<{ pattern: string; subscriberCount: number }>;
  };
}
