import type { Entry } from '../store/types.js';
import type { EntrySnapshot } from './types.js';

/** Converts a live Store entry (Map-based) to the JSON-safe shape persisted/broadcast. */
export function entryToSnapshot(entry: Entry): EntrySnapshot {
  if (entry.type === 'string') {
    return { type: 'string', value: entry.value, expiresAtMs: entry.expiresAtMs };
  }
  if (entry.type === 'hash') {
    return { type: 'hash', fields: Object.fromEntries(entry.fields), expiresAtMs: entry.expiresAtMs };
  }
  return { type: 'sortedset', members: Object.fromEntries(entry.members), expiresAtMs: entry.expiresAtMs };
}

/** Converts a JSON-safe snapshot back into a live Store entry (Map-based). */
export function snapshotToEntry(snapshot: EntrySnapshot): Entry {
  if (snapshot.type === 'string') {
    return { type: 'string', value: snapshot.value, expiresAtMs: snapshot.expiresAtMs };
  }
  if (snapshot.type === 'hash') {
    return { type: 'hash', fields: new Map(Object.entries(snapshot.fields)), expiresAtMs: snapshot.expiresAtMs };
  }
  return { type: 'sortedset', members: new Map(Object.entries(snapshot.members)), expiresAtMs: snapshot.expiresAtMs };
}
