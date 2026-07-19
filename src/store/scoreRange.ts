/**
 * Redis sorted-set range bound syntax: a bare number is inclusive, a
 * "(number" prefix is exclusive, and -inf/+inf are unbounded. ZCOUNT and
 * ZREMRANGEBYSCORE both take a min/max pair in this syntax, e.g. the sliding
 * window pattern `ZCOUNT key "(1700000000000" "+inf"`.
 */
export interface ScoreBound {
  value: number;
  exclusive: boolean;
}

export class InvalidScoreRangeError extends Error {}

export function parseScoreBound(raw: string): ScoreBound {
  if (raw === '+inf' || raw === '+Inf' || raw === '+INF') {
    return { value: Infinity, exclusive: false };
  }
  if (raw === '-inf' || raw === '-Inf' || raw === '-INF') {
    return { value: -Infinity, exclusive: false };
  }
  const exclusive = raw.startsWith('(');
  const numericPart = exclusive ? raw.slice(1) : raw;
  const value = Number(numericPart);
  if (Number.isNaN(value) || numericPart.length === 0) {
    throw new InvalidScoreRangeError(`ERR min or max is not a float`);
  }
  return { value, exclusive };
}

export function scoreSatisfiesMin(score: number, min: ScoreBound): boolean {
  return min.exclusive ? score > min.value : score >= min.value;
}

export function scoreSatisfiesMax(score: number, max: ScoreBound): boolean {
  return max.exclusive ? score < max.value : score <= max.value;
}

export function scoreInRange(score: number, min: ScoreBound, max: ScoreBound): boolean {
  return scoreSatisfiesMin(score, min) && scoreSatisfiesMax(score, max);
}
