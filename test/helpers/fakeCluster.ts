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

  async loadAll(): Promise<Array<{ key: string; entry: EntrySnapshot }>> {
    return Array.from(this.keys.entries()).map(([key, entry]) => ({ key, entry }));
  }
  async putKey(key: string, entry: EntrySnapshot): Promise<void> {
    this.keys.set(key, entry);
  }
  async deleteKey(key: string): Promise<void> {
    this.keys.delete(key);
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

  createTransport(nodeId: string): ReplicationTransport {
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

class FakeReplicationTransport implements ReplicationTransport {
  readonly kind = 'null' as const;
  private onMessage: ((event: ReplicationEvent) => void) | null = null;

  constructor(private readonly nodeId: string, private readonly hub: FakeReplicationHub) {}

  async start(onMessage: (event: ReplicationEvent) => void): Promise<void> {
    this.onMessage = onMessage;
    this.hub.register(this);
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
