/**
 * Linguistic correction-signal detection.
 *
 * Surfaces "user is correcting" linguistic markers from a user prompt
 * (e.g., "no, that's not right", "stop doing X"). The detection is read-only —
 * it does NOT create new patterns. Pattern creation was deleted in Phase 4
 * (see .planning/reframes/2026-05-05-multi-handle-kill.md). The surviving
 * downstream uses are: hook-side score feedback (scores existing patterns)
 * and causal attribution (links a session event to a previously-created
 * pattern when one exists).
 *
 * All functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
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

/**
 * Returns true when the prompt contains a correction signal phrase.
 * Lightweight — regex only, no LLM.
 */
export function detectCorrectionSignal(prompt: string): boolean {
  if (!prompt) return false;
  return CORRECTION_PATTERNS.some(p => p.test(prompt));
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

    // Minimum threshold: require textual overlap (not just bonus-only crossing)
    // and overall score >= 0.5
    if (!bestEvent || bestScore < 0.5) return null;
    // Guard against false positives: if score is entirely from bonuses
    // (recency + event-type) with zero word overlap, reject the match
    const hasTextualEvidence = correctionWords.size > 0 && events.some(e => {
      const eWords = (e.entity + ' ' + (e.detail ?? '')).toLowerCase().split(/\s+/);
      return eWords.some(w => correctionWords.has(w));
    });
    if (!hasTextualEvidence) return null;

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
