/**
 * Extracts structured insights from assistant response text.
 * Captures analytical conclusions, root causes, and key findings —
 * the high-value knowledge that lives in conversation, not in tool outputs.
 *
 * Two extraction paths (3.4 Semantic Insight Extraction):
 *   1. Regex-based (always runs, acts as floor)
 *   2. Semantic (embedding similarity against reference phrases, when available)
 *
 * Non-throwing. Core extraction is pure (no DB dependency).
 * Semantic path requires embed-pipeline (dynamic import, graceful degradation).
 */

/** An extracted insight with its source pattern. */
export interface ExtractedInsight {
  content: string;
  marker: string;
}

// --- Insight marker patterns ---
// Each captures a sentence containing an analytical conclusion.

const INSIGHT_PATTERNS: Array<{ pattern: RegExp; marker: string }> = [
  // Root cause / diagnosis — require specific diagnostic framing
  { pattern: /\b(root cause[: ]|the issue is that|the problem is that|the bug is that|this happens because)\b/i, marker: 'diagnosis' },
  // Findings / discoveries — require "that" clause for substance
  { pattern: /\b(found that|discovered that|it turns out that|the real issue is)\b/i, marker: 'finding' },
  // Conclusions / summaries — removed "so the" (matches everything), tightened others
  { pattern: /\b(in summary|the fix is|the solution is|this confirms that|this explains why)\b/i, marker: 'conclusion' },
  // Architecture / design insights — require declarative structure
  { pattern: /\b(the architecture|the design pattern|the approach)\s+(is|should be|needs to)\b/i, marker: 'architecture' },
  // Systemic observations — require causal connector
  { pattern: /\b(systematically|consistently)\b.*\b(because|due to|caused by)\b/i, marker: 'systemic' },
];

/** Filler patterns to exclude from insights. */
const INSIGHT_FILLER = /^(let me|looking at|checking|I see|I'll|now let me|here's what|good|ok|yes)\b/i;

