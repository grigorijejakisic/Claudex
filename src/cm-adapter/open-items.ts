/**
 * CM Adapter — Open Items Scanner
 *
 * Ported from OpenClaw Context Manager's open items capture logic.
 * Scans assistant messages for TODO/FIXME/action-needed patterns.
 */

import { linesOutsideCodeFences } from './code-fence.js';
import { batchAppendOpenItems } from './state-files.js';
import { truncateText } from '../shared/text-utils.js';

const SECRET_PATTERNS = /\b(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36}|password\s*[:=]\s*\S+|token\s*[:=]\s*\S+|secret\s*[:=]\s*\S+)\b/i;

/**
 * Scan assistant text for open items (TODOs, unchecked checkboxes, action keywords).
 * Collects all candidates first, then writes once via batched dedup.
 */
export async function scanAndCaptureOpenItems(
  sessionId: string,
  assistantText: string,
): Promise<void> {
  const candidates: string[] = [];

  for (const { raw, trimmed } of linesOutsideCodeFences(assistantText)) {
    const isCheckbox = /^\s*-\s*\[\s*\]/.test(raw);
    const isBulletOrNumbered = /^[-*]|^\d+\./.test(trimmed);
    const hasActionKeyword = /\b(need to|TODO|still need|will check|remaining:|next step|haven't yet|FIXME)\b/i.test(raw);
    const isBulletWithAction = isBulletOrNumbered && hasActionKeyword;

    if (isCheckbox || isBulletWithAction) {
      const item = truncateText(trimmed, 150);
      candidates.push(item);
    }
  }

  const safeCandidates = candidates.filter(c => !SECRET_PATTERNS.test(c));
  await batchAppendOpenItems(sessionId, safeCandidates);
}
