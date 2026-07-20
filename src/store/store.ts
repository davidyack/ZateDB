import type { Entry, EntryTypeName, HashEntry, SortedSetEntry, StringEntry } from './types.js';
import { NotAnIntegerError, OutOfMemoryError, WrongTypeError } from './types.js';
import type { ScoreBound } from './scoreRange.js';
import { scoreInRange } from './scoreRange.js';
import { logger } from '../logger.js';

export type ExpireFlag = 'NX' | 'XX' | 'GT' | 'LT';

/**
 * Reserved contribution origin for a counter's pre-existing base value (the
 * integer a SET left before the key was ever INCR'd). Shared across nodes —
 * not per-node — so the base is counted once, not once per node that
 * happens to INCR after seeing the same SET. The empty string can never
 * collide with a real node id (see cluster/nodeId.ts).
 */
export const SEED_ORIGIN = '';

/** Default contribution origin when INCR is called outside HA (single-node/tests) — one origin, so the sum is just the count. */
const LOCAL_ORIGIN = 'local';

function sumContributions(contributions: Map<string, number>): number {
  let total = 0;
  for (const n of contributions.values()) total += n;
  return total;
}

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
  // Index of keys known to carry a TTL, so the active sweep visits only those
  // rather than scanning the whole keyspace. Kept in sync on the paths that set
  // a TTL (set/expire) and cleared as keys expire or are deleted; the sweep
  // also self-heals any stale entry it finds.
  private ttlKeys = new Set<string>();
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
  /**
   * Incremental per-type key counts, maintained in put()/remove() so the
   * cluster heartbeat (every 10 s) and any other hot caller can read the
   * key breakdown in O(1) instead of walking the whole keyspace. Like
   * memoryBytes this can transiently include expired-but-not-yet-swept
   * keys; the admin /stats view recomputes exactly (excluding expired) as
   * an independent cross-check.
   */
  private keyCountByType: Record<EntryTypeName, number> = { string: 0, hash: 0, sortedset: 0 };

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
    let evicted = 0;
    // Walk only keys with a TTL set, not the whole keyspace.
    for (const key of this.ttlKeys) {
      const entry = this.data.get(key);
      if (entry === undefined || entry.expiresAtMs === null) {
        // Deleted or lost its TTL since it was indexed — drop the stale entry.
        this.ttlKeys.delete(key);
        continue;
      }
      if (this.isExpired(entry, now)) {
        this.remove(key);
        evicted++;
      }
    }
    if (evicted > 0) logger.debug('store.sweep', { evicted });
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

  /** Inserts or replaces a key, keeping the byte estimate and per-type key counts exact. */
  private put(key: string, entry: Entry): void {
    const prev = this.data.get(key);
    if (prev !== undefined) {
      this.memoryBytes -= estimateEntrySize(key, prev);
      this.keyCountByType[prev.type]--;
    }
    this.data.set(key, entry);
    this.memoryBytes += estimateEntrySize(key, entry);
    this.keyCountByType[entry.type]++;
  }

  /** Deletes a key if present, keeping the byte estimate, per-type key counts, and TTL index exact. Returns whether it existed. */
  private remove(key: string): boolean {
    const prev = this.data.get(key);
    if (prev === undefined) return false;
    this.memoryBytes -= estimateEntrySize(key, prev);
    this.keyCountByType[prev.type]--;
    this.data.delete(key);
    this.ttlKeys.delete(key);
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

  /** EXISTS key [key ...]: counts each present key, including duplicates (matching Redis). */
  existsCount(keys: string[]): number {
    let count = 0;
    for (const key of keys) {
      if (this.getLive(key) !== undefined) count++;
    }
    return count;
  }

  /**
   * PTTL in milliseconds: -2 if the key does not exist, -1 if it exists but
   * has no TTL, otherwise the remaining lifetime (never negative). TTL derives
   * its seconds value from this.
   */
  pttlMs(key: string): number {
    const entry = this.getLive(key);
    if (entry === undefined) return -2;
    if (entry.expiresAtMs === null) return -1;
    return Math.max(0, entry.expiresAtMs - Date.now());
  }

  /**
   * SCAN over the whole keyspace. COUNT is only a hint in Redis and a full
   * iteration may legally complete in one step, so this returns every live
   * key matching `match` (a Redis glob, or all keys when omitted) in a single
   * page — the caller sees a terminating cursor and stops. Keeping it
   * single-page sidesteps the skip-on-delete hazard an offset cursor has when
   * a caller deletes keys mid-scan (e.g. connect-redis's clear()).
   */
  scanKeys(match: RegExp | null, type: EntryTypeName | null): string[] {
    const now = Date.now();
    const keys: string[] = [];
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry, now)) continue;
      if (type !== null && entry.type !== type) continue;
      if (match !== null && !match.test(key)) continue;
      keys.push(key);
    }
    return keys;
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
    this.ttlKeys.add(key);
    return true;
  }

  // ---- strings ----------------------------------------------------------

  get(key: string): string | null {
    const entry = this.requireType<StringEntry>(key, 'string');
    return entry ? entry.value : null;
  }

  /**
   * SET with the full option surface used by locks and caches: NX/XX
   * conditions, KEEPTTL, and GET. Returns whether the write happened and the
   * previous string value (for the GET option). A GET against a non-string
   * key throws WrongTypeError, matching Redis — an NX/XX no-op still surfaces
   * the old value so `SET k v NX GET` reports the winner of a lock race.
   * A write that creates a brand-new key still passes the OOM admission guard.
   */
  set(
    key: string,
    value: string,
    opts?: {
      exSeconds?: number;
      pxMs?: number;
      keepTtl?: boolean;
      nx?: boolean;
      xx?: boolean;
      get?: boolean;
    },
  ): { set: boolean; oldValue: string | null } {
    const existing = this.getLive(key);

    let oldValue: string | null = null;
    if (opts?.get) {
      if (existing !== undefined && existing.type !== 'string') throw new WrongTypeError();
      oldValue = existing !== undefined ? (existing as StringEntry).value : null;
    }

    const exists = existing !== undefined;
    if (opts?.nx && exists) return { set: false, oldValue };
    if (opts?.xx && !exists) return { set: false, oldValue };

    let expiresAtMs: number | null;
    if (opts?.keepTtl) {
      expiresAtMs = existing !== undefined ? existing.expiresAtMs : null;
    } else if (opts?.pxMs !== undefined) {
      expiresAtMs = Date.now() + opts.pxMs;
    } else if (opts?.exSeconds !== undefined) {
      expiresAtMs = Date.now() + opts.exSeconds * 1000;
    } else {
      expiresAtMs = null;
    }

    if (!exists) this.ensureRoomForNewKey();
    this.put(key, { type: 'string', value, expiresAtMs });
    // SET replaces any prior entry, so its TTL state is authoritative here:
    // index it when it carries an expiry, drop any stale index entry otherwise.
    if (expiresAtMs !== null) this.ttlKeys.add(key);
    else this.ttlKeys.delete(key);
    return { set: true, oldValue };
  }

  /** MGET: nil for every missing or non-string key (MGET never errors on type). */
  mget(keys: string[]): (string | null)[] {
    return keys.map((key) => {
      const entry = this.getLive(key);
      return entry !== undefined && entry.type === 'string' ? entry.value : null;
    });
  }

  /** MSET: unconditional multi-key set; each write clears any prior TTL, as in Redis. New keys pass the OOM guard. */
  mset(pairs: Array<[string, string]>): void {
    for (const [key, value] of pairs) {
      if (this.getLive(key) === undefined) this.ensureRoomForNewKey();
      this.put(key, { type: 'string', value, expiresAtMs: null });
    }
  }

  incr(key: string, originId: string = LOCAL_ORIGIN): number {
    const entry = this.requireType<StringEntry>(key, 'string');
    if (entry === undefined) {
      this.ensureRoomForNewKey();
      // Brand-new counter: this origin has contributed 1, base 0.
      this.put(key, { type: 'string', value: '1', expiresAtMs: null, contributions: new Map([[originId, 1]]) });
      return 1;
    }
    if (!/^-?\d+$/.test(entry.value)) throw new NotAnIntegerError();

    // Promote a plain integer string (e.g. one a SET left) into a counter,
    // parking its current value under the shared SEED origin so increments
    // add on top of it without that base being attributed to any real node.
    let contributions = entry.contributions;
    if (contributions === undefined) {
      contributions = new Map();
      const base = Number(entry.value);
      if (base !== 0) contributions.set(SEED_ORIGIN, base);
    }
    const nextForOrigin = (contributions.get(originId) ?? 0) + 1;
    const before = estimateEntrySize(key, entry);
    contributions.set(originId, nextForOrigin);
    const total = sumContributions(contributions);
    if (!Number.isSafeInteger(total)) {
      contributions.set(originId, nextForOrigin - 1); // roll back the increment we can't represent
      throw new NotAnIntegerError();
    }
    entry.contributions = contributions;
    entry.value = String(total);
    this.memoryBytes += estimateEntrySize(key, entry) - before;
    return total;
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

  /**
   * Returns the members actually removed (not just a count) — the
   * cluster dispatcher needs the names to replicate this as a targeted
   * per-member delete rather than re-shipping the whole sorted set.
   */
  zremrangebyscore(key: string, min: ScoreBound, max: ScoreBound): string[] {
    const entry = this.requireType<SortedSetEntry>(key, 'sortedset');
    if (!entry) return [];
    const before = estimateEntrySize(key, entry);
    const removed: string[] = [];
    for (const [member, score] of entry.members) {
      if (scoreInRange(score, min, max)) {
        entry.members.delete(member);
        removed.push(member);
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

  /**
   * O(1) keyspace byte estimate straight off the running counter — for hot
   * observers (the metrics gauge, scraped per collection) that need a
   * number every few seconds and shouldn't pay an O(keyspace) walk for it.
   * May transiently count expired-but-unswept keys; stats() is the exact
   * (walked, expiry-excluding) cross-check for the admin view.
   */
  memoryBytesEstimate(): number {
    return this.memoryBytes;
  }

  /**
   * O(1) per-type key counts straight off the running counters — used by
   * the cluster heartbeat (every 10 s) so it doesn't walk the whole
   * keyspace just to report a breakdown. Same expired-key caveat as
   * memoryBytesEstimate().
   */
  keyCounts(): Record<EntryTypeName, number> {
    return { ...this.keyCountByType };
  }

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

  /**
   * Overwrites a key with an absolute entry snapshot — used both to
   * hydrate from the durable store at startup and to apply a mutation
   * replicated from another node. Never triggers further
   * persistence/replication itself; the caller (ClusterCoordinator) owns
   * that decision so applying a remote event doesn't re-broadcast it.
   */
  applyReplicatedUpsert(key: string, entry: Entry): void {
    // Two counters for the same key must MERGE (max per origin), not
    // overwrite: a whole-entry counter snapshot from hydration or
    // anti-entropy arriving over a locally-newer counter would otherwise
    // revert this node's own not-yet-persisted increments. A plain string
    // (a SET, no contributions) still replaces — SET is last-write-wins and
    // deliberately clears any counter state. Non-counter entries just replace.
    const existing = this.data.get(key);
    if (entry.type === 'string' && entry.contributions && existing?.type === 'string' && existing.contributions) {
      const before = estimateEntrySize(key, existing);
      for (const [origin, total] of entry.contributions) {
        existing.contributions.set(origin, Math.max(existing.contributions.get(origin) ?? 0, total));
      }
      existing.value = String(sumContributions(existing.contributions));
      existing.expiresAtMs = entry.expiresAtMs;
      this.memoryBytes += estimateEntrySize(key, existing) - before;
      return;
    }
    this.put(key, entry);
  }

  /**
   * Applies a replicated INCR — folds one origin's cumulative contribution
   * into the local counter by MAX (never a blind overwrite), so the same
   * event delivered twice, out of order, or after a snapshot that already
   * included it is idempotent and can't double-count. Creates the counter
   * if absent; seeds a plain integer string's base under SEED_ORIGIN first,
   * exactly like local INCR. Bypasses admission control (the origin already
   * accepted the write). A no-op if the key is a non-string type.
   *
   * Note on origin growth (deferred compaction): a long-lived *persisted*
   * counter accrues one contribution entry per origin (≈ per deploy
   * generation, since Container Apps replica names rotate). Compacting dead
   * origins into SEED at hydration looks tempting but is unsafe with the
   * max-merge above: if a "dead" origin were actually only lapsed and later
   * re-sent its cumulative total, that total (which includes what was folded
   * into SEED) would be re-added, permanently double-counting on the
   * compacting node and diverging it from its peers. Safe compaction needs a
   * reliable "origin is permanently gone" signal (generation id / graceful
   * tombstone) that doesn't exist today. Low urgency: with
   * DURABILITY_MIN_TTL_MS on, short-TTL counters aren't persisted and never
   * hydrate, so only rare long-lived counters accumulate. Revisit if the
   * per-counter origin count is ever a measured problem.
   */
  applyReplicatedIncrement(key: string, originId: string, originTotal: number): void {
    const existing = this.data.get(key);
    if (existing !== undefined && existing.type !== 'string') return;
    if (existing === undefined) {
      this.put(key, { type: 'string', value: String(originTotal), expiresAtMs: null, contributions: new Map([[originId, originTotal]]) });
      return;
    }
    const before = estimateEntrySize(key, existing);
    let contributions = existing.contributions;
    if (contributions === undefined) {
      contributions = new Map();
      const base = /^-?\d+$/.test(existing.value) ? Number(existing.value) : 0;
      if (base !== 0) contributions.set(SEED_ORIGIN, base);
    }
    contributions.set(originId, Math.max(contributions.get(originId) ?? 0, originTotal));
    existing.contributions = contributions;
    existing.value = String(sumContributions(contributions));
    this.memoryBytes += estimateEntrySize(key, existing) - before;
  }

  /** This origin's cumulative contribution to a counter key, for replicating an INCR as a commutative per-origin total. 0 if absent/not a counter. */
  contributionFor(key: string, originId: string): number {
    const entry = this.getLive(key);
    if (entry?.type !== 'string' || entry.contributions === undefined) return 0;
    return entry.contributions.get(originId) ?? 0;
  }

  /** Removes a key as a result of hydration or a replicated delete, without cascading further replication. */
  applyReplicatedDelete(key: string): void {
    this.remove(key);
  }

  /**
   * Applies a replicated EXPIRE/PEXPIRE — sets only the key's TTL, leaving
   * its value/fields/members untouched. Replicating a TTL change this way
   * (rather than as a whole-entry upsert) is what keeps a concurrent
   * field-granular write on the same hash/sorted set from being clobbered
   * by a peer's EXPIRE. A no-op if the key doesn't exist locally: EXPIRE
   * can't create a key, so there's nothing to attach a TTL to (the origin
   * node's own EXPIRE already returned 0 in that case and wouldn't have
   * replicated at all).
   */
  applyReplicatedTtl(key: string, expiresAtMs: number | null): void {
    const entry = this.getLive(key);
    if (entry === undefined) return;
    entry.expiresAtMs = expiresAtMs;
  }

  /**
   * Applies a replicated HSET — sets only the named fields, leaving any
   * other fields on the hash untouched. This (not a whole-entry
   * overwrite) is what lets two nodes concurrently HSET *different*
   * fields of the same key without either write clobbering the other.
   * Deliberately not gated by ensureRoomForNewKey(): the mutation was
   * already accepted on the node that originated it, so refusing to apply
   * it here would just make this node's copy diverge, not protect it.
   */
  applyReplicatedHashFieldSet(key: string, fields: Array<[string, string]>): void {
    const existing = this.data.get(key);
    if (existing?.type === 'hash') {
      const before = estimateEntrySize(key, existing);
      for (const [field, value] of fields) existing.fields.set(field, value);
      this.memoryBytes += estimateEntrySize(key, existing) - before;
      return;
    }
    // New key (or a type change from a divergent peer): route through put()
    // so the byte estimate and per-type key counts stay exact.
    const entry: HashEntry = { type: 'hash', fields: new Map(fields), expiresAtMs: null };
    this.put(key, entry);
  }

  /** Applies a replicated HDEL — removes only the named fields. Deletes the whole key once its last field is gone, matching local HDEL semantics. */
  applyReplicatedHashFieldDelete(key: string, fields: string[]): void {
    const entry = this.data.get(key);
    if (!entry || entry.type !== 'hash') return;
    const before = estimateEntrySize(key, entry);
    for (const field of fields) entry.fields.delete(field);
    if (entry.fields.size === 0) {
      this.remove(key);
    } else {
      this.memoryBytes += estimateEntrySize(key, entry) - before;
    }
  }

  /**
   * Applies a replicated ZADD — sets only the named members, leaving any
   * other members on the sorted set untouched. See
   * applyReplicatedHashFieldSet for why this isn't gated by
   * ensureRoomForNewKey().
   */
  applyReplicatedZsetMemberSet(key: string, members: Array<[string, number]>): void {
    const existing = this.data.get(key);
    if (existing?.type === 'sortedset') {
      const before = estimateEntrySize(key, existing);
      for (const [member, score] of members) existing.members.set(member, score);
      this.memoryBytes += estimateEntrySize(key, existing) - before;
      return;
    }
    // New key (or a type change from a divergent peer): route through put()
    // so the byte estimate and per-type key counts stay exact.
    const entry: SortedSetEntry = { type: 'sortedset', members: new Map(members), expiresAtMs: null };
    this.put(key, entry);
  }

  /** Applies a replicated ZREMRANGEBYSCORE — removes only the named members. Deletes the whole key once its last member is gone, matching local semantics. */
  applyReplicatedZsetMemberDelete(key: string, members: string[]): void {
    const entry = this.data.get(key);
    if (!entry || entry.type !== 'sortedset') return;
    const before = estimateEntrySize(key, entry);
    for (const member of members) entry.members.delete(member);
    if (entry.members.size === 0) {
      this.remove(key);
    } else {
      this.memoryBytes += estimateEntrySize(key, entry) - before;
    }
  }
}

function estimateEntrySize(key: string, entry: Entry): number {
  let size = key.length * 2 + 48; // rough per-entry overhead
  if (entry.type === 'string') {
    size += entry.value.length * 2;
    if (entry.contributions) {
      for (const [origin] of entry.contributions) size += origin.length * 2 + 16;
    }
  } else if (entry.type === 'hash') {
    for (const [f, v] of entry.fields) size += (f.length + v.length) * 2 + 16;
  } else {
    for (const [m] of entry.members) size += m.length * 2 + 24;
  }
  return size;
}
