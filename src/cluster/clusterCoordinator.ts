import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import type { DurableStore } from './durableStore.js';
import type { ReplicationTransport } from './replicationTransport.js';
import type { NodeSnapshot, ReplicationEvent } from './types.js';
import { entryToSnapshot, snapshotToEntry } from './snapshot.js';
import { redactKey } from '../telemetry/commandTelemetry.js';
import { errorMessage, logger } from '../logger.js';

/**
 * A queued replication side-effect for one key. `coalesceClass` groups
 * writes that fully supersede one another: two consecutive `'whole'` writes
 * (SET/INCR/DEL — each ships the key's entire post-state) collapse to the
 * later one, and two consecutive `'ttl'` writes likewise. Field/member
 * deltas use `'field'` and never coalesce (each carries a distinct
 * field/member change that a later one doesn't contain), and mixed classes
 * never coalesce across each other, preserving order.
 */
interface ReplicationTask {
  coalesceClass: 'whole' | 'ttl' | 'field';
  run: () => Promise<void>;
}

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
  /**
   * Keyspace byte ceiling (config.maxMemoryBytes) used to bound startup
   * hydration: loading a Cosmos keyspace that grew past what this node can
   * hold would OOM it into a restart loop, so hydration stops (with a loud
   * log) once the loaded estimate crosses this. 0 or unset disables the bound.
   */
  maxMemoryBytes?: number;
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
  /**
   * Per-key FIFO of replication tasks not yet started, plus the set of keys
   * whose FIFO is currently being drained. Same-key writes stay ordered
   * (drained one at a time); consecutive whole-key absolute writes for a
   * key coalesce to the latest queued one (see enqueueForKey).
   */
  private replicationQueue = new Map<string, ReplicationTask[]>();
  private draining = new Set<string>();
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
    const now = Date.now();
    const ceiling = this.deps.maxMemoryBytes ?? 0;
    let loaded = 0;
    let skippedExpired = 0;
    let stoppedAtCeiling = false;
    for (const { key, entry } of snapshots) {
      // Defence in depth against a durable store that hasn't (yet) dropped
      // expired documents: never hydrate a key that's already dead, so a
      // restart doesn't resurrect it or pay to hold it.
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
        skippedExpired++;
        continue;
      }
      // A Cosmos keyspace larger than this node can hold would OOM it into a
      // crash loop mid-hydration. Stop loading (serving the partial set is
      // strictly better than never becoming ready) and log loudly so the
      // undersized-node / oversized-keyspace mismatch is visible.
      if (ceiling > 0 && this.deps.store.memoryBytesEstimate() >= ceiling) {
        stoppedAtCeiling = true;
        break;
      }
      this.deps.store.applyReplicatedUpsert(key, snapshotToEntry(entry));
      loaded++;
    }
    this.hydratedFlag = true;
    logger.info('cluster.hydrated', {
      nodeId: this.nodeId,
      keyCount: loaded,
      skippedExpired,
      approxBytes: this.deps.store.memoryBytesEstimate(),
      stoppedAtCeiling,
    });
    if (stoppedAtCeiling) {
      logger.warn('cluster.hydration_truncated', {
        nodeId: this.nodeId,
        hint: 'durable keyspace exceeds MAX_MEMORY_BYTES; hydrated a partial set — increase node memory or shard the keyspace',
        maxMemoryBytes: ceiling,
        loaded,
        totalDocuments: snapshots.length,
      });
    }
  }

  /**
   * Call after a mutating command (SET/INCR/EXPIRE/PEXPIRE/DEL) has
   * already been applied to the local store. Reads the resulting state
   * back and ships it out — an entry that no longer exists is replicated
   * as a delete. Whole-entry: for HSET/HDEL/ZADD/ZREMRANGEBYSCORE, prefer
   * publishHashFieldChange/publishZsetMemberChange instead, which
   * replicate only the touched fields/members.
   */
  publishKeyChange(key: string): void {
    if (!this.haEnabled) return;
    const entry = this.deps.store.getRawEntry(key);
    // 'whole': the snapshot captured here is the key's entire post-state, so
    // an earlier still-queued whole-key write for the same key is redundant
    // and coalesces away (N rapid INCRs on a hot counter -> 1 durable write).
    this.enqueueForKey(key, 'whole', () => this.doPublishKeyChange(key, entry));
  }

  /**
   * Call after a successful EXPIRE/PEXPIRE that actually changed a key's
   * TTL. Replicates just the new expiry (not a whole-entry snapshot), so an
   * EXPIRE on a hash/sorted set never overwrites field/member writes a peer
   * has that this node hasn't received yet. See ReplicationEvent.expiresAtMs
   * and Store.applyReplicatedTtl.
   */
  publishTtlChange(key: string, expiresAtMs: number | null): void {
    if (!this.haEnabled) return;
    this.enqueueForKey(key, 'ttl', () => this.doPublishTtlChange(key, expiresAtMs));
  }

  private async doPublishTtlChange(key: string, expiresAtMs: number | null): Promise<void> {
    await Promise.all([
      this.deps.durable.putTtl(key, expiresAtMs),
      this.deps.transport.publish(this.makeEvent({ kind: 'ttl', key, expiresAtMs })),
    ]);
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

  /**
   * Call after a successful HSET (setFields non-empty) or a HDEL that
   * left the hash with at least one field remaining (deletedFields
   * non-empty) — a HDEL that emptied the hash entirely should go through
   * publishKeyChange instead, so the whole key is deleted cluster-wide
   * rather than left as an empty hash. Replicating at field granularity
   * (not the whole hash) is what lets two nodes set *different* fields of
   * the same key concurrently without either write clobbering the other.
   */
  publishHashFieldChange(key: string, setFields: Array<[string, string]>, deletedFields: string[]): void {
    if (!this.haEnabled || (setFields.length === 0 && deletedFields.length === 0)) return;
    this.enqueueForKey(key, 'field', () => this.doPublishHashFieldChange(key, setFields, deletedFields));
  }

  private async doPublishHashFieldChange(key: string, setFields: Array<[string, string]>, deletedFields: string[]): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    if (setFields.length > 0) tasks.push(this.deps.durable.putHashFields(key, setFields));
    if (deletedFields.length > 0) tasks.push(this.deps.durable.deleteHashFields(key, deletedFields));
    tasks.push(this.deps.transport.publish(this.makeEvent({ kind: 'hashField', key, setFields, deletedFields })));
    await Promise.all(tasks);
  }

  /** Same idea as publishHashFieldChange, for ZADD/ZREMRANGEBYSCORE — see that method's doc comment. */
  publishZsetMemberChange(key: string, setMembers: Array<[string, number]>, deletedMembers: string[]): void {
    if (!this.haEnabled || (setMembers.length === 0 && deletedMembers.length === 0)) return;
    this.enqueueForKey(key, 'field', () => this.doPublishZsetMemberChange(key, setMembers, deletedMembers));
  }

  private async doPublishZsetMemberChange(key: string, setMembers: Array<[string, number]>, deletedMembers: string[]): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    if (setMembers.length > 0) tasks.push(this.deps.durable.putZsetMembers(key, setMembers));
    if (deletedMembers.length > 0) tasks.push(this.deps.durable.deleteZsetMembers(key, deletedMembers));
    tasks.push(this.deps.transport.publish(this.makeEvent({ kind: 'zsetMember', key, setMembers, deletedMembers })));
    await Promise.all(tasks);
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

  /**
   * Queues `task` behind any prior publish for the same key (drained one at
   * a time, never concurrently): otherwise two independent fire-and-forget
   * network round trips for e.g. two rapid SETs (or a SET and a field
   * change) on the same key could complete out of order and leave the
   * cluster converged on stale state.
   *
   * Consecutive *not-yet-started* tasks of the same coalesceClass collapse
   * to the latest: a whole-key write ('whole') or TTL write ('ttl') fully
   * supersedes an earlier queued write of the same class (they each carry
   * the key's complete post-state for that aspect), so N rapid INCRs on a
   * hot counter cost one in-flight write plus one queued write instead of
   * N. Field/member deltas ('field') never coalesce — each carries a
   * distinct change a later one doesn't contain — and differing classes
   * never coalesce across each other, so ordering across a SET/EXPIRE/HSET
   * mix is preserved.
   */
  private enqueueForKey(key: string, coalesceClass: ReplicationTask['coalesceClass'], run: () => Promise<void>): void {
    let queue = this.replicationQueue.get(key);
    if (queue === undefined) {
      queue = [];
      this.replicationQueue.set(key, queue);
    }
    const tail = queue[queue.length - 1];
    if (tail !== undefined && coalesceClass !== 'field' && tail.coalesceClass === coalesceClass) {
      // The tail hasn't started yet (the running task was already shifted
      // off the front), so replacing it drops a redundant write, never an
      // in-flight one.
      queue[queue.length - 1] = { coalesceClass, run };
    } else {
      queue.push({ coalesceClass, run });
    }
    if (!this.draining.has(key)) this.startDraining(key);
  }

  private startDraining(key: string): void {
    this.draining.add(key);
    const drained = (async () => {
      const queue = this.replicationQueue.get(key);
      if (queue === undefined) return;
      // Shift-and-run: tasks enqueued while an earlier one awaits are picked
      // up by this same loop (and may coalesce with the queue tail first).
      while (queue.length > 0) {
        const task = queue.shift() as ReplicationTask;
        try {
          await task.run();
        } catch (err) {
          logger.warn('cluster.replicate_failed', { key: redactKey(key), error: errorMessage(err) });
        }
      }
      // No await between the emptiness check above and this cleanup, so a
      // synchronous enqueue can't slip a task in after we decide to stop.
      this.replicationQueue.delete(key);
      this.draining.delete(key);
    })();
    this.track(drained);
  }

  private applyRemoteEvent(event: ReplicationEvent): void {
    try {
      if (event.kind === 'upsert' && event.key !== undefined && event.entry !== undefined) {
        this.deps.store.applyReplicatedUpsert(event.key, snapshotToEntry(event.entry));
      } else if (event.kind === 'delete' && event.key !== undefined) {
        this.deps.store.applyReplicatedDelete(event.key);
      } else if (event.kind === 'ttl' && event.key !== undefined && event.expiresAtMs !== undefined) {
        this.deps.store.applyReplicatedTtl(event.key, event.expiresAtMs);
      } else if (event.kind === 'publish' && event.channel !== undefined && event.message !== undefined) {
        this.deps.pubsub.publish(event.channel, event.message);
      } else if (event.kind === 'hashField' && event.key !== undefined) {
        if (event.setFields?.length) this.deps.store.applyReplicatedHashFieldSet(event.key, event.setFields);
        if (event.deletedFields?.length) this.deps.store.applyReplicatedHashFieldDelete(event.key, event.deletedFields);
      } else if (event.kind === 'zsetMember' && event.key !== undefined) {
        if (event.setMembers?.length) this.deps.store.applyReplicatedZsetMemberSet(event.key, event.setMembers);
        if (event.deletedMembers?.length) this.deps.store.applyReplicatedZsetMemberDelete(event.key, event.deletedMembers);
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
      // Fast O(1) counters, not stats() — the heartbeat fires every ~10 s
      // and must not walk the whole keyspace (and, in HA, on every node) to
      // report a key breakdown.
      const keyCounts = this.deps.store.keyCounts();
      const topology = this.deps.pubsub.topology();
      const snapshot: NodeSnapshot = {
        nodeId: this.nodeId,
        lastHeartbeatMs: Date.now(),
        connectionCount: this.deps.connectionCount(),
        keyCounts,
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
