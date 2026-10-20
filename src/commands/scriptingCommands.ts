import { array, bulk, error, integer, OK } from '../resp/types.js';
import type { RespValue } from '../resp/types.js';
import type { CommandContext, CommandResult } from './context.js';
import { result } from './context.js';
import { wrongArgsError } from './errors.js';
import { COMMANDS, runCommand } from './dispatcher.js';
import { NOT_ALLOWED_IN_SCRIPT } from './commandNames.js';
import { runLuaScript } from '../scripting/luaEngine.js';
import { scriptCache } from '../scripting/scriptCache.js';
import { recordEvalsha, recordScriptError } from '../telemetry/scriptMetrics.js';


/**
 * Executes one `redis.call(...)` from a running script. Returns a single RESP
 * frame (data commands always reply with exactly one). Never throws: an
 * unknown or disallowed command comes back as an `error` frame, which the Lua
 * engine turns into a script-visible error.
 */
function executeScriptCommand(ctx: CommandContext, argv: string[]): RespValue {
  const command = (argv[0] ?? '').toUpperCase();
  if (command === '') return error('ERR Unknown Redis command called from script');

  const cmdSpec = COMMANDS[command];
  if (!cmdSpec) return error(`ERR Unknown Redis command called from script: '${command}'`);
  if (NOT_ALLOWED_IN_SCRIPT.has(command)) {
    return error('ERR This Redis command is not allowed from script');
  }

  const outcome = runCommand(ctx, command, argv.slice(1), cmdSpec);
  return outcome.frames[0] ?? error('ERR script command produced no reply');
}

/** Shared EVAL/EVALSHA body: validate numkeys, split KEYS/ARGV, run. */
function runWithArgs(ctx: CommandContext, commandName: string, source: string, rest: string[]): CommandResult {
  const numkeysRaw = rest[0];
  if (!/^-?\d+$/.test(numkeysRaw ?? '')) {
    return result(error('ERR value is not an integer or out of range'));
  }
  const numkeys = Number(numkeysRaw);
  if (numkeys < 0) return result(error('ERR Number of keys can\'t be negative'));
  if (numkeys > rest.length - 1) return result(error('ERR Number of keys can\'t be greater than number of args'));

  const keys = rest.slice(1, 1 + numkeys);
  const argv = rest.slice(1 + numkeys);

  const reply = runLuaScript({
    source,
    keys,
    argv,
    redisCall: (callArgs) => executeScriptCommand(ctx, callArgs),
  });
  if (reply.type === 'error') {
    // The compile-failure message is a stable literal from luaEngine; anything
    // else that surfaced as an error came from executing the script.
    recordScriptError(reply.value.includes('Error compiling script') ? 'compile' : 'runtime');
  }
  return { frames: [reply] };
}

export function evalCommand(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2) return result(wrongArgsError('eval'));
  const [source, ...rest] = args;
  // EVAL also populates the script cache, so a later EVALSHA of the same body hits.
  scriptCache.load(source);
  return runWithArgs(ctx, 'eval', source, rest);
}

export function evalshaCommand(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length < 2) return result(wrongArgsError('evalsha'));
  const [sha, ...rest] = args;
  const source = scriptCache.get(sha);
  if (source === undefined) {
    recordEvalsha('noscript');
    return result(error('NOSCRIPT No matching script. Please use EVAL.'));
  }
  recordEvalsha('hit');
  return runWithArgs(ctx, 'evalsha', source, rest);
}

export function scriptCommand(ctx: CommandContext, args: string[]): CommandResult {
  const sub = (args[0] ?? '').toUpperCase();
  switch (sub) {
    case 'LOAD': {
      if (args.length !== 2) return result(wrongArgsError('script|load'));
      return result(bulk(scriptCache.load(args[1])));
    }
    case 'EXISTS': {
      const shas = args.slice(1);
      return result(array(shas.map((sha) => integer(scriptCache.has(sha) ? 1 : 0))));
    }
    case 'FLUSH': {
      // ASYNC/SYNC modifiers are accepted and ignored — the flush is synchronous.
      scriptCache.flush();
      return result(OK);
    }
    default:
      return result(error(`ERR Unknown SCRIPT subcommand or wrong number of arguments for '${sub}'`));
  }
}
