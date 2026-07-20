import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('backendcache');

/**
 * Cost telemetry for the HA layer. Cosmos request units (RU) are the
 * dominant marginal cost of this architecture, and until now every SDK
 * response's `requestCharge` was discarded — the whole cost model was
 * estimated, not observed. These meters turn capacity-mode and threshold
 * decisions (persistence exemption, write cadence) into arithmetic on real
 * data. See docs/high-availability.md#cost.
 */
const cosmosRequestUnits = meter.createCounter('backendcache.cosmos.request_units', {
  description: 'Cosmos DB request units consumed, dimensioned by operation (upsert/patch/query/delete)',
});
const serviceBusPublishes = meter.createCounter('backendcache.servicebus.publishes', {
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
  const gauge = meter.createObservableGauge('backendcache.replication.queue_depth', {
    description: 'Pending + in-flight replication tasks awaiting Cosmos/Service Bus',
  });
  gauge.addCallback((result) => result.observe(getDepth()));
}
