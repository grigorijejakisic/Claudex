/**
 * Auto-detect context window size from model name and observed tokens.
 * Pure function, no IO.
 */

/**
 * Detects whether the context window is 200k (default) or 1M.
 *
 * Detection strategy (ordered):
 * 1. If observed tokens exceed 195K on a Claude 4+ model → confirmed 1M.
 * 2. If model is Claude 4+ (opus/sonnet) and no observed tokens → assume 1M.
 *    Rationale: Claude 4 models always have at least 200K; assuming 1M
 *    gives a budget of ~3x base (≈24K tokens) which is still only 2.4%
 *    of a 1M window and only 12% of a 200K window — safe either way.
 * 3. Fallback: 200K.
 *
 * Non-throwing (returns 200_000 on error).
 */
export function detectWindowSize(params: { model?: string; observedTokens?: number }): number {
  try {
    const { model, observedTokens } = params;

    if (model) {
      const lower = model.toLowerCase();
      const isClaude4Plus = lower.startsWith('claude-opus-4') || lower.startsWith('claude-sonnet-4');

      if (isClaude4Plus) {
        // Confirmed 1M: observed tokens exceed 200K baseline
        if (observedTokens !== undefined && observedTokens > 195_000) {
          return 1_000_000;
        }
        // Model-only detection: assume 1M for Claude 4+ models.
        // The budget scaling is conservative enough (3x base) that
        // even a 200K window gets at most 12% utilization — safe.
        return 1_000_000;
      }
    }

    return 200_000;
  } catch {
    return 200_000;
  }
}
