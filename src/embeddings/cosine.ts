/**
 * Cosine similarity computation. Pure math, no dependencies.
 * Non-throwing (returns 0 on error).
 */

/**
 * Compute cosine similarity between two vectors.
 * dot(a, b) / (|a| * |b|)
 * Returns 0.0 for zero vectors, mismatched lengths, or empty arrays.
 * Range: -1.0 to 1.0 (normalized embeddings typically 0.0 to 1.0).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  try {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;
    if (a.length !== b.length) return 0;

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    if (magnitude === 0) return 0;

    return dot / magnitude;
  } catch {
    return 0;
  }
}
