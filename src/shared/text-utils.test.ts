import { truncateText, normalize, estimateTokens } from './text-utils.js';

describe('text-utils', () => {
  describe('truncateText', () => {
    it('returns text unchanged when under maxLength', () => {
      expect(truncateText('hello', 10)).toBe('hello');
    });

    it('truncates and appends ... when over maxLength', () => {
      expect(truncateText('hello world', 5)).toBe('hello...');
    });

    it('returns empty string for empty input', () => {
      expect(truncateText('', 10)).toBe('');
    });

    it('returns empty string for null/undefined input', () => {
      expect(truncateText(null as unknown as string, 10)).toBe('');
      expect(truncateText(undefined as unknown as string, 10)).toBe('');
    });
  });

  describe('normalize', () => {
    it('lowercases text', () => {
      expect(normalize('Hello World')).toBe('hello world');
    });

    it('trims whitespace', () => {
      expect(normalize('  hello  ')).toBe('hello');
    });

    it('collapses whitespace', () => {
      expect(normalize('hello   world   foo')).toBe('hello world foo');
    });

    it('returns empty string for empty input', () => {
      expect(normalize('')).toBe('');
    });

    it('returns empty string for null/undefined', () => {
      expect(normalize(null as unknown as string)).toBe('');
      expect(normalize(undefined as unknown as string)).toBe('');
    });
  });

  describe('estimateTokens', () => {
    it('returns approximate token count', () => {
      // 20 chars / 4 = 5 tokens
      const result = estimateTokens('12345678901234567890');
      expect(result).toBe(5);
    });

    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('returns 0 for null/undefined', () => {
      expect(estimateTokens(null as unknown as string)).toBe(0);
      expect(estimateTokens(undefined as unknown as string)).toBe(0);
    });

    it('returns a number', () => {
      expect(typeof estimateTokens('some text')).toBe('number');
    });
  });
});
