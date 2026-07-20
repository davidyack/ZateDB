import { lua, lauxlib, lualib, to_luastring } from 'fengari';
import { array, bulk, error, integer, simple, NIL } from '../resp/types.js';
import type { RespValue } from '../resp/types.js';
import { sha1hex } from './scriptCache.js';

/**
 * Runs a Lua script the way Redis's EVAL does: `KEYS` and `ARGV` are exposed
 * as 1-indexed global tables, `redis.call`/`redis.pcall` dispatch back into
 * the command layer via `redisCall`, and the script's return value is
 * converted to a RESP reply. A fresh Lua state is created per invocation, so
 * no globals leak between scripts (Redis relies on a sandbox + KEYS/ARGV
 * discipline for the same isolation).
 *
 * `redisCall(argv)` must never throw — it returns a RespValue, and an
 * `error`-typed one is surfaced to the script as a Lua error (`redis.call`)
 * or an `{err=...}` table (`redis.pcall`), matching Redis.
 */
export interface RunLuaOptions {
  source: string;
  keys: string[];
  argv: string[];
  redisCall: (argv: string[]) => RespValue;
}

export function runLuaScript(opts: RunLuaOptions): RespValue {
  const L = lauxlib.luaL_newstate();
  try {
    openSafeLibs(L);
    installRedisGlobal(L, opts.redisCall);
    setGlobalStringArray(L, 'KEYS', opts.keys);
    setGlobalStringArray(L, 'ARGV', opts.argv);

    // Name the chunk "@user_script" so error messages read like Redis's.
    const loadStatus = lauxlib.luaL_loadbuffer(
      L,
      to_luastring(opts.source),
      opts.source.length,
      to_luastring('@user_script'),
    );
    if (loadStatus !== lua.LUA_OK) {
      return error(`ERR Error compiling script (new function): ${popErrorMessage(L)}`);
    }

    const runStatus = lua.lua_pcall(L, 0, 1, 0);
    if (runStatus !== lua.LUA_OK) {
      return error(scriptRuntimeError(L));
    }

    return luaToResp(L, -1);
  } finally {
    // Drop the state's reference; fengari is GC-managed, no explicit close.
    lua.lua_settop(L, 0);
  }
}

// ---- library sandbox -------------------------------------------------------

function openSafeLibs(L: unknown): void {
  // Only the deterministic, side-effect-free libraries Redis exposes to
  // scripts. Deliberately omits io/os/package/debug so a script can't touch
  // the filesystem, clock, environment, or module loader.
  const libs: Array<[string, unknown]> = [
    ['_G', lualib.luaopen_base],
    ['table', lualib.luaopen_table],
    ['string', lualib.luaopen_string],
    ['math', lualib.luaopen_math],
  ];
  for (const [name, openf] of libs) {
    lauxlib.luaL_requiref(L, to_luastring(name), openf, 1);
    lua.lua_pop(L, 1);
  }
}

// ---- the `redis` global ----------------------------------------------------

function installRedisGlobal(L: any, redisCall: (argv: string[]) => RespValue): void {
  lua.lua_createtable(L, 0, 8);

  setTableFunction(L, 'call', makeCallFn(redisCall, /* raise */ true));
  setTableFunction(L, 'pcall', makeCallFn(redisCall, /* raise */ false));

  setTableFunction(L, 'error_reply', (S: any) => {
    const msg = lua.lua_tojsstring(S, 1) ?? 'error';
    pushResp(S, error(hasErrorCode(msg) ? msg : `ERR ${msg}`));
    return 1;
  });
  setTableFunction(L, 'status_reply', (S: any) => {
    const msg = lua.lua_tojsstring(S, 1) ?? '';
    pushResp(S, simple(msg));
    return 1;
  });
  setTableFunction(L, 'sha1hex', (S: any) => {
    const s = lua.lua_tojsstring(S, 1) ?? '';
    lua.lua_pushstring(S, to_luastring(sha1hex(s)));
    return 1;
  });
  // Observability/compatibility no-ops. Real callers (e.g. rate-limit-redis)
  // don't depend on their behaviour, only on their presence not erroring.
  setTableFunction(L, 'log', () => 0);
  setTableFunction(L, 'replicate_commands', (S: any) => {
    lua.lua_pushboolean(S, true); // Redis 5+ default; some scripts call this.
    return 1;
  });
  setTableFunction(L, 'set_repl', () => 0);
  setTableFunction(L, 'setresp', () => 0);
  setTableFunction(L, 'breakpoint', (S: any) => {
    lua.lua_pushboolean(S, false);
    return 1;
  });
  setTableFunction(L, 'debug', () => 0);

  lua.lua_setglobal(L, to_luastring('redis'));
}

