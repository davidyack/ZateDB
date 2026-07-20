import { describe, expect, it } from 'vitest';
import { validateReplicationEvent } from '../../src/cluster/types.js';
import type { ReplicationEvent } from '../../src/cluster/types.js';

const base = { originNodeId: 'node-a', seq: 1, timestampMs: 1_700_000_000_000 };

function ev(partial: Record<string, unknown>): unknown {
  return { ...base, ...partial };
}

describe('validateReplicationEvent', () => {
  it('accepts each well-formed event kind', () => {
    const valid: unknown[] = [
      ev({ kind: 'upsert', key: 'k', entry: { type: 'string', value: 'v', expiresAtMs: null } }),
      ev({ kind: 'upsert', key: 'c', entry: { type: 'string', value: '3', expiresAtMs: null, contributions: { 'node-a': 3 } } }),
      ev({ kind: 'delete', key: 'k' }),
      ev({ kind: 'ttl', key: 'k', expiresAtMs: 123 }),
      ev({ kind: 'ttl', key: 'k', expiresAtMs: null }),
      ev({ kind: 'increment', key: 'c', contributionTotal: 5 }),
      ev({ kind: 'publish', channel: 'room', message: 'hi' }),
      ev({ kind: 'hashField', key: 'h', setFields: [['f', 'v']], deletedFields: ['g'] }),
      ev({ kind: 'zsetMember', key: 'z', setMembers: [['m', 1.5]], deletedMembers: ['n'] }),
    ];
    for (const e of valid) expect(validateReplicationEvent(e)).not.toBeNull();
  });

  it('rejects non-objects and missing envelope fields', () => {
    expect(validateReplicationEvent(null)).toBeNull();
    expect(validateReplicationEvent('nope')).toBeNull();
    expect(validateReplicationEvent({ kind: 'delete', key: 'k' })).toBeNull(); // no originNodeId/seq/timestamp
    expect(validateReplicationEvent(ev({ kind: 'delete' }))).toBeNull(); // missing key
  });

  it('rejects unknown kinds', () => {
    expect(validateReplicationEvent(ev({ kind: 'evil', key: 'k' }))).toBeNull();
    expect(validateReplicationEvent(ev({ kind: 'upsert', key: 'k', entry: { type: 'bogus' } }))).toBeNull();
  });

  it('rejects wrong field types', () => {
    expect(validateReplicationEvent(ev({ kind: 'increment', key: 'c', contributionTotal: 'lots' }))).toBeNull();
    expect(validateReplicationEvent(ev({ kind: 'increment', key: 'c', contributionTotal: Infinity }))).toBeNull();
    expect(validateReplicationEvent(ev({ kind: 'hashField', key: 'h', setFields: [['f', 5]] }))).toBeNull(); // value not a string
    expect(validateReplicationEvent(ev({ kind: 'zsetMember', key: 'z', setMembers: [['m', 'x']] }))).toBeNull(); // score not a number
    expect(validateReplicationEvent(ev({ kind: 'upsert', key: 'h', entry: { type: 'hash', fields: { f: 9 }, expiresAtMs: null } }))).toBeNull();
  });

  it('rejects oversized arrays', () => {
    const huge = Array.from({ length: 1_000_001 }, (_, i) => [`f${i}`, 'v'] as [string, string]);
    expect(validateReplicationEvent(ev({ kind: 'hashField', key: 'h', setFields: huge }))).toBeNull();
  });

  it('returns the same object reference on success (no copy)', () => {
    const e = ev({ kind: 'delete', key: 'k' });
    expect(validateReplicationEvent(e)).toBe(e as ReplicationEvent);
  });
});
