export interface StringEntry {
  type: 'string';
  value: string;
  expiresAtMs: number | null;
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
