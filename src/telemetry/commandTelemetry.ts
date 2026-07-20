import { createHash } from 'node:crypto';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import type { DispatchOutcome } from '../commands/dispatcher.js';
import type { Store } from '../store/store.js';

const tracer = trace.getTracer('backendcache');
const meter = metrics.getMeter('backendcache');

const commandsTotal = meter.createCounter('backendcache.commands.total', {
  description: 'Total commands processed, by command and result',
});
const commandsDurationMs = meter.createHistogram('backendcache.commands.duration_ms', {
  description: 'Command execution latency in milliseconds',
});
const connectionsActive = meter.createUpDownCounter('backendcache.connections.active', {
  description: 'Currently open RESP connections',
});
const pubsubSubscriptionsActive = meter.createUpDownCounter('backendcache.pubsub.subscriptions.active', {
  description: 'Currently active pub/sub subscriptions',
});
const adminActionsTotal = meter.createCounter('backendcache.admin.actions.total', {
  description: 'Admin API actions, by action and result',
});
const keysGauge = meter.createObservableGauge('backendcache.keys.count', {
  description: 'Live keys held in this node\'s in-memory store, by type',
});

let keyCountsSource: (() => ReturnType<Store['keyCounts']>) | null = null;

/**
 * Wires the key-count gauge to a live Store. Called once at startup
 * (index.ts) — kept as a lazily-bound callback rather than a constructor
 * dependency so this module (imported by command handlers before the
 * Store exists) doesn't need to know about wiring order. Reads the store's
 * O(1) `keyCounts()` counter, not `stats()` (which walks the whole keyspace)
 * — this fires on every metric scrape, so it must not be O(keyspace).
 */
export function bindKeyCountsSource(getKeyCounts: () => ReturnType<Store['keyCounts']>): void {
  keyCountsSource = getKeyCounts;
  keysGauge.addCallback((result) => {
    const keyCounts = keyCountsSource?.();
    if (!keyCounts) return;
    for (const [type, count] of Object.entries(keyCounts)) {
      result.observe(count, { type });
    }
  });
}

/**
 * Redacts a key before it lands in a span attribute. Key names in this
 * service can embed identifying data (e.g. an email address or workspace
 * id baked into a cache key), so span attributes get a stable, non-reversible
 * fingerprint instead of the raw value: first 8 chars + a short hash suffix.
 */
export function redactKey(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  const prefix = key.slice(0, 8);
  return `${prefix}…#${hash}`;
}

let totalCommandsProcessed = 0;

/** Cheap running total for the admin /stats endpoint — not a substitute for the OTel counter. */
export function getCommandsProcessedTotal(): number {
  return totalCommandsProcessed;
}

export function traceCommand<T extends DispatchOutcome>(
  command: string,
  connectionId: string,
  keyArg: string | undefined,
  fn: () => T,
): T {
  const start = performance.now();
  return tracer.startActiveSpan(`backendcache.command.${command || 'UNKNOWN'}`, (span) => {
    span.setAttribute('db.system', 'backendcache');
    span.setAttribute('db.operation', command);
    span.setAttribute('backendcache.connection_id', connectionId);
    if (keyArg !== undefined) span.setAttribute('backendcache.key', redactKey(keyArg));

    let outcome: T;
    try {
      totalCommandsProcessed++;
      outcome = fn();
      const resultLabel = outcome.isError ? 'error' : 'success';
      span.setAttribute('backendcache.result', resultLabel);
      if (outcome.isError) span.setStatus({ code: SpanStatusCode.ERROR });
      commandsTotal.add(1, { command, result: resultLabel });
      return outcome;
    } catch (err) {
      span.setAttribute('backendcache.result', 'error');
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      commandsTotal.add(1, { command, result: 'error' });
      throw err;
    } finally {
      commandsDurationMs.record(performance.now() - start, { command });
      span.end();
    }
  });
}

export function recordConnectionOpened(): void {
  connectionsActive.add(1);
}

export function recordConnectionClosed(): void {
  connectionsActive.add(-1);
}

export function recordSubscriptionChange(kind: 'channel' | 'pattern', delta: number): void {
  pubsubSubscriptionsActive.add(delta, { type: kind });
}

export function recordAdminAction(action: string, resultLabel: 'success' | 'error'): void {
  adminActionsTotal.add(1, { action, result: resultLabel });
}

/**
 * Connection open/close happen outside any command's span (a connection
 * can sit open for a long time before its first command, and a Socket.IO
 * adapter subscriber connection can live for the process's entire
 * lifetime — see docs/architecture.md on why there's no per-connection
 * span). Each lifecycle transition instead gets its own near-zero-duration
 * span carrying one event: the idiomatic OTel shape for a bounded moment
 * with no natural parent span to attach to.
 */
export function recordConnectionLifecycleEvent(name: string, attributes: Attributes): void {
  const span = tracer.startSpan(`backendcache.${name}`);
  span.addEvent(name, attributes);
  span.end();
}

/**
 * Subscribe/unsubscribe happen inside the SUBSCRIBE/UNSUBSCRIBE command's
 * own span (traceCommand's startActiveSpan makes it the active span for
 * the duration of the handler call), so this attaches an event to that
 * span rather than creating a new one.
 */
export function recordSubscriptionLifecycleEvent(name: string, attributes: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}
