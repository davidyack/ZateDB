import { describe, expect, it } from 'vitest';
import { InvalidScoreRangeError, parseScoreBound, scoreInRange } from '../../src/store/scoreRange.js';

describe('parseScoreBound', () => {
  it('parses a bare integer as inclusive', () => {
    expect(parseScoreBound('5')).toEqual({ value: 5, exclusive: false });
  });

  it('parses a negative number as inclusive', () => {
    expect(parseScoreBound('-5')).toEqual({ value: -5, exclusive: false });
  });

  it('parses a "(" prefixed number as exclusive', () => {
    expect(parseScoreBound('(5')).toEqual({ value: 5, exclusive: true });
  });

  it('parses a "(" prefixed negative number as exclusive', () => {
    expect(parseScoreBound('(-5')).toEqual({ value: -5, exclusive: true });
  });

  it('parses +inf / -inf as unbounded', () => {
    expect(parseScoreBound('+inf')).toEqual({ value: Infinity, exclusive: false });
    expect(parseScoreBound('-inf')).toEqual({ value: -Infinity, exclusive: false });
  });

  it('parses a millisecond-timestamp exclusive bound, exactly as the outbound guard sends it', () => {
    const bound = parseScoreBound('(1700000000000');
    expect(bound).toEqual({ value: 1700000000000, exclusive: true });
  });

  it('throws on garbage input', () => {
    expect(() => parseScoreBound('not-a-number')).toThrow(InvalidScoreRangeError);
    expect(() => parseScoreBound('(')).toThrow(InvalidScoreRangeError);
  });
});

describe('scoreInRange', () => {
  it('treats exclusive bounds as strictly less/greater than', () => {
    const min = parseScoreBound('(10');
    const max = parseScoreBound('(20');
    expect(scoreInRange(10, min, max)).toBe(false);
    expect(scoreInRange(11, min, max)).toBe(true);
    expect(scoreInRange(20, min, max)).toBe(false);
    expect(scoreInRange(19, min, max)).toBe(true);
  });

  it('treats bare-number bounds as inclusive', () => {
    const min = parseScoreBound('10');
    const max = parseScoreBound('20');
    expect(scoreInRange(10, min, max)).toBe(true);
    expect(scoreInRange(20, min, max)).toBe(true);
  });
});
