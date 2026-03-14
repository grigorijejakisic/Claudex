import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../shared/text-utils.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for null/undefined', () => {
    expect(estimateTokens(null as any)).toBe(0);
    expect(estimateTokens(undefined as any)).toBe(0);
  });

  it('returns ceil(length/4) for normal text', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil(11 / 4)); // 3
  });

  it('returns 1 for single character', () => {
    expect(estimateTokens('a')).toBe(1);
  });

  it('returns correct estimate for longer text', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('handles exact multiples of 4', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('is non-throwing', () => {
    expect(() => estimateTokens(42 as any)).not.toThrow();
    expect(() => estimateTokens({} as any)).not.toThrow();
  });
});
