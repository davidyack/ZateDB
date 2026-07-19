import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { DurableStore } from './durableStore.js';
import type { ReplicationTransport } from './replicationTransport.js';
import type { NodeSnapshot, ReplicationEvent } from './types.js';
import { entryToSnapshot, snapshotToEntry } from './snapshot.js';
import { redactKey } from '../telemetry/commandTelemetry.js';
import { errorMessage, logger } from '../logger.js';

export interface ClusterCoordinatorDeps {
  store: Store;
  pubsub: PubSubRegistry;
  durable: DurableStore;
  transport: ReplicationTransport;
  nodeId: string;
  haEnabled: boolean;
  heartbeatIntervalMs: number;
  /** A peer's heartbeat older than this is treated as dead and dropped from cluster views. */
  nodeStaleMs: number;
  connectionCount(): number;
  commandsTotal(): number;
}

/**
 * Orchestrates the three moving parts of multi-node HA:
 *
 * 1. Startup hydration — loads every key from the durable store (Cosmos
 *    DB) into the local in-memory Store before the node is considered
 *    ready, so a restart or scale-out doesn't start cold.
 * 2. Replication — after a mutating command succeeds locally, publishes
 *    the resulting key state to the durable store and broadcasts it over
 *    the replication transport (Service Bus) so every other node's
 *    in-memory copy converges. This is fire-and-forget relative to the
 *    client's reply (the RESP reply already went out using the fast local
 *    result) but tracked so a graceful shutdown can drain it — see
 *    drain(). Cross-node convergence happens within the transport's
 *    delivery latency, not synchronously; see docs/high-availability.md
 *    for what that trades away.
 * 3. Heartbeat — periodically writes this node's stats/topology snapshot
 *    to the durable store so the admin API can report a cluster-wide view
 *    regardless of which node answers the request.
 *
 * In standalone mode (haEnabled = false — no durable store/transport
 * configured), every method here is a no-op and behavior is identical to
 * running a single, in-memory-only node.
 */
export class ClusterCoordinator {
  readonly nodeId: string;
  readonly haEnabled: boolean;

