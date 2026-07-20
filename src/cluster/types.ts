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

// ---- inbound event validation ---------------------------------------------
//
// Replication events arrive over the Service Bus topic as `message.body`,
// i.e. untrusted `unknown` cast to ReplicationEvent — the type is a
// compile-time lie for anything off the wire. Applying them bypasses
// admission control (a peer already accepted the write), so a buggy or
// compromised publisher inside the topic's trust boundary could otherwise
// inject malformed or absurdly-large events straight into every node's
// memory. validateReplicationEvent is the kind-discriminated, size-bounded
// gate on that path. Bounds are sanity ceilings (well above any legitimate
// value, below catastrophic), not functional limits.

const MAX_EVENT_STRING = 64 * 1024 * 1024; // 64 MiB — far above the 8 MiB bulk-arg limit
const MAX_EVENT_ARRAY = 1_000_000;

function isEventString(x: unknown): x is string {
  return typeof x === 'string' && x.length <= MAX_EVENT_STRING;
}
function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
function isValidSnapshot(x: unknown): x is EntrySnapshot {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  if (s.expiresAtMs !== null && !isFiniteNumber(s.expiresAtMs)) return false;
  if (s.type === 'string') {
    if (!isEventString(s.value)) return false;
    if (s.contributions !== undefined && !isNumberRecord(s.contributions)) return false;
    return true;
  }
  if (s.type === 'hash') return isRecordOf(s.fields, isEventString);
  if (s.type === 'sortedset') return isNumberRecord(s.members);
  return false;
}
function isRecordOf(x: unknown, valueOk: (v: unknown) => boolean): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const entries = Object.entries(x as Record<string, unknown>);
  if (entries.length > MAX_EVENT_ARRAY) return false;
  return entries.every(([k, v]) => isEventString(k) && valueOk(v));
}
function isNumberRecord(x: unknown): boolean {
  return isRecordOf(x, isFiniteNumber);
}
function isPairArray(x: unknown, valueOk: (v: unknown) => boolean): boolean {
  if (!Array.isArray(x) || x.length > MAX_EVENT_ARRAY) return false;
  return x.every((pair) => Array.isArray(pair) && pair.length === 2 && isEventString(pair[0]) && valueOk(pair[1]));
}
function isNameArray(x: unknown): boolean {
  return Array.isArray(x) && x.length <= MAX_EVENT_ARRAY && x.every(isEventString);
}

/**
 * Runtime-validates an off-the-wire replication event. Returns the event
 * typed on success, or null if it's malformed / oversized (the caller drops
 * and logs it). Optional per-kind fields are checked only when present.
 */
export function validateReplicationEvent(raw: unknown): ReplicationEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (!isEventString(e.originNodeId) || !isFiniteNumber(e.seq) || !isFiniteNumber(e.timestampMs)) return null;

  switch (e.kind) {
    case 'upsert':
      if (!isEventString(e.key) || !isValidSnapshot(e.entry)) return null;
      break;
    case 'delete':
      if (!isEventString(e.key)) return null;
      break;
    case 'ttl':
      if (!isEventString(e.key) || (e.expiresAtMs !== null && !isFiniteNumber(e.expiresAtMs))) return null;
      break;
    case 'increment':
      if (!isEventString(e.key) || !isFiniteNumber(e.contributionTotal)) return null;
      break;
    case 'publish':
      if (!isEventString(e.channel) || !isEventString(e.message)) return null;
      break;
    case 'hashField':
      if (!isEventString(e.key)) return null;
      if (e.setFields !== undefined && !isPairArray(e.setFields, isEventString)) return null;
      if (e.deletedFields !== undefined && !isNameArray(e.deletedFields)) return null;
      break;
    case 'zsetMember':
      if (!isEventString(e.key)) return null;
      if (e.setMembers !== undefined && !isPairArray(e.setMembers, isFiniteNumber)) return null;
      if (e.deletedMembers !== undefined && !isNameArray(e.deletedMembers)) return null;
      break;
    default:
      return null; // unknown kind
  }
  return raw as ReplicationEvent;
}

export interface NodeSnapshot {
  nodeId: string;
  lastHeartbeatMs: number;
  connectionCount: number;
  keyCounts: Record<EntryTypeName, number>;
  commandsTotal: number;
  subscriptions: {
    /** Total distinct channels/patterns on this node — always exact, even when the arrays below are capped. */
    channelCount: number;
    patternCount: number;
    /** Top-N channels/patterns by subscriber count. Capped (see HEARTBEAT_TOP_SUBSCRIPTIONS) so the heartbeat doc — and its per-write RU — doesn't grow with Socket.IO room count. */
    channels: Array<{ channel: string; subscriberCount: number }>;
    patterns: Array<{ pattern: string; subscriberCount: number }>;
  };
}
