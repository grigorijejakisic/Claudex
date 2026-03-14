/**
 * Extracts structured insights from assistant response text.
 * Captures analytical conclusions, root causes, and key findings —
 * the high-value knowledge that lives in conversation, not in tool outputs.
 *
 * Non-throwing. Pure function (no DB dependency).
 */

/** An extracted insight with its source pattern. */
export interface ExtractedInsight {
  content: string;
  marker: string;
}

// --- Insight marker patterns ---
// Each captures a sentence containing an analytical conclusion.

const INSIGHT_PATTERNS: Array<{ pattern: RegExp; marker: string }> = [
  // Root cause / diagnosis
  { pattern: /\b(root cause|the issue is|the problem is|the bug is|this is because|this means|this happens because)\b/i, marker: 'diagnosis' },
  // Findings / discoveries
  { pattern: /\b(found that|discovered that|turns out|it turns out|the real issue|the actual)\b/i, marker: 'finding' },
  // Conclusions / summaries
  { pattern: /\b(in summary|the fix is|the solution is|this confirms|this explains why|this is why|so the)\b/i, marker: 'conclusion' },
  // Architecture / design insights
  { pattern: /\b(the architecture|the design|the pattern|the model|the approach|the strategy)\s+(is|was|should|needs)\b/i, marker: 'architecture' },
  // Systemic observations
  { pattern: /\b(every|all|none of the|never|always|systematically|consistently)\b.*\b(because|due to|caused by|means|fails|works|broken)\b/i, marker: 'systemic' },
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
