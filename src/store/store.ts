import type { Entry, EntryTypeName, HashEntry, SortedSetEntry, StringEntry } from './types.js';
import { NotAnIntegerError, WrongTypeError } from './types.js';
import type { ScoreBound } from './scoreRange.js';
import { scoreInRange } from './scoreRange.js';

export type ExpireFlag = 'NX' | 'XX' | 'GT' | 'LT';

export interface KeyInfo {
  key: string;
  type: EntryTypeName;
  ttlMsRemaining: number | null;
}

export interface StoreStats {
  keyCounts: Record<EntryTypeName, number>;
  totalKeys: number;
  memoryEstimateBytes: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5000;

/**
 * In-memory keyspace: strings, hashes, and sorted sets, each with an
 * optional TTL. Expiry is enforced lazily (checked on access) and by a
 * low-frequency active sweep so idle expired keys don't sit in memory
 * indefinitely. State is intentionally not persisted anywhere.
 */
export class Store {
  private data = new Map<string, Entry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS) {
    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // ---- internal helpers ----------------------------------------------

  private isExpired(entry: Entry, nowMs: number): boolean {
    return entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs;
  }

  private getLive(key: string, nowMs: number = Date.now()): Entry | undefined {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (this.isExpired(entry, nowMs)) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry, now)) this.data.delete(key);
    }
  }

  private requireType<T extends Entry>(key: string, type: T['type']): T | undefined {
    const entry = this.getLive(key);
    if (entry === undefined) return undefined;
    if (entry.type !== type) throw new WrongTypeError();
    return entry as T;
  }

  // ---- generic key commands -------------------------------------------

  del(keys: string[]): number {
    let removed = 0;
    for (const key of keys) {
      if (this.getLive(key) !== undefined) {
        this.data.delete(key);
        removed++;
      }
    }
    return removed;
  }

  exists(key: string): boolean {
    return this.getLive(key) !== undefined;
  }

  expire(key: string, seconds: number, flag?: ExpireFlag): boolean {
    return this.setExpiry(key, Date.now() + seconds * 1000, flag);
  }

  pexpire(key: string, ms: number, flag?: ExpireFlag): boolean {
    return this.setExpiry(key, Date.now() + ms, flag);
  }

  private setExpiry(key: string, atMs: number, flag?: ExpireFlag): boolean {
    const entry = this.getLive(key);
    if (entry === undefined) return false;

    if (flag) {
      const hasTtl = entry.expiresAtMs !== null;
      if (flag === 'NX' && hasTtl) return false;
      if (flag === 'XX' && !hasTtl) return false;
      if (flag === 'GT' && (!hasTtl || atMs <= (entry.expiresAtMs as number))) return false;
      if (flag === 'LT' && hasTtl && atMs >= (entry.expiresAtMs as number)) return false;
    }

    entry.expiresAtMs = atMs;
    return true;
  }

  // ---- strings ----------------------------------------------------------

  get(key: string): string | null {
    const entry = this.requireType<StringEntry>(key, 'string');
    return entry ? entry.value : null;
  }

  set(key: string, value: string, opts?: { exSeconds?: number; pxMs?: number }): void {
    const expiresAtMs = opts?.pxMs !== undefined
      ? Date.now() + opts.pxMs
      : opts?.exSeconds !== undefined
        ? Date.now() + opts.exSeconds * 1000
        : null;
    this.data.set(key, { type: 'string', value, expiresAtMs });
  }

  incr(key: string): number {
    const entry = this.requireType<StringEntry>(key, 'string');
    const current = entry ? entry.value : '0';
    if (!/^-?\d+$/.test(current)) throw new NotAnIntegerError();
    const next = Number(current) + 1;
    if (!Number.isSafeInteger(next)) throw new NotAnIntegerError();
    if (entry) {
      entry.value = String(next);
    } else {
      this.data.set(key, { type: 'string', value: String(next), expiresAtMs: null });
    }
    return next;
  }

  // ---- hashes -------------------------------------------------------------

  hset(key: string, pairs: Array<[string, string]>): number {
    let entry = this.requireType<HashEntry>(key, 'hash');
    if (!entry) {
      entry = { type: 'hash', fields: new Map(), expiresAtMs: null };
      this.data.set(key, entry);
    }
    let added = 0;
    for (const [field, value] of pairs) {
      if (!entry.fields.has(field)) added++;
      entry.fields.set(field, value);
    }
    return added;
  }

  hdel(key: string, fields: string[]): number {
    const entry = this.requireType<HashEntry>(key, 'hash');
    if (!entry) return 0;
    let removed = 0;
    for (const field of fields) {
      if (entry.fields.delete(field)) removed++;
    }
    if (entry.fields.size === 0) this.data.delete(key);
    return removed;
  }

  hgetall(key: string): Array<[string, string]> {
    const entry = this.requireType<HashEntry>(key, 'hash');
    if (!entry) return [];
    return Array.from(entry.fields.entries());
  }

  // ---- sorted sets --------------------------------------------------------

  zadd(key: string, pairs: Array<[number, string]>): number {
    let entry = this.requireType<SortedSetEntry>(key, 'sortedset');
    if (!entry) {
      entry = { type: 'sortedset', members: new Map(), expiresAtMs: null };
      this.data.set(key, entry);
    }
    let added = 0;
    for (const [score, member] of pairs) {
      if (!entry.members.has(member)) added++;
      entry.members.set(member, score);
    }
    return added;
  }

  zremrangebyscore(key: string, min: ScoreBound, max: ScoreBound): number {
    const entry = this.requireType<SortedSetEntry>(key, 'sortedset');
    if (!entry) return 0;
    let removed = 0;
    for (const [member, score] of entry.members) {
      if (scoreInRange(score, min, max)) {
        entry.members.delete(member);
        removed++;
      }
    }
    if (entry.members.size === 0) this.data.delete(key);
    return removed;
  }

  zcount(key: string, min: ScoreBound, max: ScoreBound): number {
    const entry = this.requireType<SortedSetEntry>(key, 'sortedset');
    if (!entry) return 0;
    let count = 0;
    for (const score of entry.members.values()) {
      if (scoreInRange(score, min, max)) count++;
    }
    return count;
  }

  // ---- admin / observability -----------------------------------------------

  stats(): StoreStats {
    const keyCounts: Record<EntryTypeName, number> = { string: 0, hash: 0, sortedset: 0 };
    let memoryEstimateBytes = 0;
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry, now)) continue;
      keyCounts[entry.type]++;
      memoryEstimateBytes += estimateEntrySize(key, entry);
    }
    return { keyCounts, totalKeys: keyCounts.string + keyCounts.hash + keyCounts.sortedset, memoryEstimateBytes };
  }

  listKeys(prefix: string, limit: number, offset: number): { keys: KeyInfo[]; total: number } {
    const now = Date.now();
    const matches: KeyInfo[] = [];
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry, now)) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      matches.push({
        key,
        type: entry.type,
        ttlMsRemaining: entry.expiresAtMs === null ? null : Math.max(0, entry.expiresAtMs - now),
      });
    }
    matches.sort((a, b) => a.key.localeCompare(b.key));
    return { keys: matches.slice(offset, offset + limit), total: matches.length };
  }

  getKeyDetail(key: string): { info: KeyInfo; value: string | Array<[string, string]> } | null {
    const entry = this.getLive(key);
    if (!entry) return null;
    const now = Date.now();
    const info: KeyInfo = {
      key,
      type: entry.type,
      ttlMsRemaining: entry.expiresAtMs === null ? null : Math.max(0, entry.expiresAtMs - now),
    };
    if (entry.type === 'string') return { info, value: entry.value };
    if (entry.type === 'hash') return { info, value: Array.from(entry.fields.entries()) };
    return { info, value: Array.from(entry.members.entries()).map(([m, s]) => [m, String(s)] as [string, string]) };
  }

  deleteKey(key: string): boolean {
    return this.del([key]) === 1;
  }

  // ---- cluster hydration / replication ---------------------------------

  /**
   * Raw entry for a key, bypassing type-narrowing helpers — used by the
   * cluster coordinator to snapshot post-mutation state for durable
   * persistence and cross-node replication. Returns undefined for a
   * missing or expired key.
   */
  getRawEntry(key: string): Entry | undefined {
    return this.getLive(key);
  }

  /** All live (non-expired) key/entry pairs — used for admin listing and full-state hand-offs. */
  *allEntries(): IterableIterator<[string, Entry]> {
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (!this.isExpired(entry, now)) yield [key, entry];
    }
  }

  /**
   * Overwrites a key with an absolute entry snapshot — used both to
   * hydrate from the durable store at startup and to apply a mutation
   * replicated from another node. Never triggers further
   * persistence/replication itself; the caller (ClusterCoordinator) owns
   * that decision so applying a remote event doesn't re-broadcast it.
   */
  applyReplicatedUpsert(key: string, entry: Entry): void {
    this.data.set(key, entry);
  }

  /** Removes a key as a result of hydration or a replicated delete, without cascading further replication. */
  applyReplicatedDelete(key: string): void {
    this.data.delete(key);
  }
}

function estimateEntrySize(key: string, entry: Entry): number {
  let size = key.length * 2 + 48; // rough per-entry overhead
  if (entry.type === 'string') {
    size += entry.value.length * 2;
  } else if (entry.type === 'hash') {
    for (const [f, v] of entry.fields) size += (f.length + v.length) * 2 + 16;
  } else {
    for (const [m] of entry.members) size += m.length * 2 + 24;
  }
  return size;
}
