import type { Entry, EntryTypeName, HashEntry, SortedSetEntry, StringEntry } from './types.js';
import { NotAnIntegerError, OutOfMemoryError, WrongTypeError } from './types.js';
import type { ScoreBound } from './scoreRange.js';
import { scoreInRange } from './scoreRange.js';

export type ExpireFlag = 'NX' | 'XX' | 'GT' | 'LT';

export interface StoreLimits {
  /** Max distinct keys; a new-key write past this is rejected with OOM. 0 disables. */
  maxKeys?: number;
  /** Estimated byte ceiling; a new-key write past this is rejected with OOM. 0 disables. */
  maxMemoryBytes?: number;
}

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
  private readonly maxKeys: number;
  private readonly maxMemoryBytes: number;
  /**
   * Running estimate of keyspace bytes, kept exact by recomputing each
   * mutated entry's size before/after the change. Backs the write-admission
   * guard; the admin /stats view recomputes independently so the two never
   * silently agree on a wrong number.
   */
  private memoryBytes = 0;

  constructor(private readonly sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS, limits: StoreLimits = {}) {
    this.maxKeys = limits.maxKeys ?? 0;
    this.maxMemoryBytes = limits.maxMemoryBytes ?? 0;
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
      this.remove(key);
      return undefined;
    }
    return entry;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry, now)) this.remove(key);
    }
  }

  /**
   * Rejects a write that would create a *new* top-level key once the key or
   * memory ceiling is reached. Writes to existing keys still succeed so an
   * in-flight caller isn't broken mid-operation; the flood vector (many new
   * keys) is what this closes.
   */
  private ensureRoomForNewKey(): void {
    if (this.maxKeys > 0 && this.data.size >= this.maxKeys) throw new OutOfMemoryError();
    if (this.maxMemoryBytes > 0 && this.memoryBytes >= this.maxMemoryBytes) throw new OutOfMemoryError();
  }

  /** Inserts or replaces a key, keeping the byte estimate exact. */
  private put(key: string, entry: Entry): void {
    const prev = this.data.get(key);
    if (prev !== undefined) this.memoryBytes -= estimateEntrySize(key, prev);
    this.data.set(key, entry);
    this.memoryBytes += estimateEntrySize(key, entry);
  }

  /** Deletes a key if present, keeping the byte estimate exact. Returns whether it existed. */
  private remove(key: string): boolean {
    const prev = this.data.get(key);
    if (prev === undefined) return false;
    this.memoryBytes -= estimateEntrySize(key, prev);
    this.data.delete(key);
    return true;
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
        this.remove(key);
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
    if (this.getLive(key) === undefined) this.ensureRoomForNewKey();
    this.put(key, { type: 'string', value, expiresAtMs });
  }

  incr(key: string): number {
    const entry = this.requireType<StringEntry>(key, 'string');
    const current = entry ? entry.value : '0';
    if (!/^-?\d+$/.test(current)) throw new NotAnIntegerError();
    const next = Number(current) + 1;
    if (!Number.isSafeInteger(next)) throw new NotAnIntegerError();
    if (entry) {
      this.memoryBytes -= estimateEntrySize(key, entry);
      entry.value = String(next);
      this.memoryBytes += estimateEntrySize(key, entry);
    } else {
      this.ensureRoomForNewKey();
      this.put(key, { type: 'string', value: String(next), expiresAtMs: null });
    }
    return next;
  }

  // ---- hashes -------------------------------------------------------------

  hset(key: string, pairs: Array<[string, string]>): number {
    let entry = this.requireType<HashEntry>(key, 'hash');
    if (!entry) {
      this.ensureRoomForNewKey();
      entry = { type: 'hash', fields: new Map(), expiresAtMs: null };
      this.put(key, entry);
    }
    const before = estimateEntrySize(key, entry);
    let added = 0;
    for (const [field, value] of pairs) {
      if (!entry.fields.has(field)) added++;
      entry.fields.set(field, value);
    }
    this.memoryBytes += estimateEntrySize(key, entry) - before;
    return added;
  }

  hdel(key: string, fields: string[]): number {
    const entry = this.requireType<HashEntry>(key, 'hash');
    if (!entry) return 0;
    const before = estimateEntrySize(key, entry);
    let removed = 0;
    for (const field of fields) {
      if (entry.fields.delete(field)) removed++;
    }
    if (entry.fields.size === 0) {
      this.remove(key);
    } else {
      this.memoryBytes += estimateEntrySize(key, entry) - before;
    }
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
      this.ensureRoomForNewKey();
      entry = { type: 'sortedset', members: new Map(), expiresAtMs: null };
      this.put(key, entry);
    }
    const before = estimateEntrySize(key, entry);
    let added = 0;
    for (const [score, member] of pairs) {
      if (!entry.members.has(member)) added++;
      entry.members.set(member, score);
    }
    this.memoryBytes += estimateEntrySize(key, entry) - before;
    return added;
  }

  zremrangebyscore(key: string, min: ScoreBound, max: ScoreBound): number {
    const entry = this.requireType<SortedSetEntry>(key, 'sortedset');
    if (!entry) return 0;
    const before = estimateEntrySize(key, entry);
    let removed = 0;
    for (const [member, score] of entry.members) {
      if (scoreInRange(score, min, max)) {
        entry.members.delete(member);
        removed++;
      }
    }
    if (entry.members.size === 0) {
      this.remove(key);
    } else {
      this.memoryBytes += estimateEntrySize(key, entry) - before;
    }
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
