/**
 * Correction signal detection and pattern extraction for experience patterns.
 *
 * Extracted from cc-hooks for testability. Both hooks import from here.
 * All functions are non-throwing with safe defaults.
 *
 * Behavioral signal helpers (buildToolSignature) live in behavioral-signals.ts (O25).
 */

import type { ExtractionInput } from './experience-patterns.js';
import { redactContent } from '../extraction/redaction.js';

// ---------------------------------------------------------------------------
// Linguistic correction signal detection (UserPromptSubmit)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the user is correcting a repeated mistake.
 * Regex source: spec experience-patterns.md — TaskWeaver pattern.
 */
export const CORRECTION_PATTERNS = [
  /\b(?:I\s+told\s+you|we\s+(?:already|did\s+this)|same\s+mistake|again\b.*\bwrong)/i,
  /\b(?:remember\s+(?:when|last\s+time)|didn't\s+I\s+say|how\s+many\s+times)/i,
  /\b(?:that's\s+(?:not|wrong)|no[,.]?\s+(?:actually|not\s+that))/i,
  /\b(?:should\s+be\s+remembered|learn\s+from\s+(?:experience|this))/i,
  /\b(?:you\s+keep|stop\s+doing|don't\s+(?:do\s+that|repeat))/i,
];

/**
 * Returns true when the prompt contains a correction signal phrase.
 * Lightweight — regex only, no LLM.
 */
export function detectCorrectionSignal(prompt: string): boolean {
  if (!prompt) return false;
  return CORRECTION_PATTERNS.some(p => p.test(prompt));
}

// ---------------------------------------------------------------------------
// Pattern extraction from assistant text (Stop hook)
// ---------------------------------------------------------------------------

const LESSON_PATTERNS = [
  /(?:the\s+fix\s+is|correct\s+approach\s+is|should\s+(?:have|be)|next\s+time[,\s]+(?:I\s+(?:should|will|need\s+to)))[:\s]+([^.!?\n]{10,200})/i,
  /(?:I\s+(?:should|will|need\s+to)|the\s+correct\s+way)[:\s]+([^.!?\n]{10,200})/i,
  /(?:going\s+forward|from\s+now\s+on)[,:\s]+(?:I\s+(?:should|will|need\s+to)\s+)?([^.!?\n]{10,200})/i,
];

const ANTI_PATTERN_PATTERNS = [
  /(?:the\s+(?:problem|issue|mistake)\s+was|what\s+went\s+wrong[:\s]|I\s+(?:incorrectly|mistakenly|wrongly))[:\s]+([^.!?\n]{10,200})/i,
  /(?:instead\s+of|rather\s+than)[:\s]+([^.!?\n]{10,200})/i,
  /(?:I\s+(?:assumed|thought|overlooked|forgot))[:\s]?([^.!?\n]{10,200})/i,
];

/**
 * Extracts trigger_context, lesson, and anti_pattern from the assistant's
 * response text when a correction was flagged. Uses regex pattern matching
 * against common correction acknowledgement phrases.
 *
 * Returns null if insufficient signal is found to form a quality pattern.
 */
export function extractPatternFromAssistantText(
  assistantText: string,
  userPrompt: string,
): ExtractionInput | null {
  if (!assistantText || assistantText.length < 20) return null;

  let lesson = '';
  let antiPattern = '';

  for (const pat of LESSON_PATTERNS) {
    const m = assistantText.match(pat);
    if (m?.[1]) {
      lesson = m[1].trim();
      break;
    }
  }

  for (const pat of ANTI_PATTERN_PATTERNS) {
    const m = assistantText.match(pat);
    if (m?.[1]) {
      antiPattern = m[1].trim();
      break;
    }
  }

  // Require at least a lesson to create a pattern
  if (!lesson) return null;

  // Derive trigger_context from the user prompt (first 120 chars, cleaned)
  const triggerContext = userPrompt
    .replace(/\b(?:I\s+told\s+you|we\s+already|same\s+mistake|you\s+keep)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  if (triggerContext.length < 5) return null;

  return {
    pattern_type: 'correction',
    trigger_context: redactContent(triggerContext),
    lesson: redactContent(lesson),
    anti_pattern: antiPattern ? redactContent(antiPattern) : undefined,
    severity: 'important',
  };
}