/** Strip markdown formatting, code fences, and ANSI codes. */
function cleanText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')        // code fences
    .replace(/\x1b\[[0-9;]*m/g, '')        // ANSI escape codes
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold markers
    .replace(/`([^`]+)`/g, '$1')           // inline code
    .replace(/^#+\s+/gm, '')              // markdown headers
    .replace(/^\s*[-*]\s+/gm, '')         // bullet points
    .replace(/\|[^|]+\|/g, '');           // table rows
}

/** Extract the sentence containing a regex match. */
function extractSentenceAt(text: string, matchIndex: number): string {
  // Walk backward to sentence start
  let start = matchIndex;
  while (start > 0 && text[start - 1] !== '.' && text[start - 1] !== '!' && text[start - 1] !== '?' && text[start - 1] !== '\n') {
    start--;
  }

  // Walk forward to sentence end
  let end = matchIndex;
  while (end < text.length && text[end] !== '.' && text[end] !== '!' && text[end] !== '?') {
    end++;
  }
  if (end < text.length) end++; // include the punctuation

  return text.slice(start, end).trim();
}

/**
 * Extracts structured insights from assistant response text.
 * Returns deduplicated, filtered insights ordered by significance.
 *
 * @param assistantText The full assistant response
 * @param maxInsights Maximum insights to extract (default 5)
 * @returns Array of extracted insights, empty if none found
 */
export function extractInsights(
  assistantText: string,
  maxInsights = 5,
): ExtractedInsight[] {
  try {
    if (!assistantText || assistantText.length < 50) return [];

    const cleaned = cleanText(assistantText);
    const seen = new Set<string>();
    const insights: ExtractedInsight[] = [];

    for (const { pattern, marker } of INSIGHT_PATTERNS) {
      // Reset regex state for global-like scanning
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      // Scan the full text for all occurrences
      let searchFrom = 0;
      while (searchFrom < cleaned.length && insights.length < maxInsights * 2) {
        // Find next match after searchFrom
        const sub = cleaned.slice(searchFrom);
        match = regex.exec(sub);
        if (!match) break;

        const absIndex = searchFrom + match.index;
        const sentence = extractSentenceAt(cleaned, absIndex);
        searchFrom = absIndex + match[0].length;

        // Filter: too short, filler, or duplicate
        if (sentence.length < 25) continue;
        if (sentence.length > 300) continue;
        if (INSIGHT_FILLER.test(sentence)) continue;

        // Deduplicate by normalized content
        const normalized = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        insights.push({ content: sentence, marker });
      }
    }

    // Return top insights, capped
    return insights.slice(0, maxInsights);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3.4 Semantic Insight Extraction
// ---------------------------------------------------------------------------

/**
 * Reference phrases that characterize "actionable insight" categories.
 * Used to compute embeddings for semantic comparison.
 * These are pre-defined strings whose embeddings will be cached at first use.
 */
export const INSIGHT_REFERENCE_PHRASES: Array<{ text: string; marker: string }> = [
  { text: 'The root cause was', marker: 'diagnosis' },
  { text: 'The correct approach is', marker: 'prescription' },
  { text: 'This happened because', marker: 'explanation' },
  { text: 'Going forward, always', marker: 'rule' },
  { text: 'Never do X when Y because Z', marker: 'anti-pattern' },
];

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Cached reference embeddings (computed once per process). */
let _referenceEmbeddings: Array<{ marker: string; embedding: number[] }> | null = null;

/**
 * Splits text into paragraph-level chunks for embedding.
 * Paragraphs are separated by blank lines or multiple newlines.
 */
export function chunkIntoParagraphs(text: string, maxChunks: number = 10): string[] {
  const chunks = text
    .split(/\n\s*\n/)
    .map(c => c.trim())
    .filter(c => c.length >= 30 && c.length <= 1000);
  return chunks.slice(0, maxChunks);
}

/**
 * Extracts insights using embedding similarity against reference phrases.
 * Returns additional insights found semantically (above regex floor).
 *
 * Threshold: cosine > 0.75 = likely insight.
 * Fallback: existing regex always runs via extractInsights().
 *
 * Non-throwing. Returns empty array if embeddings unavailable.
 */
export async function extractInsightsSemantic(
  assistantText: string,
  maxInsights: number = 5,
): Promise<ExtractedInsight[]> {
  try {
    if (!assistantText || assistantText.length < 50) return [];

    // Dynamic import — graceful degradation if embed-pipeline unavailable
    let embedText: ((text: string) => Promise<number[] | null>) | null = null;
    try {
      const pipeline = await import('../embeddings/embed-pipeline.js');
      embedText = pipeline.embedText;
    } catch {
      return []; // Embeddings unavailable — regex-only path
    }

    // Compute reference embeddings (cached)
    if (!_referenceEmbeddings) {
      const refs: Array<{ marker: string; embedding: number[] }> = [];
      for (const ref of INSIGHT_REFERENCE_PHRASES) {
        const emb = await embedText(ref.text);
        if (emb) {
          refs.push({ marker: ref.marker, embedding: emb });
        }
      }
      if (refs.length === 0) return [];
      _referenceEmbeddings = refs;
    }

    // Chunk assistant text into paragraphs
    const cleaned = cleanText(assistantText);
    const chunks = chunkIntoParagraphs(cleaned, 10);
    if (chunks.length === 0) return [];

    const seen = new Set<string>();
    const insights: ExtractedInsight[] = [];

    for (const chunk of chunks) {
      if (insights.length >= maxInsights) break;

      const chunkEmb = await embedText(chunk);
      if (!chunkEmb) continue;

      // Compare against all reference embeddings
      let bestSim = 0;
      let bestMarker = '';

      for (const ref of _referenceEmbeddings) {
        const sim = cosineSimilarity(chunkEmb, ref.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestMarker = ref.marker;
        }
      }

      // Threshold: cosine > 0.75
      if (bestSim > 0.75 && bestMarker) {
        const normalized = chunk.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          // Use first sentence as the insight content (paragraph may be long)
          const firstSentence = chunk.split(/[.!?]/)[0]?.trim();
          if (firstSentence && firstSentence.length >= 25 && firstSentence.length <= 300) {
            insights.push({ content: firstSentence, marker: `semantic:${bestMarker}` });
          }
        }
      }
    }

    return insights;
  } catch {
    return [];
  }
}

/**
 * Combined insight extraction: regex (floor) + semantic (boost).
 * Merges both paths, deduplicates, and returns the best insights.
 *
 * Non-throwing.
 */
export async function extractInsightsCombined(
  assistantText: string,
  maxInsights: number = 5,
): Promise<ExtractedInsight[]> {
  try {
    // Always run regex (floor)
    const regexInsights = extractInsights(assistantText, maxInsights);

    // Try semantic (boost) — non-blocking
    let semanticInsights: ExtractedInsight[] = [];
    try {
      semanticInsights = await extractInsightsSemantic(assistantText, maxInsights);
    } catch {
      // Semantic path failed — regex floor still provides results
    }

    // Merge and deduplicate
    const seen = new Set<string>();
    const merged: ExtractedInsight[] = [];

    for (const insight of [...regexInsights, ...semanticInsights]) {
      const normalized = insight.content.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        merged.push(insight);
      }
    }

    return merged.slice(0, maxInsights);
  } catch {
    // Absolute fallback: return regex results
    return extractInsights(assistantText, maxInsights);
  }
}
