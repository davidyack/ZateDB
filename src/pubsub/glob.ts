/**
 * Converts a Redis-style glob pattern (used by PSUBSCRIBE) to a RegExp.
 * Supports '*', '?', and '[...]' character classes, matching Redis's
 * pattern syntax (a subset of glob, not a full shell glob).
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        let cls = pattern.slice(i + 1, close);
        let negate = false;
        if (cls.startsWith('^')) {
          negate = true;
          cls = cls.slice(1);
        }
        out += `[${negate ? '^' : ''}${cls.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegExpChar(pattern[i + 1]);
      i++;
    } else {
      out += escapeRegExpChar(c);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}
