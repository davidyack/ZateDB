import type { Entry } from '../store/types.js';
import type { FloatContribution } from '../store/types.js';
import type { EntrySnapshot, FloatContributionTuple } from './types.js';
import { formatRedisFloat, sumFloatContributions } from '../store/floatCounter.js';

/** Converts a live Store entry (Map-based) to the JSON-safe shape persisted/broadcast. */
export function entryToSnapshot(entry: Entry): EntrySnapshot {
  if (entry.type === 'string') {
    return {
      type: 'string',
      value: entry.value,
      expiresAtMs: entry.expiresAtMs,
      ...(entry.contributions ? { contributions: Object.fromEntries(entry.contributions) } : {}),
    };
  }
  if (entry.type === 'hash') {
    const snapshot: EntrySnapshot = { type: 'hash', fields: Object.fromEntries(entry.fields), expiresAtMs: entry.expiresAtMs };
    if (entry.counters) {
      snapshot.counters = Object.fromEntries(
        [...entry.counters].map(([field, contributions]) => [
          field,
          Object.fromEntries([...contributions].map(([origin, c]): [string, FloatContributionTuple] => [origin, [c.p, c.n]])),
        ]),
      );
    }
    return snapshot;
  }
  return { type: 'sortedset', members: Object.fromEntries(entry.members), expiresAtMs: entry.expiresAtMs };
}

/** Converts a JSON-safe snapshot back into a live Store entry (Map-based). */
export function snapshotToEntry(snapshot: EntrySnapshot): Entry {
  if (snapshot.type === 'string') {
    if (snapshot.contributions) {
      const contributions = new Map(Object.entries(snapshot.contributions));
      // Recompute value from the contributions so the durable `value` field
      // (which lags the per-origin patches) can never disagree with the sum.
      let total = 0;
      for (const n of contributions.values()) total += n;
      return { type: 'string', value: String(total), expiresAtMs: snapshot.expiresAtMs, contributions };
    }
    return { type: 'string', value: snapshot.value, expiresAtMs: snapshot.expiresAtMs };
  }
  if (snapshot.type === 'hash') {
    const fields = new Map(Object.entries(snapshot.fields));
    if (!snapshot.counters) return { type: 'hash', fields, expiresAtMs: snapshot.expiresAtMs };
    const counters = new Map<string, Map<string, FloatContribution>>();
    for (const [field, byOrigin] of Object.entries(snapshot.counters)) {
      // Counter state for a field that's no longer in the hash is a leftover
      // of an HDEL (the field was removed, its counter patch path wasn't) —
      // ignore it rather than resurrect the field.
      if (!fields.has(field)) continue;
      const contributions = new Map(Object.entries(byOrigin).map(([origin, [p, n]]): [string, FloatContribution] => [origin, { p, n }]));
      counters.set(field, contributions);
      // Recompute from the contributions, like string counters above: the
      // durable field value is written by whichever origin patched last and
      // can lag the per-origin contribution patches.
      fields.set(field, formatRedisFloat(sumFloatContributions(contributions)));
    }
    return { type: 'hash', fields, expiresAtMs: snapshot.expiresAtMs, ...(counters.size > 0 ? { counters } : {}) };
  }
  return { type: 'sortedset', members: new Map(Object.entries(snapshot.members)), expiresAtMs: snapshot.expiresAtMs };
}
