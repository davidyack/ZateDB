import { RespProtocolError } from './types.js';

/**
 * Incremental RESP2 request parser. Clients (node-redis, etc.) send commands
 * as RESP arrays of bulk strings ("*<n>\r\n$<len>\r\n<bytes>\r\n..."). Some
 * clients / manual tools also send inline commands (a bare line, no framing).
 * feed() may be called with partial TCP chunks; parsed commands are only
 * emitted once a full frame has arrived.
 */
export class RespRequestParser {
  private buffer: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): string[][] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const commands: string[][] = [];

    for (;;) {
      const result = this.tryParseOne();
      if (result === null) break;
      const [command, rest] = result;
      if (command.length > 0) commands.push(command);
      this.buffer = rest;
    }

    return commands;
  }

  private tryParseOne(): [string[], Buffer] | null {
    if (this.buffer.length === 0) return null;

    if (this.buffer[0] === 0x2a /* '*' */) {
      return this.tryParseArray(this.buffer);
    }
    return this.tryParseInline(this.buffer);
  }

  private tryParseInline(buf: Buffer): [string[], Buffer] | null {
    const idx = buf.indexOf('\r\n');
    if (idx === -1) {
      if (buf.length > 64 * 1024) {
        throw new RespProtocolError('inline request too large');
      }
      return null;
    }
    const line = buf.subarray(0, idx).toString('binary');
    const rest = buf.subarray(idx + 2);
    const parts = line.split(' ').filter((p) => p.length > 0);
    return [parts, rest];
  }

  private tryParseArray(buf: Buffer): [string[], Buffer] | null {
    const header = readLine(buf, 0);
    if (header === null) return null;
    const [headerLine, afterHeader] = header;
    const count = parseInt(headerLine.subarray(1).toString('ascii'), 10);
    if (Number.isNaN(count)) {
      throw new RespProtocolError(`invalid multibulk length`);
    }
    if (count < 0) {
      return [[], buf.subarray(afterHeader)];
    }

    let offset = afterHeader;
    const parts: string[] = [];

    for (let i = 0; i < count; i++) {
      if (offset >= buf.length) return null;
      if (buf[offset] !== 0x24 /* '$' */) {
        throw new RespProtocolError(`expected '$', got '${String.fromCharCode(buf[offset])}'`);
      }
      const bulkHeader = readLine(buf, offset);
      if (bulkHeader === null) return null;
      const [bulkHeaderLine, afterBulkHeader] = bulkHeader;
      const len = parseInt(bulkHeaderLine.subarray(1).toString('ascii'), 10);
      if (Number.isNaN(len) || len < 0) {
        throw new RespProtocolError('invalid bulk length');
      }
      const dataEnd = afterBulkHeader + len;
      if (dataEnd + 2 > buf.length) return null;
      // RESP bulk strings are binary-safe (arbitrary bytes, not necessarily
      // valid UTF-8 — e.g. msgpack-encoded payloads from the Socket.IO
      // adapter). 'binary' (latin1) maps each byte to one JS UTF-16 code
      // unit 1:1, so it round-trips losslessly; 'utf8' would corrupt any
      // byte sequence that isn't valid UTF-8.
      const value = buf.subarray(afterBulkHeader, dataEnd).toString('binary');
      parts.push(value);
      offset = dataEnd + 2;
    }

    return [parts, buf.subarray(offset)];
  }
}

/** Returns [lineIncludingPrefix, offsetAfterCRLF] or null if incomplete. */
function readLine(buf: Buffer, start: number): [Buffer, number] | null {
  const idx = buf.indexOf('\r\n', start);
  if (idx === -1) return null;
  return [buf.subarray(start, idx), idx + 2];
}
