/**
 * Precomputed decision/non-decision template embeddings and classification.
 * Non-throwing — returns null/0 on error.
 * @see Architecture Section 6.1 — Stage 2 embedding classification
 */

import { EmbeddingProvider } from './embedding-provider.js';
import { cosineSimilarity } from './cosine.js';

/** Precomputed template embeddings for decision classification. */
export interface DecisionTemplates {
  positive: Map<string, number[]>; // template text -> embedding
  negative: Map<string, number[]>; // template text -> embedding
}

/** Positive decision templates from Architecture 6.1. */
const POSITIVE_TEMPLATES = [
  'We decided to use X instead of Y',
  'The approach is to implement X',
  'Confirmed: we will proceed with X',
  'Rejected Y in favor of X',
  'Architecture decision: X for the storage layer',
];

/** Negative (filler) templates from Architecture 6.1. */
const NEGATIVE_TEMPLATES = [
  'Let me read the file',
  "I'll check that for you",
  'Looking at the code now',
  'Running the tests',
];

/**
 * Precompute template embeddings at init. Uses batch embedding API
 * to send all 9 templates in a single HTTP call instead of 9 sequential calls.
 * Returns null if provider unavailable or any embedding fails. Non-throwing.
 */
export async function initTemplates(
  provider: EmbeddingProvider
): Promise<DecisionTemplates | null> {
  try {
    const allTexts = [...POSITIVE_TEMPLATES, ...NEGATIVE_TEMPLATES];
    const allEmbeddings = await provider.embedBatch(allTexts);

    // Verify embedBatch returned the expected number of results
    if (allEmbeddings.length !== allTexts.length) return null;

    // If any embedding is null, fail the whole init
    if (allEmbeddings.some(e => e === null)) return null;

    const positive = new Map<string, number[]>();
    const negative = new Map<string, number[]>();

    for (let i = 0; i < POSITIVE_TEMPLATES.length; i++) {
      positive.set(POSITIVE_TEMPLATES[i], allEmbeddings[i]!);
    }

    for (let i = 0; i < NEGATIVE_TEMPLATES.length; i++) {
      negative.set(NEGATIVE_TEMPLATES[i], allEmbeddings[POSITIVE_TEMPLATES.length + i]!);
    }

    return { positive, negative };
  } catch {
    return null;
  }
}

/**
 * Classify a candidate embedding against decision templates.
 * Returns maxPositiveSim - maxNegativeSim (confidence score).
 * Positive = more decision-like, negative = more filler-like.
 * Returns 0 on error. Non-throwing.
 */
export function classifyDecision(
  candidateEmb: number[],
  templates: DecisionTemplates
): number {
  try {
    if (!candidateEmb || !templates) return 0;
    if (templates.positive.size === 0 && templates.negative.size === 0) return 0;

    let maxPositive = -Infinity;
    for (const posEmb of templates.positive.values()) {
      const sim = cosineSimilarity(candidateEmb, posEmb);
      if (sim > maxPositive) maxPositive = sim;
    }
    if (maxPositive === -Infinity) maxPositive = 0;

    let maxNegative = -Infinity;
    for (const negEmb of templates.negative.values()) {
      const sim = cosineSimilarity(candidateEmb, negEmb);
      if (sim > maxNegative) maxNegative = sim;
    }
    if (maxNegative === -Infinity) maxNegative = 0;

    return maxPositive - maxNegative;
  } catch {
    return 0;
  }
}
