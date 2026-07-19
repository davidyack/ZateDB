import type { RespValue } from './types.js';

const CRLF = '\r\n';

/**
 * Serializes a RespValue tree into RESP2 wire bytes. Uses 'binary' (latin1)
 * throughout, not 'utf8': RESP bulk strings are binary-safe (arbitrary
 * bytes — e.g. msgpack payloads from the Socket.IO adapter), and latin1
 * maps each byte to one JS UTF-16 code unit 1:1, so ASCII framing
 * characters and opaque binary payloads both round-trip losslessly through
 * the same string. 'utf8' would corrupt any byte sequence that isn't valid
 * UTF-8 the moment it got encoded back to bytes.
 */
export function serialize(value: RespValue): Buffer {
  return Buffer.from(serializeToString(value), 'binary');
}

function serializeToString(value: RespValue): string {
  switch (value.type) {
    case 'simple':
      return `+${value.value}${CRLF}`;
    case 'error':
      return `-${value.value}${CRLF}`;
    case 'integer':
      return `:${value.value}${CRLF}`;
    case 'bulk':
      if (value.value === null) return `$-1${CRLF}`;
      return `$${Buffer.byteLength(value.value, 'binary')}${CRLF}${value.value}${CRLF}`;
    case 'array':
      if (value.value === null) return `*-1${CRLF}`;
      return `*${value.value.length}${CRLF}` + value.value.map(serializeToString).join('');
    case 'map': {
      // RESP2 has no map type; encode as a flat array (field, value, field, value, ...)
      // which is exactly what HGETALL and similar commands are expected to return.
      const flat = value.value.flatMap(([k, v]) => [k, v]);
      return `*${flat.length}${CRLF}` + flat.map(serializeToString).join('');
    }
    default: {
      const _exhaustive: never = value;
      throw new Error(`unreachable: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
