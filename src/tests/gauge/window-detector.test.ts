import { describe, it, expect } from 'vitest';
import { detectWindowSize } from '../../gauge/window-detector.js';

describe('detectWindowSize', () => {
  it('returns 200000 by default with no params', () => {
    expect(detectWindowSize({})).toBe(200_000);
  });

  it('returns 200000 for unknown model', () => {
    expect(detectWindowSize({ model: 'gpt-4' })).toBe(200_000);
  });

  it('returns 200000 for claude-opus-4 with low observed tokens', () => {
    expect(detectWindowSize({ model: 'claude-opus-4', observedTokens: 100_000 })).toBe(200_000);
  });

  it('returns 1000000 for claude-opus-4 with high observed tokens', () => {
    expect(detectWindowSize({ model: 'claude-opus-4', observedTokens: 196_000 })).toBe(1_000_000);
  });

  it('returns 1000000 for claude-sonnet-4 with high observed tokens', () => {
    expect(detectWindowSize({ model: 'claude-sonnet-4', observedTokens: 200_000 })).toBe(1_000_000);
  });

  it('handles model prefix variants (claude-opus-4-20260301)', () => {
    expect(detectWindowSize({ model: 'claude-opus-4-20260301', observedTokens: 196_000 })).toBe(1_000_000);
  });

  it('returns 200000 when model matches but observedTokens is undefined', () => {
    expect(detectWindowSize({ model: 'claude-opus-4' })).toBe(200_000);
  });

  it('is non-throwing on null/undefined inputs', () => {
    expect(() => detectWindowSize({} as any)).not.toThrow();
    expect(detectWindowSize(undefined as any)).toBe(200_000);
  });
});
