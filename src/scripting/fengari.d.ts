/**
 * Minimal ambient declaration for fengari (a pure-JS Lua 5.3 VM). fengari
 * ships no types; the RESP<->Lua bridge in luaEngine.ts uses its C-style API
 * directly, so a loose `any`-typed surface is enough and avoids vendoring a
 * full hand-written definition of the whole Lua C API.
 */
declare module 'fengari' {
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(s: string): Uint8Array;
  export function to_jsstring(s: Uint8Array): string;
}