/**
 * Builds the C function backing `redis.call` (raise=true) or `redis.pcall`
 * (raise=false). Reads the string/number arguments off the Lua stack, runs
 * the command, and converts the RESP reply back to a Lua value. A JS
 * exception from the command layer is caught and turned into a Lua error
 * rather than being allowed to unwind through the VM.
 */
function makeCallFn(redisCall: (argv: string[]) => RespValue, raise: boolean) {
  return (L: any): number => {
    const n = lua.lua_gettop(L);
    if (n === 0) {
      return lauxlib.luaL_error(L, to_luastring('Please specify at least one argument for this redis lib call'));
    }

    const argv: string[] = [];
    for (let i = 1; i <= n; i++) {
      const t = lua.lua_type(L, i);
      if (t === lua.LUA_TSTRING) {
        argv.push(lua.lua_tojsstring(L, i));
      } else if (t === lua.LUA_TNUMBER) {
        argv.push(formatNumberArg(lua.lua_tonumberx(L, i, null)));
      } else {
        return lauxlib.luaL_error(L, to_luastring('Lua redis lib command arguments must be strings or integers'));
      }
    }

    let reply: RespValue;
    try {
      reply = redisCall(argv);
    } catch (e) {
      return lauxlib.luaL_error(L, to_luastring(`ERR ${e instanceof Error ? e.message : String(e)}`));
    }

    if (reply.type === 'error') {
      if (raise) {
        pushResp(L, reply); // push the {err=...} table, then raise it
        return lua.lua_error(L);
      }
      pushResp(L, reply); // pcall: hand the {err=...} table back to the script
      return 1;
    }

    pushResp(L, reply);
    return 1;
  };
}

// ---- RESP -> Lua -----------------------------------------------------------

function pushResp(L: any, v: RespValue): void {
  switch (v.type) {
    case 'integer':
      lua.lua_pushinteger(L, v.value);
      return;
    case 'bulk':
      if (v.value === null) lua.lua_pushboolean(L, false); // nil bulk -> false
      else lua.lua_pushstring(L, to_luastring(v.value));
      return;
    case 'simple':
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushstring(L, to_luastring(v.value));
      lua.lua_setfield(L, -2, to_luastring('ok'));
      return;
    case 'error':
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushstring(L, to_luastring(v.value));
      lua.lua_setfield(L, -2, to_luastring('err'));
      return;
    case 'array': {
      if (v.value === null) {
        lua.lua_pushboolean(L, false); // nil array -> false
        return;
      }
      lua.lua_createtable(L, v.value.length, 0);
      v.value.forEach((el, i) => {
        pushResp(L, el);
        lua.lua_rawseti(L, -2, i + 1);
      });
      return;
    }
    case 'map': {
      // RESP2 has no map; flatten [k,v,...] into an array for script visibility.
      const flat = v.value.flatMap(([k, val]) => [k, val]);
      lua.lua_createtable(L, flat.length, 0);
      flat.forEach((el, i) => {
        pushResp(L, el);
        lua.lua_rawseti(L, -2, i + 1);
      });
      return;
    }
  }
}

// ---- Lua -> RESP -----------------------------------------------------------

