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

import type { Database } from 'better-sqlite3';
import type { ExtractionInput } from './experience-patterns.js';
import { redactContent } from '../extraction/redaction.js';
import { cachedPrepare } from '../core/stmt-cache.js';

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
  // Contraction-agnostic: "that is wrong", "this is not right", "this is incorrect"
  /\b(?:that\s+is\s+(?:not|wrong)|this\s+is\s+(?:not|wrong|incorrect))/i,
  // "incorrect" variants with contractions
  /\b(?:that(?:'s|\s+is)\s+incorrect)/i,
  // Soft corrections: "no, do X instead", "no, use Y"
  /\b(?:no[,.]?\s+(?:do|use|try)\s)/i,
  // "actually, do X" without "no" prefix
  /\b(?:actually[,.]?\s+(?:do|use|try|it\s+should))\b/i,
  // Contraction gap: "that is not what I asked/wanted"
  /\b(?:that\s+is\s+not\s+what\s+I\s+(?:asked|wanted|meant|said))/i,
  // Standalone line-ending correction: "wrong" / "incorrect"
  /\b(?:wrong|incorrect)[.!]*$/im,
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

// ---------------------------------------------------------------------------
// 3.7 Causal Attribution (LEAFE)
// ---------------------------------------------------------------------------

export interface CausalAttribution {
  event_id: number;
  event_type: string;
  entity: string;
  action: string;
  detail: string | null;
  confidence: number;
}

/**
 * Scans the last N session events before a correction to identify which
 * tool call the user is correcting.
 *
 * Heuristics:
 *   - File path match: if correction text mentions a file that appears in a recent event
 *   - Content overlap: word overlap between correction text and event detail/entity
 *   - Recency bias: more recent events are more likely the cause
 *
 * Returns the most likely causal event, or null if no attribution found.
 * Non-throwing.
 */
export function findCausalEvent(
  db: Database,
  sessionId: string,
  correctionText: string,
  lookback: number = 5,
): CausalAttribution | null {
  try {
    if (!correctionText || correctionText.length < 5) return null;

    // Get the most recent events before the correction
    const events = cachedPrepare(db,
      `SELECT id, event_type, entity, action, detail
       FROM session_events
       WHERE session_id = ?
       ORDER BY timestamp_epoch DESC
       LIMIT ?`
    ).all(sessionId, lookback) as Array<{
      id: number;
      event_type: string;
      entity: string;
      action: string;
      detail: string | null;
    }>;

    if (events.length === 0) return null;

    const correctionLower = correctionText.toLowerCase();
    const correctionWords = new Set(
      correctionLower.split(/[\s_\-/.,;:!?]+/).filter(w => w.length >= 3)
    );

    let bestEvent: typeof events[0] | null = null;
    let bestScore = 0;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      let score = 0;

      // File path match: strongest signal
      if (event.entity) {
        const entityParts = event.entity.toLowerCase().split(/[\\/]/);
        const fileName = entityParts[entityParts.length - 1] ?? '';
        if (fileName && correctionLower.includes(fileName)) {
          score += 3;
        }
        // Partial path match
        if (event.entity.length > 5 && correctionLower.includes(event.entity.toLowerCase())) {
          score += 2;
        }
      }

      // Content overlap: word-level
      const eventText = `${event.entity} ${event.action} ${event.detail ?? ''}`.toLowerCase();
      const eventWords = eventText.split(/[\s_\-/.,;:]+/).filter(w => w.length >= 3);
      let wordOverlap = 0;
      for (const w of eventWords) {
        if (correctionWords.has(w)) wordOverlap++;
      }
      if (eventWords.length > 0) {
        score += (wordOverlap / eventWords.length) * 2;
      }

      // Recency bias: more recent events score slightly higher
      score += (events.length - i) * 0.1;

      // Tool-specific events (file_edit, command) are more likely causes
      if (event.event_type === 'file_edit' || event.event_type === 'command') {
        score += 0.5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestEvent = event;
      }
    }

    // Minimum threshold: require at least some signal
    if (!bestEvent || bestScore < 0.5) return null;

    return {
      event_id: bestEvent.id,
      event_type: bestEvent.event_type,
      entity: bestEvent.entity,
      action: bestEvent.action,
      detail: bestEvent.detail,
      confidence: Math.min(bestScore / 5, 1), // Normalize to 0-1
    };
  } catch {
    return null;
  }
}

/**
 * Stores the causal attribution on an experience pattern.
 * Links the pattern to the session event that caused the correction.
 * Non-throwing.
 */
export function storeCausalAttribution(
  db: Database,
  patternId: string,
  eventId: number,
): void {
  try {
    // Store as JSON in the pattern's root_cause field if not already set,
    // or append causal event info. We use a convention: if root_cause starts
    // with '[event:', it contains causal attribution data.
    const existing = cachedPrepare(db,
      `SELECT root_cause FROM experience_patterns WHERE id = ?`
    ).get(patternId) as { root_cause: string | null } | undefined;

    const causalRef = `[event:${eventId}]`;
    const currentRootCause = existing?.root_cause ?? '';

    // Don't duplicate
    if (currentRootCause.includes(causalRef)) return;

    const newRootCause = currentRootCause
      ? `${currentRootCause} ${causalRef}`
      : causalRef;

    cachedPrepare(db,
      `UPDATE experience_patterns SET root_cause = ? WHERE id = ?`
    ).run(newRootCause, patternId);
  } catch {
    // Non-throwing
  }
}
