/**
 * Shared search utilities for FTS5 keyword extraction.
 * Used by artifacts.ts and experience-patterns.ts to avoid duplication.
 */

/** Stop words excluded from FTS5 keyword extraction. */
export const SEARCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'my', 'your',
  'let', 'just', 'now', 'so', 'if', 'but', 'or', 'and', 'not', 'no',
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'whom',
]);

/** Extract meaningful keywords from a query string for FTS5 matching. */
export function tokenizeQuery(query: string, maxTerms?: number): string[] {
  const keywords = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !SEARCH_STOP_WORDS.has(w));
  return maxTerms ? keywords.slice(0, maxTerms) : keywords;
}
