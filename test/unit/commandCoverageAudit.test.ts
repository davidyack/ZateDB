import { describe, expect, it } from 'vitest';
import { auditSources } from '../../scripts/commandCoverageAudit.js';
import { COMMANDS } from '../../src/commands/dispatcher.js';
import { IMPLEMENTED_COMMANDS, isScriptCallableCommand } from '../../src/commands/commandNames.js';

function audit(source: string) {
  return auditSources([{ file: 'app.ts', source }]);
}

describe('commandNames', () => {
  it('lists exactly the commands the dispatcher serves', () => {
    expect([...IMPLEMENTED_COMMANDS].sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it('keeps connection and scripting commands out of scripts', () => {
    expect(isScriptCallableCommand('zadd')).toBe(true);
    expect(isScriptCallableCommand('EVAL')).toBe(false);
    expect(isScriptCallableCommand('ZCARD')).toBe(false);
  });
});

describe('command coverage audit — client call sites', () => {
  it('flags an unimplemented client method', () => {
    const report = audit(`
      const client = await getRedisClient();
      await client.zCard('k');
      await client.get('k');
    `);
    expect(report.clientFailures).toEqual([{ file: 'app.ts', line: 3, command: 'ZCARD' }]);
    expect(report.clientSites.map((s) => s.command)).toEqual(['ZCARD', 'GET']);
  });

  it('flags zAdd with an options argument', () => {
    const report = audit(`
      const client = await getRedisClient();
      await client.zAdd('k', [{ score: 1, value: 'm' }], { condition: 'XX' });
      await client.zAdd('k', [{ score: 1, value: 'm' }]);
    `);
    expect(report.clientFailures).toHaveLength(1);
    expect(report.clientFailures[0]).toMatchObject({ line: 3, command: 'ZADD' });
  });
});

describe('command coverage audit — Lua scripts', () => {
  it('finds commands in a script held in a module constant', () => {
    const report = audit(`
const ACQUIRE = \`
local n = redis.call('ZCARD', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
\`
export async function acquire(client) { return client.eval(ACQUIRE, { keys: ['k'], arguments: ['1'] }) }
`);
    expect(report.scriptSites.map((s) => [s.command, s.line, s.kind])).toEqual([
      ['ZCARD', 3, 'unknown-command'],
      ['PEXPIRE', 4, 'ok'],
    ]);
    expect(report.scriptFailures.map((s) => s.command)).toEqual(['ZCARD']);
  });

  it('finds commands in a script passed inline to eval', () => {
    const report = audit(`
      await client.eval("return redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])", { keys: ['k'], arguments: ['1.5'] });
    `);
    expect(report.scriptFailures).toEqual([
      { file: 'app.ts', line: 2, via: 'redis.call', command: 'INCRBYFLOAT', kind: 'unknown-command' },
    ]);
  });

  it('checks redis.pcall too, with any quoting and casing', () => {
    const report = audit(`const S = 'local r = redis.pcall("llen", KEYS[1]); redis.pcall(\\'hset\\', KEYS[1], "f", "v")'`);
    expect(report.scriptSites.map((s) => [s.via, s.command, s.kind])).toEqual([
      ['redis.pcall', 'LLEN', 'unknown-command'],
      ['redis.pcall', 'HSET', 'ok'],
    ]);
  });

  it('passes a script that only uses supported commands', () => {
    const report = audit(`
const S = \`
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCOUNT', KEYS[1], '-inf', '+inf') >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('SET', KEYS[2], ARGV[1], 'PX', 5000, 'NX')
return redis.call('HMGET', KEYS[3], 'a', 'b')
\`
`);
    expect(report.scriptSites).toHaveLength(5);
    expect(report.scriptFailures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('flags ZADD flags ZateDB rejects', () => {
    const report = audit(`const S = "redis.call('ZADD', KEYS[1], 'XX', 'CH', ARGV[1], ARGV[2])"`);
    expect(report.scriptFailures).toEqual([
      { file: 'app.ts', line: 1, via: 'redis.call', command: 'ZADD', kind: 'unsupported-option', detail: 'XX CH' },
    ]);
  });

  it('flags a SET option ZateDB rejects', () => {
    const report = audit(`const S = "redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[2])"`);
    expect(report.scriptFailures).toMatchObject([{ command: 'SET', kind: 'unsupported-option', detail: 'PXAT' }]);
  });

  it('flags a command that exists but is not callable from a script', () => {
    const report = audit(`const S = "redis.call('EVAL', 'return 1', 0)"`);
    expect(report.scriptFailures).toMatchObject([{ command: 'EVAL', kind: 'not-allowed-in-script' }]);
  });

  it('warns, without failing, on a non-literal command name', () => {
    const report = audit(`
const S = "local cmd = ARGV[1]; return redis.call(cmd, KEYS[1])"
const T = \`return redis.call('\${op}', KEYS[1])\`
`);
    expect(report.scriptFailures).toEqual([]);
    expect(report.warnings.map((w) => [w.line, w.kind, w.detail])).toEqual([
      [2, 'dynamic-command', 'command name is not a literal: cmd'],
      [3, 'dynamic-command', "command name is not a literal: '${…}'"],
    ]);
  });

  it('checks the literal parts of a template with substitutions', () => {
    const report = audit(`const S = \`local limit = \${limit}
return redis.call('ZCARD', '\${prefix}:' .. KEYS[1])\``);
    expect(report.scriptFailures).toMatchObject([{ command: 'ZCARD', line: 2 }]);
  });

  it('ignores redis.call mentioned in comments', () => {
    const report = audit(`
      // the old script used redis.call('ZCARD', KEYS[1])
      /* redis.call('LLEN', KEYS[1]) */
      const x = 1;
    `);
    expect(report.scriptSites).toEqual([]);
  });

  it('ignores a "--" Lua comment inside the argument list', () => {
    const report = audit(`const S = \`redis.call(
  'ZADD', -- add, keyed by score
  KEYS[1], ARGV[1], ARGV[2])\``);
    expect(report.scriptSites).toMatchObject([{ command: 'ZADD', kind: 'ok' }]);
  });
});
