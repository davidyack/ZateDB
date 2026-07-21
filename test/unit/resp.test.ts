import { describe, expect, it } from 'vitest';
import { RespRequestParser } from '../../src/resp/parser.js';
import { serialize } from '../../src/resp/serializer.js';
import { array, bulk, bulkArray, error, integer, NIL, OK, push, simple } from '../../src/resp/types.js';

describe('RespRequestParser', () => {
  it('parses a single multibulk command', () => {
    const parser = new RespRequestParser();
    const commands = parser.feed(Buffer.from('*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n'));
    expect(commands).toEqual([['GET', 'foo']]);
  });

  it('parses multiple commands arriving in one chunk', () => {
    const parser = new RespRequestParser();
    const commands = parser.feed(Buffer.from('*1\r\n$4\r\nPING\r\n*1\r\n$4\r\nPING\r\n'));
    expect(commands).toEqual([['PING'], ['PING']]);
  });

  it('handles a command split across multiple TCP chunks', () => {
    const parser = new RespRequestParser();
    const full = '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n';
    const mid = Math.floor(full.length / 2);
    const first = parser.feed(Buffer.from(full.slice(0, mid)));
    expect(first).toEqual([]);
    const second = parser.feed(Buffer.from(full.slice(mid)));
    expect(second).toEqual([['SET', 'foo', 'bar']]);
  });

  it('handles a bulk string split mid-payload', () => {
    const parser = new RespRequestParser();
    const full = '*2\r\n$3\r\nGET\r\n$10\r\nabcdefghij\r\n';
    let commands: string[][] = [];
    for (const chunk of chunkString(full, 5)) {
      commands = commands.concat(parser.feed(Buffer.from(chunk)));
    }
    expect(commands).toEqual([['GET', 'abcdefghij']]);
  });

  it('parses inline commands', () => {
    const parser = new RespRequestParser();
    const commands = parser.feed(Buffer.from('PING\r\n'));
    expect(commands).toEqual([['PING']]);
  });

  it('preserves bulk strings containing embedded CRLF-looking bytes within declared length', () => {
    const parser = new RespRequestParser();
    const value = 'has\r\nnewline';
    const commands = parser.feed(Buffer.from(`*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(value)}\r\n${value}\r\n`));
    expect(commands).toEqual([['GET', value]]);
  });

  it('rejects a declared bulk length over the configured cap without buffering it', () => {
    const parser = new RespRequestParser({ maxBulkBytes: 16 });
    // Header alone declares 1 GiB; the parser must reject on the header, not
    // wait to buffer the payload.
    expect(() => parser.feed(Buffer.from('*1\r\n$1073741824\r\n'))).toThrow(/bulk length exceeds limit/);
  });

  it('rejects when pending unparsed bytes exceed the buffer cap', () => {
    const parser = new RespRequestParser({ maxBufferBytes: 32 });
    // An array header promising a bulk that never arrives; bytes accumulate.
    const partial = Buffer.concat([Buffer.from('*2\r\n$3\r\nGET\r\n$50\r\n'), Buffer.alloc(40, 0x61)]);
    expect(() => parser.feed(partial)).toThrow(/request buffer exceeds limit/);
  });

  it('still accepts frames under the caps', () => {
    const parser = new RespRequestParser({ maxBulkBytes: 1024, maxBufferBytes: 4096 });
    expect(parser.feed(Buffer.from('*1\r\n$4\r\nPING\r\n'))).toEqual([['PING']]);
  });
});

describe('serialize', () => {
  it('serializes simple strings', () => {
    expect(serialize(simple('PONG')).toString()).toBe('+PONG\r\n');
  });

  it('serializes OK', () => {
    expect(serialize(OK).toString()).toBe('+OK\r\n');
  });

  it('serializes errors', () => {
    expect(serialize(error('ERR boom')).toString()).toBe('-ERR boom\r\n');
  });

  it('serializes integers', () => {
    expect(serialize(integer(42)).toString()).toBe(':42\r\n');
  });

  it('serializes bulk strings', () => {
    expect(serialize(bulk('hello')).toString()).toBe('$5\r\nhello\r\n');
  });

  it('serializes nil bulk as $-1', () => {
    expect(serialize(NIL).toString()).toBe('$-1\r\n');
  });

  it('serializes arrays', () => {
    expect(serialize(bulkArray(['a', 'b'])).toString()).toBe('*2\r\n$1\r\na\r\n$1\r\nb\r\n');
  });

  it('serializes nil array as *-1', () => {
    expect(serialize(array(null)).toString()).toBe('*-1\r\n');
  });

  it('serializes maps as flat arrays (RESP2 has no map type)', () => {
    const frame = serialize({ type: 'map', value: [[bulk('field'), bulk('value')]] });
    expect(frame.toString()).toBe('*2\r\n$5\r\nfield\r\n$5\r\nvalue\r\n');
  });

  it('serializes push frames as plain arrays under RESP2', () => {
    const frame = serialize(push([bulk('message'), bulk('chan'), bulk('hi')]));
    expect(frame.toString()).toBe('*3\r\n$7\r\nmessage\r\n$4\r\nchan\r\n$2\r\nhi\r\n');
  });
});

describe('serialize (RESP3, protover 3)', () => {
  it('serializes nil bulk as the unified null type', () => {
    expect(serialize(NIL, 3).toString()).toBe('_\r\n');
  });

  it('serializes nil array as the unified null type', () => {
    expect(serialize(array(null), 3).toString()).toBe('_\r\n');
  });

  it('leaves non-null bulk/array/simple/error/integer frames unchanged from RESP2', () => {
    expect(serialize(bulk('hello'), 3).toString()).toBe('$5\r\nhello\r\n');
    expect(serialize(bulkArray(['a', 'b']), 3).toString()).toBe('*2\r\n$1\r\na\r\n$1\r\nb\r\n');
    expect(serialize(simple('PONG'), 3).toString()).toBe('+PONG\r\n');
    expect(serialize(error('ERR boom'), 3).toString()).toBe('-ERR boom\r\n');
    expect(serialize(integer(42), 3).toString()).toBe(':42\r\n');
  });

  it('serializes maps as a real RESP3 map, not a flattened array', () => {
    const frame = serialize({ type: 'map', value: [[bulk('field'), bulk('value')]] }, 3);
    expect(frame.toString()).toBe('%1\r\n$5\r\nfield\r\n$5\r\nvalue\r\n');
  });

  it('serializes push frames with the > marker', () => {
    const frame = serialize(push([bulk('message'), bulk('chan'), bulk('hi')]), 3);
    expect(frame.toString()).toBe('>3\r\n$7\r\nmessage\r\n$4\r\nchan\r\n$2\r\nhi\r\n');
  });

  it('propagates protover into nested values', () => {
    const frame = serialize(push([bulk('pmessage'), NIL, array(null)]), 3);
    expect(frame.toString()).toBe('>3\r\n$8\r\npmessage\r\n_\r\n_\r\n');
  });
});

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
