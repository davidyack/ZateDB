import type { ServerConfig } from '../config.js';
import { hasDurableStoreConfigured, hasReplicationTransportConfigured, isHaConfigured } from '../config.js';
import type { Store } from '../store/store.js';
import type { PubSubRegistry } from '../pubsub/registry.js';
import { ClusterCoordinator } from './clusterCoordinator.js';
import { NullDurableStore, type DurableStore } from './durableStore.js';
import { NullReplicationTransport, type ReplicationTransport } from './replicationTransport.js';
import { resolveNodeId } from './nodeId.js';

export interface ClusterCoordinatorHostDeps {
  store: Store;
  pubsub: PubSubRegistry;
  connectionCount(): number;
  commandsTotal(): number;
  /** Wired by the process owner (index.ts) to a fatal shutdown when replication dies unrecoverably. */
  onFatalReplicationError?: (err: Error) => void;
}

/**
 * Builds the ClusterCoordinator for this process: real Cosmos DB + Service
 * Bus implementations when both are configured (HA/multi-node mode), or
 * no-op standalone doubles otherwise (single-node, in-memory-only). A
 * partially-configured environment (only one
 * of the two set) is treated as a misconfiguration, not silently upgraded
 * or downgraded, since running with real persistence but no cross-node
 * sync (or vice versa) would silently violate the HA guarantee.
 */
export async function createClusterCoordinator(
  config: ServerConfig,
  deps: ClusterCoordinatorHostDeps,
): Promise<ClusterCoordinator> {
  const nodeId = config.nodeId || resolveNodeId();
  const haEnabled = isHaConfigured(config);

  const hasDurableStore = hasDurableStoreConfigured(config);
  const hasTransport = hasReplicationTransportConfigured(config);
  if (hasDurableStore !== hasTransport) {
    // Partial HA config is never intentional: exactly one of Cosmos DB /
    // Service Bus set means a typo'd env var or a missed secret. Silently
    // falling back to standalone at minReplicas >= 2 yields split-brain
    // (independent, non-replicating per-connection keyspaces), so crash
    // instead — the orchestrator retries with backoff and the misconfig is
    // loud rather than a subtly wrong runtime. This fires regardless of
    // REQUIRE_HA; there is no supported "durable but no cross-node sync"
    // (or vice-versa) mode to fall back to.
    throw new Error(
      'Partial HA configuration: exactly one of Cosmos DB and Service Bus is configured ' +
        `(Cosmos DB: ${hasDurableStore}, Service Bus: ${hasTransport}). ` +
        'Configure BOTH for HA (multi-node) mode, or NEITHER for standalone (single-node) mode.',
    );
  }

  // Split-brain guard. When REQUIRE_HA is set (the multi-replica Bicep sets
  // it), refuse to run standalone: at minReplicas >= 2, silently falling
  // back to standalone on a partial or missing HA config yields several
  // independent, non-replicating nodes behind one connection-spraying load
  // balancer — divergent per-connection keyspaces, the exact correctness
  // failure the single-replica invariant existed to prevent. Crash-looping
  // is strictly safer than serving that silently.
  if (config.requireHa && !haEnabled) {
    throw new Error(
      'REQUIRE_HA is set but high availability is not fully configured ' +
        `(Cosmos DB configured: ${hasDurableStore}, Service Bus configured: ${hasTransport}). ` +
        'Both COSMOS_CONNECTION_STRING/COSMOS_ENDPOINT and SERVICE_BUS_CONNECTION_STRING must be set, ' +
        'or unset REQUIRE_HA to allow standalone (single-node) mode.',
    );
  }

  let durable: DurableStore;
  let transport: ReplicationTransport;

  if (haEnabled) {
    const { CosmosDurableStore } = await import('./cosmosDurableStore.js');
    durable = await CosmosDurableStore.create({
      connectionString: config.cosmosConnectionString,
      endpoint: config.cosmosEndpoint,
      database: config.cosmosDatabase,
      keysContainer: config.cosmosKeysContainer,
      nodesContainer: config.cosmosNodesContainer,
    });
    const { ServiceBusReplicationTransport } = await import('./serviceBusTransport.js');
    transport = new ServiceBusReplicationTransport({
      connectionString: config.serviceBusConnectionString,
      fullyQualifiedNamespace: config.serviceBusFullyQualifiedNamespace,
      topicName: config.serviceBusTopicName,
      nodeId,
    });
  } else {
    durable = new NullDurableStore();
    transport = new NullReplicationTransport();
  }

  return new ClusterCoordinator({
    store: deps.store,
    pubsub: deps.pubsub,
    durable,
    transport,
    nodeId,
    haEnabled,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    nodeStaleMs: config.nodeStaleMs,
    maxMemoryBytes: config.maxMemoryBytes,
    antiEntropyIntervalMs: config.antiEntropyIntervalMs,
    durabilityMinTtlMs: config.durabilityMinTtlMs,
    heartbeatTopSubscriptions: config.heartbeatTopSubscriptions,
    onFatalReplicationError: deps.onFatalReplicationError,
    connectionCount: deps.connectionCount,
    commandsTotal: deps.commandsTotal,
  });
}
