import type { EntrySnapshot, NodeSnapshot } from './types.js';

/**
 * The durable backing store: the source of truth a node hydrates from at
 * startup so a restart or scale-out event doesn't lose shared counters,
 * presence, or sliding-window state. Backed by Cosmos DB in production
 * (see cosmosDurableStore.ts); NullDurableStore below is the standalone
 * (single-node, in-memory-only) fallback used when no durable store is
 * configured, keeping local dev and tests hermetic.
 */
export interface DurableStore {
  readonly kind: 'null' | 'cosmos';

  /** Every live key snapshot, for startup hydration. */
  loadAll(): Promise<Array<{ key: string; entry: EntrySnapshot }>>;

  /**
   * Live key snapshots written since `sinceMs` (by `updatedAtMs`), for
   * periodic anti-entropy re-hydration — a cheap convergence backstop that
   * repairs anything a node missed while replication was briefly broken
   * (a partition past the message TTL, a receiver blip). Each row carries
   * its `updatedAtMs` so the caller can advance its watermark.
   */
  loadChangedSince(sinceMs: number): Promise<Array<{ key: string; entry: EntrySnapshot; updatedAtMs: number }>>;

  /** Upserts the whole post-mutation state of a key (last-write-wins across nodes) — used for SET/DEL. */
  putKey(key: string, entry: EntrySnapshot): Promise<void>;

  /**
   * Persists one origin's cumulative contribution to a counter key (INCR)
   * without touching any other origin's — the durable counterpart of the
   * in-memory G-counter, so two nodes incrementing the same counter
   * concurrently both survive instead of last-write-wins clobbering. Set to
   * the running total (idempotent), not added. Creates the counter if absent.
   */
  putIncrement(key: string, originId: string, originTotal: number): Promise<void>;

  /** Permanently removes a key. Idempotent — a missing key is not an error. */
  deleteKey(key: string): Promise<void>;

  /**
   * Updates only a key's TTL (EXPIRE/PEXPIRE) without rewriting its
   * value/fields/members — the durable-store counterpart of
   * Store.applyReplicatedTtl, so a TTL change never clobbers concurrently
   * persisted field/member writes. A no-op if the key doesn't exist.
   */
  putTtl(key: string, expiresAtMs: number | null): Promise<void>;

  /**
   * Sets specific hash fields without touching any other field on the
   * same key — used for HSET, so two nodes setting *different* fields of
   * the same hash concurrently don't clobber each other the way a
   * whole-entry upsert would. Creates the hash if it doesn't exist yet.
   */
  putHashFields(key: string, fields: Array<[string, string]>): Promise<void>;

  /** Removes specific hash fields without touching any other field. A no-op if the key doesn't exist. */
  deleteHashFields(key: string, fields: string[]): Promise<void>;

  /** Sets specific sorted-set members without touching any other member on the same key — used for ZADD, for the same reason as putHashFields. */
  putZsetMembers(key: string, members: Array<[string, number]>): Promise<void>;

  /** Removes specific sorted-set members without touching any other member. A no-op if the key doesn't exist. */
  deleteZsetMembers(key: string, members: string[]): Promise<void>;

  /** Heartbeat: this node's current stats/topology snapshot. */
  putNodeSnapshot(snapshot: NodeSnapshot): Promise<void>;

  /** Every node's last-written heartbeat snapshot (staleness is filtered by the caller). */
  listNodeSnapshots(): Promise<NodeSnapshot[]>;

  /** Best-effort cleanup on graceful shutdown so a stopped node doesn't linger in topology views. */
  deleteNodeSnapshot(nodeId: string): Promise<void>;

  close(): Promise<void>;
}

export class NullDurableStore implements DurableStore {
  readonly kind = 'null' as const;

  async loadAll(): Promise<Array<{ key: string; entry: EntrySnapshot }>> {
    return [];
  }

  async loadChangedSince(): Promise<Array<{ key: string; entry: EntrySnapshot; updatedAtMs: number }>> {
    return [];
  }

  async putKey(): Promise<void> {}

  async putIncrement(): Promise<void> {}

  async deleteKey(): Promise<void> {}

  async putTtl(): Promise<void> {}

  async putHashFields(): Promise<void> {}

  async deleteHashFields(): Promise<void> {}

  async putZsetMembers(): Promise<void> {}

  async deleteZsetMembers(): Promise<void> {}

  async putNodeSnapshot(): Promise<void> {}

  async listNodeSnapshots(): Promise<NodeSnapshot[]> {
    return [];
  }

  async deleteNodeSnapshot(): Promise<void> {}

  async close(): Promise<void> {}
}
