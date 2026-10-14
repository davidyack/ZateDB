import type { FloatContribution } from './types.js';

/**
 * Strict float parse for HINCRBYFLOAT increments and existing field values:
 * decimal with optional sign, fraction and exponent. Rejects '', whitespace,
 * hex, and non-finite values (`inf`/`nan`), which Redis also refuses for
 * HINCRBYFLOAT. Returns null when the text isn't an acceptable float.
 */
export function parseRedisFloat(raw: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Formats a HINCRBYFLOAT result the way Redis's human-readable long-double
 * formatting does: plain decimal notation (never an exponent), no trailing
 * zeros, no trailing '.', and `-0` collapsed to `0`. Digits come from the
 * shortest representation that round-trips the double, so they never exceed
 * 17 significant digits and `0.1` stays `0.1` rather than `0.10000000000000001`.
 */
export function formatRedisFloat(n: number): string {
  if (n === 0) return '0';
  const s = String(n);
  const expAt = s.indexOf('e');
  if (expAt === -1) return s;

  // Expand JS's exponent form (e.g. '1.5e-7', '1e+21') into fixed notation.
  const negative = s.startsWith('-');
  const mantissa = s.slice(negative ? 1 : 0, expAt);
  const exponent = Number(s.slice(expAt + 1));
  const dot = mantissa.indexOf('.');
  const digits = mantissa.replace('.', '');
  const pointPos = (dot === -1 ? mantissa.length : dot) + exponent; // index of the decimal point within `digits`
  let out: string;
  if (pointPos <= 0) out = `0.${'0'.repeat(-pointPos)}${digits}`;
  else if (pointPos >= digits.length) out = digits + '0'.repeat(pointPos - digits.length);
  else out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return negative ? `-${out}` : out;
}

/**
 * A field counter's effective value: the sum of every origin's `p - n`.
 * Origins are summed in sorted order so every node holding the same
 * contributions computes a bit-identical double (float addition isn't
 * associative, and Map insertion order differs per node).
 */
export function sumFloatContributions(contributions: Map<string, FloatContribution>): number {
  let p = 0;
  let n = 0;
  for (const origin of [...contributions.keys()].sort()) {
    const c = contributions.get(origin) as FloatContribution;
    p += c.p;
    n += c.n;
  }
  return p - n;
}

/** Splits a plain base value into the PN shape (positive half or negative magnitude). */
export function baseContribution(base: number): FloatContribution {
  return base >= 0 ? { p: base, n: 0 } : { p: 0, n: -base };
}
