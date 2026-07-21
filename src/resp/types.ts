/** RESP protocol version negotiated per-connection via HELLO. Defaults to 2. */
export type Protover = 2 | 3;

export type RespValue =
  | { type: 'simple'; value: string }
  | { type: 'error'; value: string }
  | { type: 'integer'; value: number }
  | { type: 'bulk'; value: string | null }
  | { type: 'array'; value: RespValue[] | null }
  | { type: 'map'; value: Array<[RespValue, RespValue]> }
  /**
   * Out-of-band frames (pub/sub messages and subscribe/unsubscribe
   * confirmations). RESP3 has a dedicated `>` push type for these; RESP2
   * has none, so it falls back to a plain array — see serializer.ts.
   */
  | { type: 'push'; value: RespValue[] };

export const OK: RespValue = { type: 'simple', value: 'OK' };
export const NIL: RespValue = { type: 'bulk', value: null };
export const NIL_ARRAY: RespValue = { type: 'array', value: null };

export function simple(value: string): RespValue {
  return { type: 'simple', value };
}

export function error(value: string): RespValue {
  return { type: 'error', value };
}

export function integer(value: number): RespValue {
  return { type: 'integer', value };
}

export function bulk(value: string | null): RespValue {
  return { type: 'bulk', value };
}

export function array(value: RespValue[] | null): RespValue {
  return { type: 'array', value };
}

export function bulkArray(values: string[]): RespValue {
  return { type: 'array', value: values.map((v) => bulk(v)) };
}

export function push(value: RespValue[]): RespValue {
  return { type: 'push', value };
}

/** Errors thrown by the RESP frame reader for malformed input on the wire. */
export class RespProtocolError extends Error {}
