import { cosineSimilarity } from '../../embeddings/cosine.js';

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical normalized vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('returns value between 0 and 1 for similar vectors', () => {
    const sim = cosineSimilarity([1, 1, 0], [1, 0, 0]);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    // cos(45deg) = sqrt(2)/2 ≈ 0.707
    expect(sim).toBeCloseTo(Math.SQRT2 / 2, 4);
  });

  it('returns 0 for zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty arrays', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('is non-throwing on invalid input', () => {
    expect(cosineSimilarity(null as unknown as number[], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], undefined as unknown as number[])).toBe(0);
  });
});
