import type { Protover, RespValue } from './types.js';

const CRLF = '\r\n';

/**
 * Serializes a RespValue tree into wire bytes for the given protocol
 * version (RESP2 by default, matching every caller that predates HELLO 3
 * negotiation). Uses 'binary' (latin1) throughout, not 'utf8': RESP bulk
 * strings are binary-safe (arbitrary bytes — e.g. msgpack payloads from the
 * Socket.IO adapter), and latin1 maps each byte to one JS UTF-16 code unit
 * 1:1, so ASCII framing characters and opaque binary payloads both
 * round-trip losslessly through the same string. 'utf8' would corrupt any
 * byte sequence that isn't valid UTF-8 the moment it got encoded back to
 * bytes.
 */
export function serialize(value: RespValue, protover: Protover = 2): Buffer {
  return Buffer.from(serializeToString(value, protover), 'binary');
}

function serializeToString(value: RespValue, protover: Protover): string {
  switch (value.type) {
    case 'simple':
      return `+${value.value}${CRLF}`;
    case 'error':
      return `-${value.value}${CRLF}`;
    case 'integer':
      return `:${value.value}${CRLF}`;
    case 'bulk':
      if (value.value === null) return protover === 3 ? `_${CRLF}` : `$-1${CRLF}`;
      return `$${Buffer.byteLength(value.value, 'binary')}${CRLF}${value.value}${CRLF}`;
    case 'array':
      if (value.value === null) return protover === 3 ? `_${CRLF}` : `*-1${CRLF}`;
      return `*${value.value.length}${CRLF}` + value.value.map((v) => serializeToString(v, protover)).join('');
    case 'push':
      // RESP2 has no push type; a subscribed RESP2 client reads pub/sub
      // frames as plain arrays, which is exactly what this falls back to.
      return (
        `${protover === 3 ? '>' : '*'}${value.value.length}${CRLF}` +
        value.value.map((v) => serializeToString(v, protover)).join('')
      );
    case 'map': {
      if (protover === 3) {
        return (
          `%${value.value.length}${CRLF}` +
          value.value.map(([k, v]) => serializeToString(k, protover) + serializeToString(v, protover)).join('')
        );
      }
      // RESP2 has no map type; encode as a flat array (field, value, field, value, ...)
      // which is exactly what HGETALL and similar commands are expected to return.
      const flat = value.value.flatMap(([k, v]) => [k, v]);
      return `*${flat.length}${CRLF}` + flat.map((v) => serializeToString(v, protover)).join('');
    }
    default: {
      const _exhaustive: never = value;
      throw new Error(`unreachable: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
