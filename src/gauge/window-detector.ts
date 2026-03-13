/**
 * Auto-detect context window size from model name and observed tokens.
 * Pure function, no IO.
 * @see Architecture Section 7.4
 */

/**
 * Detects whether the context window is 200k (default) or 1M.
 * Returns 1M only for claude-opus-4/claude-sonnet-4 models when observed tokens exceed 195k.
 * Non-throwing (returns 200_000 on error).
 */
export function detectWindowSize(params: { model?: string; observedTokens?: number }): number {
  try {
    const { model, observedTokens } = params;

    if (
      model &&
      observedTokens !== undefined &&
      observedTokens > 195_000
    ) {
      const lower = model.toLowerCase();
      if (lower.startsWith('claude-opus-4') || lower.startsWith('claude-sonnet-4')) {
        return 1_000_000;
      }
    }

    return 200_000;
  } catch {
    return 200_000;
  }
}
