import { describe, expect, it } from 'vitest';
import { RespRequestParser } from '../../src/resp/parser.js';
import { serialize } from '../../src/resp/serializer.js';
import { array, bulk, bulkArray, error, integer, NIL, OK, simple } from '../../src/resp/types.js';

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
});

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