  private seq = 0;
  private hydratedFlag = false;
  private inFlight = new Set<Promise<unknown>>();
  private lastPublishByKey = new Map<string, Promise<void>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ClusterCoordinatorDeps) {
    this.nodeId = deps.nodeId;
    this.haEnabled = deps.haEnabled;
  }

  get isHydrated(): boolean {
    return !this.haEnabled || this.hydratedFlag;
  }

  async start(): Promise<void> {
    if (!this.haEnabled) {
      this.hydratedFlag = true;
      return;
    }

    // The transport starts delivering live events immediately, but
    // hydrate() below reads a point-in-time snapshot from the durable
    // store that can already be stale by the time it resolves. Applying
    // that snapshot after a live event for the same key would silently
    // revert it. So incoming events are buffered (not applied) until
    // hydration finishes, then replayed — live writes always land after
    // the snapshot, never before it.
    let hydrating = true;
    const buffered: ReplicationEvent[] = [];
    await this.deps.transport.start((event) => {
      if (hydrating) buffered.push(event);
      else this.applyRemoteEvent(event);
    });

    await this.hydrate();
    hydrating = false;
    for (const event of buffered) this.applyRemoteEvent(event);

    this.heartbeatTimer = setInterval(() => this.track(this.heartbeat()), this.deps.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    this.track(this.heartbeat());
  }

  private async hydrate(): Promise<void> {
    const snapshots = await this.deps.durable.loadAll();
    for (const { key, entry } of snapshots) {
      this.deps.store.applyReplicatedUpsert(key, snapshotToEntry(entry));
    }
    this.hydratedFlag = true;
    logger.info('cluster.hydrated', { nodeId: this.nodeId, keyCount: snapshots.length });
  }

  /**
   * Call after a mutating command (SET/INCR/EXPIRE/PEXPIRE/HSET/HDEL/
   * ZADD/ZREMRANGEBYSCORE/DEL) has already been applied to the local
   * store. Reads the resulting state back and ships it out — an entry
   * that no longer exists is replicated as a delete. Publishes for the
   * same key are chained in call order (not run concurrently): otherwise
   * two independent fire-and-forget network round trips for e.g. two
   * rapid SETs on the same key could complete out of order and leave the
   * cluster converged on the older value.
   */
  publishKeyChange(key: string): void {
    if (!this.haEnabled) return;
    const entry = this.deps.store.getRawEntry(key);
    const prior = this.lastPublishByKey.get(key) ?? Promise.resolve();
    const task = prior.then(() =>
      this.doPublishKeyChange(key, entry).catch((err) => {
        logger.warn('cluster.replicate_failed', { key: redactKey(key), error: errorMessage(err) });
      }),
    );
    this.lastPublishByKey.set(key, task);
    void task.finally(() => {
      if (this.lastPublishByKey.get(key) === task) this.lastPublishByKey.delete(key);
    });
    this.track(task);
  }

  private async doPublishKeyChange(key: string, entry: ReturnType<Store['getRawEntry']>): Promise<void> {
    // The Cosmos DB write and the Service Bus broadcast are independent —
    // peers apply the broadcast event directly, they don't read it back
    // from Cosmos — so they run concurrently rather than back-to-back.
    if (entry === undefined) {
      await Promise.all([this.deps.durable.deleteKey(key), this.deps.transport.publish(this.makeEvent({ kind: 'delete', key }))]);
    } else {
      const snapshot = entryToSnapshot(entry);
      await Promise.all([
        this.deps.durable.putKey(key, snapshot),
        this.deps.transport.publish(this.makeEvent({ kind: 'upsert', key, entry: snapshot })),
      ]);
    }
  }

  /** Cross-node fan-out for PUBLISH — local delivery already happened via the pub/sub registry before this is called. */
  publishMessage(channel: string, message: string): void {
    if (!this.haEnabled) return;
    this.track(
      this.deps.transport.publish(this.makeEvent({ kind: 'publish', channel, message })).catch((err) => {
        logger.warn('cluster.publish_broadcast_failed', { error: errorMessage(err) });
      }),
    );
  }

  private applyRemoteEvent(event: ReplicationEvent): void {
    try {
      if (event.kind === 'upsert' && event.key !== undefined && event.entry !== undefined) {
        this.deps.store.applyReplicatedUpsert(event.key, snapshotToEntry(event.entry));
      } else if (event.kind === 'delete' && event.key !== undefined) {
        this.deps.store.applyReplicatedDelete(event.key);
      } else if (event.kind === 'publish' && event.channel !== undefined && event.message !== undefined) {
        this.deps.pubsub.publish(event.channel, event.message);
      }
    } catch (err) {
      logger.warn('cluster.apply_remote_event_failed', { kind: event.kind, error: errorMessage(err) });
    }
  }

  private makeEvent(partial: Omit<ReplicationEvent, 'originNodeId' | 'seq' | 'timestampMs'>): ReplicationEvent {
    return { originNodeId: this.nodeId, seq: ++this.seq, timestampMs: Date.now(), ...partial };
  }

  private track(promise: Promise<unknown>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private async heartbeat(): Promise<void> {
    try {
      const storeStats = this.deps.store.stats();
      const topology = this.deps.pubsub.topology();
      const snapshot: NodeSnapshot = {
        nodeId: this.nodeId,
        lastHeartbeatMs: Date.now(),
        connectionCount: this.deps.connectionCount(),
        keyCounts: storeStats.keyCounts,
        commandsTotal: this.deps.commandsTotal(),
        subscriptions: topology,
      };
      await this.deps.durable.putNodeSnapshot(snapshot);
    } catch (err) {
      logger.warn('cluster.heartbeat_failed', { error: errorMessage(err) });
    }
  }

  /** Live cluster members (heartbeat within nodeStaleMs) for the admin API. Empty in standalone mode. */
  async clusterSnapshot(): Promise<NodeSnapshot[]> {
    if (!this.haEnabled) return [];
    const all = await this.deps.durable.listNodeSnapshots();
    const now = Date.now();
    return all.filter((n) => now - n.lastHeartbeatMs <= this.deps.nodeStaleMs);
  }

  /**
   * Awaits in-flight replication work — every publish and heartbeat, not
   * just key replication — bounded by timeoutMs. Called during graceful
   * shutdown, before stop() deletes this node's heartbeat snapshot: an
   * in-flight heartbeat write completing *after* that delete would
   * silently resurrect this node in cluster admin views until it goes
   * stale. Every tracked promise already catches its own errors (see
   * publishKeyChange/publishMessage/heartbeat), so none of them reject —
   * Promise.all is equivalent to allSettled here and simpler.
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const pending = Array.from(this.inFlight);
    if (pending.length === 0) return;
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  async stop(): Promise<void> {
    await this.drain(2000);
    if (!this.haEnabled) return;
    await this.deps.durable.deleteNodeSnapshot(this.nodeId).catch(() => {});
    await this.deps.transport.stop();
    await this.deps.durable.close();
  }
}
