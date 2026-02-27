/**
 * Claudex v2 — FTS5 Query Utilities
 *
 * Normalizes FTS5 queries to avoid special character issues.
 * FTS5 treats hyphens as the NOT operator, which causes queries like
 * "tree-shaking" or "error-handling" to produce wrong or empty results.
 *
 * This utility strips problematic characters to make queries safe for FTS5 MATCH.
 */

/**
 * Normalize a query string for safe FTS5 MATCH usage.
 *
 * FTS5 special characters that need handling:
 * - Hyphen (-): interpreted as NOT operator
 * - Quotes ("): phrase delimiter (we preserve for intentional phrase searches)
 * - Parentheses ( ): grouping (we strip to avoid malformed syntax)
 * - Asterisk (*): prefix search (we preserve for intentional prefix searches)
 * - Colon (:): column filter (we preserve for intentional column searches)
 *
 * Strategy: Replace hyphens with spaces (split hyphenated words into separate terms).
 * Strip parentheses to avoid syntax errors. Preserve quotes, asterisk, colon for
 * power users who know FTS5 syntax.
 *
 * Options:
 * - mode 'AND' (default): implicit AND between terms (FTS5 default behavior)
 * - mode 'OR': join terms with OR keyword for broader matching
 * - prefix: when true, appends * to terms shorter than 6 characters for prefix matching
 *
 * @param query - Raw user query string
 * @param options - Optional mode and prefix settings
 * @returns Normalized query safe for FTS5 MATCH
 */
export function normalizeFts5Query(
  query: string,
  options?: { mode?: 'AND' | 'OR'; prefix?: boolean },
): string {
  const sanitized = query
    .replace(/-/g, ' ')       // Replace hyphens with spaces
    .replace(/[()]/g, '')     // Strip parentheses
    .replace(/\s+/g, ' ')     // Collapse multiple spaces
    .trim();

  if (!sanitized) return '';

  const mode = options?.mode ?? 'AND';
  const usePrefix = options?.prefix ?? false;

  // Split into tokens, preserving quoted phrases and existing operators
  const tokens = sanitized.split(' ').filter(Boolean);
  const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

  const processed = tokens.map(token => {
    // Don't modify FTS5 operators, quoted phrases, or tokens with explicit wildcards/column filters
    if (FTS5_OPERATORS.has(token) || token.startsWith('"') || token.endsWith('*') || token.includes(':')) {
      return token;
    }
    // Append prefix wildcard to short terms
    if (usePrefix && token.length < 6) {
      return token + '*';
    }
    return token;
  });

  // Join with OR if mode is OR, otherwise space (implicit AND)
  // Only insert OR between non-operator tokens — preserve existing operators as-is
  if (mode === 'OR') {
    const parts: string[] = [];
    for (let i = 0; i < processed.length; i++) {
      const current = processed[i]!;
      parts.push(current);
      // Insert OR joiner only between two non-operator tokens
      if (i < processed.length - 1) {
        const next = processed[i + 1]!;
        if (!FTS5_OPERATORS.has(current) && !FTS5_OPERATORS.has(next)) {
          parts.push('OR');
        }
      }
    }
    return parts.join(' ');
  }
  return processed.join(' ');
}