function luaToResp(L: any, index: number): RespValue {
  const idx = lua.lua_absindex(L, index);
  const t = lua.lua_type(L, idx);

  switch (t) {
    case lua.LUA_TNONE:
    case lua.LUA_TNIL:
      return NIL;
    case lua.LUA_TBOOLEAN:
      // Lua false -> nil, true -> :1 (Redis's boolean conversion).
      return lua.lua_toboolean(L, idx) ? integer(1) : NIL;
    case lua.LUA_TNUMBER:
      // Redis truncates a Lua number to an integer reply.
      return integer(Math.trunc(lua.lua_tonumberx(L, idx, null)));
    case lua.LUA_TSTRING:
      return bulk(lua.lua_tojsstring(L, idx));
    case lua.LUA_TTABLE:
      return tableToResp(L, idx);
    default:
      // functions/userdata/threads have no RESP representation.
      return NIL;
  }
}

function tableToResp(L: any, idx: number): RespValue {
  // `{err=...}` -> error reply; `{ok=...}` -> status reply; these win over the
  // array interpretation, exactly as in Redis.
  const errField = getStringField(L, idx, 'err');
  // A table `{err=...}` becomes an error reply with the message verbatim,
  // exactly as Redis returns it (no code prefix is synthesized here).
  if (errField !== null) return error(errField);
  const okField = getStringField(L, idx, 'ok');
  if (okField !== null) return simple(okField);

  // Otherwise an array: elements 1..n, stopping at the first nil.
  const elements: RespValue[] = [];
  let i = 1;
  for (;;) {
    lua.lua_rawgeti(L, idx, i);
    const elemType = lua.lua_type(L, -1);
    if (elemType === lua.LUA_TNIL) {
      lua.lua_pop(L, 1);
      break;
    }
    elements.push(luaToResp(L, -1));
    lua.lua_pop(L, 1);
    i++;
  }
  return array(elements);
}

// ---- small helpers ---------------------------------------------------------

function setTableFunction(L: any, name: string, fn: (L: unknown) => number): void {
  lua.lua_pushcfunction(L, fn);
  lua.lua_setfield(L, -2, to_luastring(name));
}

function setGlobalStringArray(L: any, name: string, values: string[]): void {
  lua.lua_createtable(L, values.length, 0);
  values.forEach((v, i) => {
    lua.lua_pushstring(L, to_luastring(v));
    lua.lua_rawseti(L, -2, i + 1);
  });
  lua.lua_setglobal(L, to_luastring(name));
}

/** Reads a string-valued field of the table at `idx`; returns null if absent or non-string. */
function getStringField(L: any, idx: number, field: string): string | null {
  lua.lua_getfield(L, idx, to_luastring(field));
  const value = lua.lua_type(L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : null;
  lua.lua_pop(L, 1);
  return value;
}

function popErrorMessage(L: any): string {
  const msg = lua.lua_tojsstring(L, -1) ?? 'unknown error';
  lua.lua_pop(L, 1);
  return msg;
}

/**
 * Extracts the error a failed `lua_pcall` left on the stack. A raised
 * `{err=...}` table (how `redis.call` propagates a command error) keeps its
 * message verbatim; a bare string error is wrapped so the reply always
 * carries an error code.
 */
function scriptRuntimeError(L: any): string {
  if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
    const err = getStringField(L, -1, 'err');
    lua.lua_pop(L, 1);
    if (err !== null) return hasErrorCode(err) ? err : `ERR ${err}`;
    return 'ERR script raised an error';
  }
  const msg = popErrorMessage(L);
  return hasErrorCode(msg) ? msg : `ERR ${msg}`;
}

/** True if a message already starts with an uppercase error code token (e.g. "WRONGTYPE ", "ERR "). */
function hasErrorCode(msg: string): boolean {
  return /^[A-Z][A-Z0-9_]+\s/.test(msg);
}

/**
 * Formats a Lua number the way Redis stringifies a numeric command argument:
 * an integer prints with no decimal point; a fractional value keeps its
 * shortest round-trippable form.
 */
function formatNumberArg(n: number): string {
  return String(n);
}
