import { describe, it, expect } from 'vitest';
import { normalizeEpochMs } from '../../shared/epoch-utils.js';

describe('normalizeEpochMs', () => {
  it('passes 13-digit ms values through unchanged', () => {
    const ms = Date.now();
    expect(normalizeEpochMs(ms)).toBe(ms);
  });

  it('converts 10-digit seconds to ms', () => {
    const seconds = Math.floor(Date.now() / 1000);
    expect(normalizeEpochMs(seconds)).toBe(seconds * 1000);
  });

  it('returns 0 for null/undefined', () => {
    expect(normalizeEpochMs(null)).toBe(0);
    expect(normalizeEpochMs(undefined)).toBe(0);
  });

  it('returns 0 for non-finite numbers', () => {
    expect(normalizeEpochMs(NaN)).toBe(0);
    expect(normalizeEpochMs(Infinity)).toBe(0);
  });

  it('handles boundary value 1e12 as ms (boundary is inclusive on the ms side)', () => {
    expect(normalizeEpochMs(1e12)).toBe(1e12);
  });

  it('handles 1e12 - 1 as seconds', () => {
    expect(normalizeEpochMs(1e12 - 1)).toBe((1e12 - 1) * 1000);
  });

  it('handles zero (treated as seconds, normalizes to zero)', () => {
    expect(normalizeEpochMs(0)).toBe(0);
  });
});
