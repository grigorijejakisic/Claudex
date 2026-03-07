/**
 * CM Adapter — Code Fence Aware Line Iterator
 *
 * Shared utility for iterating over non-empty lines outside
 * code fences. Used by decision-extractor and open-items.
 */

/**
 * Iterate over lines outside code fences.
 * Yields each non-empty, non-fence line with leading whitespace trimmed.
 */
export function* linesOutsideCodeFences(text: string): Generator<{ raw: string; trimmed: string }> {
  const lines = text.split(/\r?\n/);
  let inCodeFence = false;
  for (const raw of lines) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!trimmed) continue;
    yield { raw, trimmed };
  }
}
