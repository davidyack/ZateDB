import { createHash } from 'node:crypto';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import type { DispatchOutcome } from '../commands/dispatcher.js';

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
