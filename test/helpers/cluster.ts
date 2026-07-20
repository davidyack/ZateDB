import type { Store } from '../../src/store/store.js';
import type { PubSubRegistry } from '../../src/pubsub/registry.js';
import { ClusterCoordinator } from '../../src/cluster/clusterCoordinator.js';
import { NullDurableStore } from '../../src/cluster/durableStore.js';
import { NullReplicationTransport } from '../../src/cluster/replicationTransport.js';

/** A standalone (single-node, HA disabled) ClusterCoordinator for tests that don't exercise cluster behavior. */
export function standaloneCluster(store: Store, pubsub: PubSubRegistry): ClusterCoordinator {
  return new ClusterCoordinator({
    store,
    pubsub,
    durable: new NullDurableStore(),
    transport: new NullReplicationTransport(),
    nodeId: 'test-node',
    haEnabled: false,
    heartbeatIntervalMs: 0,
    nodeStaleMs: 0,
    connectionCount: () => 0,
    commandsTotal: () => 0,
  });
}
