/**
 * CM Adapter — Open Items Scanner
 *
 * Ported from OpenClaw Context Manager's open items capture logic.
 * Scans assistant messages for TODO/FIXME/action-needed patterns.
 */

import { appendOpenItem } from './state-files.js';

/**
 * Scan assistant text for open items (TODOs, unchecked checkboxes, action keywords).
 * Writes each found item to the state file, deduped via semantic matching.
 */
export async function scanAndCaptureOpenItems(
  sessionId: string,
  assistantText: string,
): Promise<void> {
  const lines = assistantText.split('\n');
  let inCodeFence = false;

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const isCheckbox = /^\s*-\s*\[\s*\]/.test(line);
    const isBulletOrNumbered = /^[\s]*[-*]|^\s*\d+\./.test(line);
    const hasActionKeyword = /\b(need to|TODO|still need|will check|remaining:|next step|haven't yet|FIXME)\b/i.test(line);
    const isBulletWithAction = isBulletOrNumbered && hasActionKeyword;

    if (isCheckbox || isBulletWithAction) {
      const trimmed = line.trim();
      if (trimmed.length > 150) {
        await appendOpenItem(sessionId, trimmed.slice(0, 147) + '...');
      } else {
        await appendOpenItem(sessionId, trimmed);
      }
    }
  }
}
