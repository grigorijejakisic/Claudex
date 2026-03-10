/**
 * Text utilities with defensive non-throwing pattern (QUAL-01).
 */

/**
 * Truncates text at maxLength, appending "..." if truncated.
 * Returns empty string if input is falsy. Never throws.
 */
export function truncateText(text: string, maxLength: number): string {
  try {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  } catch {
    return '';
  }
}

/**
 * Lowercases, trims, and collapses whitespace.
 * Returns empty string if input is falsy. Never throws.
 */
export function normalize(text: string): string {
  try {
    if (!text) return '';
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

/**
 * Rough token count estimate (chars / 4).
 * Returns 0 on error. Never throws.
 */
export function estimateTokens(text: string): number {
  try {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  } catch {
    return 0;
  }
}
