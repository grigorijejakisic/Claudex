/**
 * Correction signal detection and pattern extraction for experience patterns.
 *
 * Two extraction paths (Meta-Policy Reflexion / ExpeL inspired):
 *   1. PRIMARY: Extract from the USER's correction text — the user literally
 *      states the lesson ("always use X", "never do Y"). Most reliable source.
 *   2. SUPPLEMENTARY: Extract from the ASSISTANT's response — self-reflective
 *      phrases ("the fix is...", "going forward..."). Fires when the assistant
 *      acknowledges the mistake in structured language.
 *
 * The user correction is the primary source because:
 * - Users state lessons in natural imperative language ("always", "never")
 * - Users state anti-patterns implicitly ("not X", "stop doing X")
 * - Emotional intensity signals severity ("I TOLD YOU" = repeated mistake)
 * - Assistant responses are often practical, not self-reflective
 *
 * All functions are non-throwing with safe defaults.
 */

import type { ExtractionInput } from './experience-patterns.js';
import { redactContent } from '../extraction/redaction.js';

// ---------------------------------------------------------------------------
// Linguistic correction signal detection (UserPromptSubmit)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the user is correcting a repeated mistake.
 */
export const CORRECTION_PATTERNS = [
  /\b(?:I\s+told\s+you|we\s+(?:already|did\s+this)|same\s+mistake|again\b.*\bwrong)/i,
  /\b(?:remember\s+(?:when|last\s+time)|didn't\s+I\s+say|how\s+many\s+times)/i,
  /\b(?:that's\s+(?:not|wrong)|no[,.]?\s+(?:actually|not\s+that))/i,
  /\b(?:should\s+be\s+remembered|learn\s+from\s+(?:experience|this))/i,
  /\b(?:you\s+keep|stop\s+doing|don't\s+(?:do\s+that|repeat))/i,
];

/** Patterns indicating escalated severity — user has corrected this before. */
const ESCALATION_PATTERNS = [
  /\b(?:I\s+told\s+you|how\s+many\s+times|same\s+mistake|again\b.*\bwrong|you\s+keep)/i,
  /\b(?:didn't\s+I\s+say|we\s+(?:already|did\s+this))/i,
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
// PRIMARY: Extract lesson from USER's correction text
// ---------------------------------------------------------------------------

/** Patterns where the user states what SHOULD happen (the lesson). */
const USER_LESSON_PATTERNS = [
  // "always use X", "we always X"
  /\b(?:always|must\s+always)\s+(?:use\s+)?([^.!?\n]{5,150})/i,
  // "just use X", "just do X"
  /\b(?:just\s+(?:use|do|run|set|switch))\s+([^.!?\n]{5,150})/i,
  // "use X instead", "do X instead"
  /\b(?:use|do|set|switch\s+to)\s+([^.!?\n]{5,100})\s+instead/i,
  // "the answer is always X", "it should be X"
  /\b(?:the\s+answer\s+is\s+(?:always\s+)?|it\s+should\s+(?:always\s+)?be\s+)([^.!?\n]{5,150})/i,
  // "we use X" (declarative statement of policy)
  /\bwe\s+(?:only\s+)?(?:use|do|run|have)\s+([^.!?\n]{5,150})/i,
];

/** Patterns where the user states what should NOT happen (the anti-pattern). */
const USER_ANTI_PATTERNS = [
  // "never X", "NEVER do X" — stop at comma, period, or exclamation
  /\b(?:never|don't\s+ever)\s+(?:use\s+|do\s+|suggest\s+|ask\s+(?:about\s+)?)?([^.!?,;\n]{3,150})/i,
  // "not X", "not that way"
  /\bnot\s+(?:that|this|the)\s+([^.!?,;\n]{3,100})/i,
  // "stop doing X", "stop suggesting X"
  /\bstop\s+(?:doing\s+|suggesting\s+|asking\s+(?:about\s+)?)?([^.!?,;\n]{3,150})/i,
];

/**
 * Extracts a structured lesson from the USER's correction text.
 *
 * This is the PRIMARY extraction path. When a user corrects the agent,
 * they naturally state the lesson in imperative form:
 *   "we always use oauth! NEVER API KEY!"
 *   → lesson: "use oauth", anti_pattern: "API KEY"
 *
 * The user's correction text is the most reliable source because users
 * state exactly what should and shouldn't happen.
 *
 * Returns null if no extractable lesson is found.
 * Non-throwing.
 */
export function extractLessonFromUserCorrection(
  userPrompt: string,
): ExtractionInput | null {
  if (!userPrompt || userPrompt.length < 10) return null;

  try {
    // Cap input to prevent regex backtracking on adversarial/very long input
    const input = userPrompt.slice(0, 500);
    let lesson = '';
    let antiPattern = '';

    // Extract lesson (what SHOULD happen)
    for (const pat of USER_LESSON_PATTERNS) {
      const m = input.match(pat);
      if (m?.[1]) {
        lesson = m[1].trim();
        // Clean trailing punctuation and correction noise
        lesson = lesson.replace(/[!]+$/, '').replace(/\s+/g, ' ').trim();
        if (lesson.length >= 5) break;
        lesson = '';
      }
    }

    // Extract anti-pattern (what should NOT happen)
    for (const pat of USER_ANTI_PATTERNS) {
      const m = input.match(pat);
      if (m?.[1]) {
        antiPattern = m[1].trim();
        antiPattern = antiPattern.replace(/[!]+$/, '').replace(/\s+/g, ' ').trim();
        if (antiPattern.length >= 3) break;
        antiPattern = '';
      }
    }

    // Need at least a lesson OR an anti-pattern to create something useful
    if (!lesson && !antiPattern) return null;

    // If we only have an anti-pattern, derive lesson as "avoid <anti-pattern>"
    if (!lesson && antiPattern) {
      lesson = `avoid ${antiPattern}`;
    }

    // Derive trigger_context: strip correction signal phrases, keep topic
    const triggerContext = userPrompt
      .replace(/\b(?:I\s+told\s+you|we\s+already|same\s+mistake|you\s+keep|how\s+many\s+times|didn't\s+I\s+say|that's\s+(?:not|wrong)|no[,.]?\s+actually)\b/gi, '')
      .replace(/[!?]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

    if (triggerContext.length < 5) return null;

    // Severity: escalated if user indicates this is a repeated correction
    const isEscalated = ESCALATION_PATTERNS.some(p => p.test(input));

    return {
      pattern_type: 'correction',
      trigger_context: redactContent(triggerContext),
      lesson: redactContent(lesson),
      anti_pattern: antiPattern ? redactContent(antiPattern) : undefined,
      severity: isEscalated ? 'critical' : 'important',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SUPPLEMENTARY: Extract lesson from ASSISTANT's response text
// ---------------------------------------------------------------------------

const ASSISTANT_LESSON_PATTERNS = [
  /(?:the\s+fix\s+is|correct\s+approach\s+is|should\s+(?:have|be)|next\s+time[,\s]+(?:I\s+(?:should|will|need\s+to)))[:\s]+([^.!?\n]{10,200})/i,
  /(?:I\s+(?:should|will|need\s+to)|the\s+correct\s+way)[:\s]+([^.!?\n]{10,200})/i,
  /(?:going\s+forward|from\s+now\s+on)[,:\s]+(?:I\s+(?:should|will|need\s+to)\s+)?([^.!?\n]{10,200})/i,
];

const ASSISTANT_ANTI_PATTERNS = [
  /(?:the\s+(?:problem|issue|mistake)\s+was|what\s+went\s+wrong[:\s]|I\s+(?:incorrectly|mistakenly|wrongly))[:\s]+([^.!?\n]{10,200})/i,
  /(?:instead\s+of|rather\s+than)[:\s]+([^.!?\n]{10,200})/i,
  /(?:I\s+(?:assumed|thought|overlooked|forgot))[:\s]?([^.!?\n]{10,200})/i,
];

/**
 * Extracts trigger_context, lesson, and anti_pattern from the assistant's
 * response text. SUPPLEMENTARY path — fires when the assistant acknowledges
 * the mistake in structured self-reflective language.
 *
 * Returns null if no structured acknowledgement is found.
 * Non-throwing.
 */
export function extractPatternFromAssistantText(
  assistantText: string,
  userPrompt: string,
): ExtractionInput | null {
  if (!assistantText || assistantText.length < 20) return null;

  try {
    let lesson = '';
    let antiPattern = '';

    for (const pat of ASSISTANT_LESSON_PATTERNS) {
      const m = assistantText.match(pat);
      if (m?.[1]) {
        lesson = m[1].trim();
        break;
      }
    }

    for (const pat of ASSISTANT_ANTI_PATTERNS) {
      const m = assistantText.match(pat);
      if (m?.[1]) {
        antiPattern = m[1].trim();
        break;
      }
    }

    if (!lesson) return null;

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
  } catch {
    return null;
  }
}
