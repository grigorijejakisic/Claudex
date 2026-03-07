/**
 * CM Adapter — Learning Fingerprint Normalization
 *
 * Canonical fingerprint used for learning dedup by both
 * in-session (state-files) and cross-session (learnings) paths.
 */

/**
 * Canonical fingerprint normalization for learning dedup.
 * Used by both in-session (state-files) and cross-session (learnings) paths.
 */
export function normalizeLearningFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\s\-*\u2022.]+/, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
