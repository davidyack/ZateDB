import { createHash } from 'node:crypto';

/**
 * Process-global cache of Lua script bodies keyed by their SHA1, mirroring
 * Redis's server-wide script cache: `SCRIPT LOAD` / `EVAL` populate it and
 * `EVALSHA` reads it, across every connection. It holds only script source
 * (small, and inherently shared text keyed by a content hash), so a single
 * per-process instance is correct even when several Store instances coexist
 * in one process (e.g. across tests) — the same source always maps to the
 * same SHA. `SCRIPT FLUSH` clears it.
 */
class ScriptCache {
  private byHash = new Map<string, string>();

  /** Stores the source and returns its lowercase SHA1 hex digest. */
  load(source: string): string {
    const sha = sha1hex(source);
    this.byHash.set(sha, source);
    return sha;
  }

  get(sha: string): string | undefined {
    return this.byHash.get(sha.toLowerCase());
  }

  has(sha: string): boolean {
    return this.byHash.has(sha.toLowerCase());
  }

  flush(): void {
    this.byHash.clear();
  }

  /** Number of cached scripts — backs the `zatedb.scripts.cache.size` gauge. */
  size(): number {
    return this.byHash.size;
  }
}

export function sha1hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/** The one process-wide script cache. */
export const scriptCache = new ScriptCache();
