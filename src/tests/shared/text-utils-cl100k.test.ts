import { describe, it, expect } from 'vitest';
import { countTokensCl100k, estimateTokens } from '../../shared/text-utils.js';

describe('countTokensCl100k', () => {
  it('returns 0 for empty string', () => {
    expect(countTokensCl100k('')).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(countTokensCl100k(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(countTokensCl100k(undefined)).toBe(0);
  });

  it('returns a small positive count for short ASCII prose', () => {
    const n = countTokensCl100k('hello world');
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
  });

  it('returns a reasonable count for a 1000-char run of a single letter', () => {
    const n = countTokensCl100k('a'.repeat(1000));
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(600);
  });

  it('counts JSON within the cl100k_base reference range', () => {
    const n = countTokensCl100k('{"a": 1, "b": 2}');
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(15);
  });

  it('differs from estimateTokens for code (proves it is not chars/4)', () => {
    const code = 'function foo() { return 42; }';
    const a = countTokensCl100k(code);
    const b = estimateTokens(code);
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(1);
  });

  it('handles unicode without throwing', () => {
    const n = countTokensCl100k('héllo wörld — café 🌍');
    expect(n).toBeGreaterThan(0);
  });
});
