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

  /** Upserts the post-mutation state of a key (last-write-wins across nodes). */
  putKey(key: string, entry: EntrySnapshot): Promise<void>;

  /** Permanently removes a key. Idempotent — a missing key is not an error. */
  deleteKey(key: string): Promise<void>;

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

  async putKey(): Promise<void> {}

  async deleteKey(): Promise<void> {}

  async putNodeSnapshot(): Promise<void> {}

  async listNodeSnapshots(): Promise<NodeSnapshot[]> {
    return [];
  }

  async deleteNodeSnapshot(): Promise<void> {}

  async close(): Promise<void> {}
}
