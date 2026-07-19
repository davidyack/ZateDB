import type { DurableStore } from '../../src/cluster/durableStore.js';
import type { ReplicationTransport } from '../../src/cluster/replicationTransport.js';
import type { EntrySnapshot, NodeSnapshot, ReplicationEvent } from '../../src/cluster/types.js';

/**
 * In-memory double for Cosmos DB. Shared across simulated nodes in a test
 * (pass the same instance to each node's ClusterCoordinator) to exercise
 * hydration and cross-node persistence without a real Azure resource.
 */
export class FakeDurableStore implements DurableStore {
  readonly kind = 'cosmos' as const;
  readonly keys = new Map<string, EntrySnapshot>();
  readonly nodes = new Map<string, NodeSnapshot>();
  /** Per-key last-write watermark, mirroring Cosmos's updatedAtMs — backs loadChangedSince. */
  readonly updatedAt = new Map<string, number>();
  private clock = 0;

  /** Strictly-monotonic write timestamp so same-millisecond writes still order (and tests can reason about watermarks). */
  private nextTs(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }
  /** Test hook: stamp a key's watermark explicitly (e.g. to simulate a peer's write that arrived out of band). */
  setUpdatedAt(key: string, ms: number): void {
    this.updatedAt.set(key, ms);
    this.clock = Math.max(this.clock, ms);
  }

  async loadAll(): Promise<Array<{ key: string; entry: EntrySnapshot }>> {
    return Array.from(this.keys.entries()).map(([key, entry]) => ({ key, entry }));
  }
  async loadChangedSince(sinceMs: number): Promise<Array<{ key: string; entry: EntrySnapshot; updatedAtMs: number }>> {
    const out: Array<{ key: string; entry: EntrySnapshot; updatedAtMs: number }> = [];
    for (const [key, entry] of this.keys) {
      const updatedAtMs = this.updatedAt.get(key) ?? 0;
      if (updatedAtMs > sinceMs) out.push({ key, entry, updatedAtMs });
    }
    return out;
  }
  async putKey(key: string, entry: EntrySnapshot): Promise<void> {
    this.keys.set(key, entry);
    this.updatedAt.set(key, this.nextTs());
  }
  async deleteKey(key: string): Promise<void> {
    this.keys.delete(key);
    this.updatedAt.delete(key);
  }
  async putTtl(key: string, expiresAtMs: number | null): Promise<void> {
    const existing = this.keys.get(key);
    if (existing === undefined) return; // EXPIRE can't create a key
    this.keys.set(key, { ...existing, expiresAtMs });
    this.updatedAt.set(key, this.nextTs());
  }
  async putHashFields(key: string, fields: Array<[string, string]>): Promise<void> {
    const existing = this.keys.get(key);
    const base = existing?.type === 'hash' ? existing.fields : {};
    const merged = { ...base };
    for (const [field, value] of fields) merged[field] = value;
    this.keys.set(key, { type: 'hash', fields: merged, expiresAtMs: existing?.type === 'hash' ? existing.expiresAtMs : null });
    this.updatedAt.set(key, this.nextTs());
  }
  async deleteHashFields(key: string, fields: string[]): Promise<void> {
    const existing = this.keys.get(key);
    if (existing?.type !== 'hash') return;
    const merged = { ...existing.fields };
    for (const field of fields) delete merged[field];
    this.keys.set(key, { ...existing, fields: merged });
    this.updatedAt.set(key, this.nextTs());
  }
  async putZsetMembers(key: string, members: Array<[string, number]>): Promise<void> {
    const existing = this.keys.get(key);
    const base = existing?.type === 'sortedset' ? existing.members : {};
    const merged = { ...base };
    for (const [member, score] of members) merged[member] = score;
    this.keys.set(key, { type: 'sortedset', members: merged, expiresAtMs: existing?.type === 'sortedset' ? existing.expiresAtMs : null });
    this.updatedAt.set(key, this.nextTs());
  }
  async deleteZsetMembers(key: string, members: string[]): Promise<void> {
    const existing = this.keys.get(key);
    if (existing?.type !== 'sortedset') return;
    const merged = { ...existing.members };
    for (const member of members) delete merged[member];
    this.keys.set(key, { ...existing, members: merged });
    this.updatedAt.set(key, this.nextTs());
  }
  async putNodeSnapshot(snapshot: NodeSnapshot): Promise<void> {
    this.nodes.set(snapshot.nodeId, snapshot);
  }
  async listNodeSnapshots(): Promise<NodeSnapshot[]> {
    return Array.from(this.nodes.values());
  }
  async deleteNodeSnapshot(nodeId: string): Promise<void> {
    this.nodes.delete(nodeId);
  }
  async close(): Promise<void> {}
}

/**
 * In-memory double for an Azure Service Bus topic: every transport created
 * from the same hub instance receives every other transport's publishes,
 * mirroring the real topic/one-subscription-per-node fan-out pattern (see
 * serviceBusTransport.ts) without a real Service Bus namespace.
 */
export class FakeReplicationHub {
  private readonly transports = new Set<FakeReplicationTransport>();

  createTransport(nodeId: string): FakeReplicationTransport {
    return new FakeReplicationTransport(nodeId, this);
  }

  register(t: FakeReplicationTransport): void {
    this.transports.add(t);
  }

  unregister(t: FakeReplicationTransport): void {
    this.transports.delete(t);
  }

  broadcast(event: ReplicationEvent): void {
    for (const t of this.transports) t.deliver(event);
  }
}

export class FakeReplicationTransport implements ReplicationTransport {
  readonly kind = 'null' as const;
  private onMessage: ((event: ReplicationEvent) => void) | null = null;
  private onFatal: ((err: Error) => void) | null = null;

  constructor(private readonly nodeId: string, private readonly hub: FakeReplicationHub) {}

  async start(onMessage: (event: ReplicationEvent) => void, onFatal?: (err: Error) => void): Promise<void> {
    this.onMessage = onMessage;
    this.onFatal = onFatal ?? null;
    this.hub.register(this);
  }

  /** Test hook: simulate the transport detecting an unrecoverable receive condition (subscription gone / sustained errors). */
  simulateFatal(err: Error): void {
    this.onFatal?.(err);
  }

  async publish(event: ReplicationEvent): Promise<void> {
    await Promise.resolve(); // simulate the real transport's async, out-of-process hop
    this.hub.broadcast(event);
  }

  /** Mirrors ServiceBusReplicationTransport's own self-origin filter, since a real topic can echo back to its author. */
  deliver(event: ReplicationEvent): void {
    if (event.originNodeId !== this.nodeId) this.onMessage?.(event);
  }

  async stop(): Promise<void> {
    this.hub.unregister(this);
  }
}
