import { monitorEventLoopDelay } from 'node:perf_hooks';
import { metrics } from '@opentelemetry/api';
import type { Store } from '../store/store.js';
import type { RespServer } from '../server/respServer.js';

const meter = metrics.getMeter('backendcache');

/**
 * Registers the saturation gauges that predict the failure modes the resource
 * bounds guard against — event-loop lag (the leading indicator of a fan-out or
 * sweep stall), process RSS/heap, estimated keyspace bytes, and live
 * connections. The throughput counters alone can't tell you you're about to
 * fall over; these can. Returns a disposer that stops the event-loop monitor.
 */
export function initSaturationMetrics(store: Store, respServer: RespServer): () => void {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  const rss = meter.createObservableGauge('backendcache.process.memory.rss_bytes', {
    description: 'Resident set size in bytes',
  });
  const heapUsed = meter.createObservableGauge('backendcache.process.memory.heap_used_bytes', {
    description: 'V8 heap used in bytes',
  });
  const storeBytes = meter.createObservableGauge('backendcache.store.memory_estimate_bytes', {
    description: 'Estimated keyspace size in bytes',
  });
  const connections = meter.createObservableGauge('backendcache.connections.count', {
    description: 'Currently open RESP connections',
  });
  const loopLagP99 = meter.createObservableGauge('backendcache.event_loop.lag_p99_ms', {
    description: 'Event-loop delay p99 in ms over the last scrape window',
  });

  rss.addCallback((r) => r.observe(process.memoryUsage().rss));
  heapUsed.addCallback((r) => r.observe(process.memoryUsage().heapUsed));
  storeBytes.addCallback((r) => r.observe(store.stats().memoryEstimateBytes));
  connections.addCallback((r) => r.observe(respServer.activeConnectionCount()));
  loopLagP99.addCallback((r) => {
    r.observe(loopDelay.percentile(99) / 1e6); // nanoseconds -> ms
    loopDelay.reset(); // rolling window between scrapes
  });

  return () => {
    loopDelay.disable();
  };
}
