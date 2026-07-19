import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for secrets (RESP AUTH password, admin
 * bearer token). Both sides are hashed to a fixed 32-byte digest first so
 * timingSafeEqual always sees equal-length buffers — it throws on a length
 * mismatch, and the raw length difference would itself be a (small) timing
 * signal. The result is independent of where the first differing byte is.
 */
export function secureEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a, 'utf8').digest();
  const bh = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ah, bh);
}
