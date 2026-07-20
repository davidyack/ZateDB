import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('zatedb');

/**
 * Metrics for the Lua scripting layer. `EVAL`/`EVALSHA` already get generic
 * command counters/latency via traceCommand; these capture the script-specific
 * signals that generic command metrics can't express.
 */
const evalshaTotal = meter.createCounter('zatedb.scripts.evalsha.total', {
  description: 'EVALSHA calls, dimensioned by whether the SHA was cached (hit) or missing (noscript)',
});
const scriptErrorsTotal = meter.createCounter('zatedb.scripts.errors.total', {
  description: 'Script failures, dimensioned by phase (compile/runtime)',
});

/**
 * A spike in `noscript` is operationally meaningful: the script cache is
 * in-memory and per-node, so it means a node restarted (cache lost) or an
 * EVALSHA landed on a node that never saw the SCRIPT LOAD. Clients recover by
 * re-sending EVAL, but the rate is worth watching.
 */
export function recordEvalsha(result: 'hit' | 'noscript'): void {
  evalshaTotal.add(1, { result });
}

export function recordScriptError(phase: 'compile' | 'runtime'): void {
  scriptErrorsTotal.add(1, { phase });
}

let cacheSizeGaugeRegistered = false;

/** Registers the script-cache-size gauge. Idempotent, mirroring registerReplicationQueueGauge. */
export function registerScriptCacheSizeGauge(getSize: () => number): void {
  if (cacheSizeGaugeRegistered) return;
  cacheSizeGaugeRegistered = true;
  const gauge = meter.createObservableGauge('zatedb.scripts.cache.size', {
    description: 'Number of Lua scripts held in this node\'s SHA1 script cache',
  });
  gauge.addCallback((result) => result.observe(getSize()));
}
