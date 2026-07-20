export interface StringEntry {
  type: 'string';
  value: string;
  expiresAtMs: number | null;
  /**
   * Present only when the key is a distributed counter (touched by INCR in
   * HA mode): a grow-only G-counter mapping each origin node id to its
   * cumulative contribution. The effective integer value is the sum of all
   * contributions, and `value` is kept in sync as that sum's string form so
   * GET and every other read stay oblivious to this. Modelling INCR this way
   * — rather than replicating an absolute last-write-wins value — is what
   * makes concurrent cross-node increments converge on the true total
   * (commutative, reorder/duplicate/drop-safe) instead of undercounting
   * under contention. A reserved origin ('' — see SEED_ORIGIN) holds any
   * pre-existing base value a SET left before the first INCR, so the base
   * isn't attributed to (and double-counted across) real nodes.
   */
  contributions?: Map<string, number>;
}

export interface HashEntry {
  type: 'hash';
  fields: Map<string, string>;
  expiresAtMs: number | null;
}

export interface SortedSetEntry {
  type: 'sortedset';
  members: Map<string, number>;
  expiresAtMs: number | null;
}

export type Entry = StringEntry | HashEntry | SortedSetEntry;

export type EntryTypeName = Entry['type'];

/** Mirrors real Redis's WRONGTYPE error text so callers that branch on it behave the same. */
export class WrongTypeError extends Error {
  constructor() {
    super('WRONGTYPE Operation against a key holding the wrong kind of value');
  }
}

export class NotAnIntegerError extends Error {
  constructor() {
    super('ERR value is not an integer or out of range');
  }
}

/** Raised when a write would exceed the configured key/memory ceiling. Mirrors Redis's maxmemory rejection. */
export class OutOfMemoryError extends Error {
  constructor() {
    super("OOM command not allowed when used memory > 'maxmemory'.");
  }
}
