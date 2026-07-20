import type { ReplicationEvent } from './types.js';

/**
 * Fan-out transport that keeps every node's in-memory hot copy in sync:
 * a mutation applied on one node is broadcast here and applied on every
 * other node. Backed by Azure Service Bus in production (see
 * serviceBusTransport.ts); NullReplicationTransport is the standalone
 * (single-node) fallback — it never delivers anything, since there are no
 * peers to sync with.
 */
export interface ReplicationTransport {
  readonly kind: 'null' | 'servicebus';

  /**
   * Starts delivering incoming events to `onMessage`. Must be called once
   * before publish(). `onFatal` is invoked if the transport detects an
   * unrecoverable receive condition — its subscription vanished, or receive
   * errors are sustained — after which this node can no longer be trusted
   * to see peers' writes and should exit so a restart re-creates the
   * subscription and re-hydrates (see docs/high-availability.md). Silent,
   * permanent divergence is the failure this prevents.
   */
  start(onMessage: (event: ReplicationEvent) => void, onFatal?: (err: Error) => void): Promise<void>;

  /** Broadcasts an event to every other node. */
  publish(event: ReplicationEvent): Promise<void>;

  stop(): Promise<void>;
}

export class NullReplicationTransport implements ReplicationTransport {
  readonly kind = 'null' as const;

  async start(): Promise<void> {}

  async publish(): Promise<void> {}

  async stop(): Promise<void> {}
}
