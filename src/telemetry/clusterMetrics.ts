import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('zatedb');

/**
 * Cost telemetry for the HA layer. Cosmos request units (RU) are the
 * dominant marginal cost of this architecture, and until now every SDK
 * response's `requestCharge` was discarded — the whole cost model was
 * estimated, not observed. These meters turn capacity-mode and threshold
 * decisions (persistence exemption, write cadence) into arithmetic on real
 * data. See docs/high-availability.md#cost.
 */
const cosmosRequestUnits = meter.createCounter('zatedb.cosmos.request_units', {
  description: 'Cosmos DB request units consumed, dimensioned by operation (upsert/patch/query/delete)',
});
const serviceBusPublishes = meter.createCounter('zatedb.servicebus.publishes', {
  description: 'Replication events published to the Service Bus topic',
});

export type CosmosOp = 'upsert' | 'patch' | 'query' | 'delete';

/** Records the RU charge of one Cosmos call. A no-op when the charge is unknown/zero, so callers can pass through blindly. */
export function recordCosmosRequestUnits(operation: CosmosOp, requestCharge: number | undefined): void {
  if (typeof requestCharge === 'number' && requestCharge > 0) {
    cosmosRequestUnits.add(requestCharge, { operation });
  }
}

export function recordServiceBusPublish(): void {
  serviceBusPublishes.add(1);
}

let queueGaugeRegistered = false;

/**
 * Registers the replication-queue-depth gauge (pending + in-flight
 * replication tasks) — the queue is where back-pressure accumulates
 * invisibly under write bursts or a slow Cosmos. Idempotent: only the first
 * registration's source is wired, so repeated calls (e.g. across tests)
 * don't stack callbacks.
 */
export function registerReplicationQueueGauge(getDepth: () => number): void {
  if (queueGaugeRegistered) return;
  queueGaugeRegistered = true;
  const gauge = meter.createObservableGauge('zatedb.replication.queue_depth', {
    description: 'Pending + in-flight replication tasks awaiting Cosmos/Service Bus',
  });
  gauge.addCallback((result) => result.observe(getDepth()));
}

let haGaugeRegistered = false;

/**
 * Registers the HA-enabled gauge: 1 when this node replicates over
 * Cosmos+Service Bus, 0 when it runs standalone. The single most useful
 * split-brain signal — a node genuinely can't detect sibling replicas without
 * a shared backend, so alert on `ha_enabled == 0` joined with the platform's
 * own replica-count metric (e.g. Container Apps `Replicas`): >1 replica while
 * this reads 0 is the divergent-per-connection-keyspace failure. Idempotent.
 */
export function registerClusterHealthGauge(getHaEnabled: () => boolean): void {
  if (haGaugeRegistered) return;
  haGaugeRegistered = true;
  const gauge = meter.createObservableGauge('zatedb.cluster.ha_enabled', {
    description: '1 when HA replication (Cosmos+Service Bus) is active, 0 when standalone/single-node',
  });
  gauge.addCallback((result) => result.observe(getHaEnabled() ? 1 : 0));
}
