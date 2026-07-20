import type { EntryTypeName } from '../store/types.js';

/**
 * Wire-safe (JSON-serializable) representation of a store Entry. The
 * in-memory Store uses Map for hash fields / sorted-set members, which
 * doesn't survive JSON.stringify — this uses plain objects instead, which
 * also matches the shape Cosmos DB's Patch API needs: a field/member can
 * be addressed by a JSON Pointer path (e.g. `/entry/fields/foo`) only
 * because `fields`/`members` are objects, not arrays. Used for whole-entry
 * persistence (SET/INCR/EXPIRE/PEXPIRE, and startup hydration) — HSET/
 * HDEL/ZADD/ZREMRANGEBYSCORE replicate at field/member granularity
 * instead (see ReplicationEvent's hashField/zsetMember kinds below), so
 * concurrent writes to *different* fields of the same key don't clobber
 * each other.
 */
export type EntrySnapshot =
  | { type: 'string'; value: string; expiresAtMs: number | null; contributions?: Record<string, number> }
  | { type: 'hash'; fields: Record<string, string>; expiresAtMs: number | null }
  | { type: 'sortedset'; members: Record<string, number>; expiresAtMs: number | null };

export type ReplicationEventKind = 'upsert' | 'delete' | 'ttl' | 'increment' | 'publish' | 'hashField' | 'zsetMember';

/**
 * A single fact broadcast over the replication transport: "key X is now
 * this" / "key X is gone" / "a message was published on this channel" /
 * "these specific hash fields or sorted-set members changed". Every event
 * carries the originating node so a node can ignore its own broadcasts
 * when the transport loops them back.
 */
export interface ReplicationEvent {
  kind: ReplicationEventKind;
  originNodeId: string;
  seq: number;
  timestampMs: number;
  key?: string;
  /** For 'upsert' — the whole post-mutation entry (SET/INCR). */
  entry?: EntrySnapshot;
  /**
   * For 'ttl' — the key's new absolute expiry (EXPIRE/PEXPIRE). Replicated
   * on its own, not folded into a whole-entry 'upsert', so an EXPIRE on a
   * hash/sorted set doesn't ship (and overwrite peers with) a whole-entry
   * snapshot that would clobber field/member writes those peers have
   * applied but this node hasn't received yet.
   */
  expiresAtMs?: number | null;
  /**
   * For 'increment' — the originating node's *cumulative* contribution to
   * the counter (not a +1 delta). Shipping the running total, and merging
   * it by max on each peer, is what makes INCR replication commutative and
   * idempotent: a duplicated, reordered, or delayed event carries no less
   * information than the one before it, so none of those delivery faults can
   * make the counter drift. See Store.applyReplicatedIncrement.
   */
  contributionTotal?: number;
  channel?: string;
  message?: string;
  /** For 'hashField' — field/value pairs that were set (HSET). */
  setFields?: Array<[string, string]>;
  /** For 'hashField' — field names that were deleted (HDEL), while the hash itself still has other fields left. */
  deletedFields?: string[];
  /** For 'zsetMember' — member/score pairs that were set (ZADD). */
  setMembers?: Array<[string, number]>;
  /** For 'zsetMember' — member names that were removed (ZREMRANGEBYSCORE), while the sorted set itself still has other members left. */
  deletedMembers?: string[];
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
