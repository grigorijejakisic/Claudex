/**
 * Phase 4.1 process_* salience trigger evaluation.
 *
 * Five candidate triggers (CONTEXT.md lock):
 *   T1. ≥2 corrections in a session
 *   T2. User probe broke a false framing the agent had committed to
 *   T3. Decision spanned ≥3 pivots before resolving
 *   T4. A novel pattern fired that's not yet in the shape vocabulary
 *   T5. Long-form design discussion >30 min, conversation-shaped not action-shaped
 *
 * Rule: 2-of-5 must fire. Max 1 process_* per session. Explicit override flag
 * (set in lesson-proposer.ts when user/agent says "this matters") bypasses
 * the 2-of-5 check but NOT the max-1-per-session rule.
 *
 * Each trigger is evaluated as a boolean. The returned set lists which fired
 * with optional metadata for explainability in the proposer's output.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

export interface TriggerEvaluation {
  fired: boolean;
  detail?: string;
}

export interface ProcessTriggerSet {
  corrections: TriggerEvaluation;
  framing_break: TriggerEvaluation;
  pivots: TriggerEvaluation;
  novel_pattern: TriggerEvaluation;
  long_form: TriggerEvaluation;
  fireCount: number;
}

/**
 * Evaluate the 5 triggers for a session. Reads telemetry from:
 *   - conversation_turns (turn count, duration, content)
 *   - session_events (correction_detected, topic_shift, etc.)
 *   - shape_candidates / shape_vocabulary (T4 novelty check)
 *   - sessions (T5 duration check)
 */
export function evaluateProcessTriggers(db: Database, sessionId: string): ProcessTriggerSet {
  const set: ProcessTriggerSet = {
    corrections: { fired: false },
    framing_break: { fired: false },
    pivots: { fired: false },
    novel_pattern: { fired: false },
    long_form: { fired: false },
    fireCount: 0,
  };

  // T1: ≥2 corrections in session
  try {
    const row = cachedPrepare(db,
      `SELECT COUNT(*) AS cnt FROM session_events
       WHERE session_id = ? AND event_type = 'correction_detected'`,
    ).get(sessionId) as { cnt: number };
    if (row.cnt >= 2) {
      set.corrections.fired = true;
      set.corrections.detail = `${row.cnt} corrections detected`;
    }
  } catch { /* non-fatal */ }

  // T2: user probe broke false framing
  // Heuristic: a topic_shift co-occurring with corrections in the same session.
  // We check both must be present; the temporal proximity is approximated by
  // requiring T1 fired (i.e., corrections happened) AND ≥1 topic_shift event.
  try {
    const row = cachedPrepare(db,
      `SELECT 1 FROM session_events
       WHERE session_id = ? AND event_type = 'topic_shift'
       LIMIT 1`,
    ).get(sessionId);
    if (row && set.corrections.fired) {
      set.framing_break.fired = true;
      set.framing_break.detail = 'topic_shift co-occurred with corrections';
    }
  } catch { /* non-fatal */ }

  // T3: decision spanned ≥3 pivots
  try {
    const row = cachedPrepare(db,
      `SELECT COUNT(*) AS cnt FROM session_events
       WHERE session_id = ? AND event_type = 'topic_shift'`,
    ).get(sessionId) as { cnt: number };
    if (row.cnt >= 3) {
      set.pivots.fired = true;
      set.pivots.detail = `${row.cnt} pivots`;
    }
  } catch { /* non-fatal */ }

  // T4: novel pattern outside the bounded vocabulary
  // Heuristic: shape_candidates rows for this session that don't have a
  // canonical-vocabulary match.
  try {
    const row = cachedPrepare(db,
      `SELECT 1 FROM shape_candidates sc
       LEFT JOIN shape_vocabulary sv ON sv.field = sc.field AND sv.value = sc.value
       WHERE sc.session_id = ? AND sv.value IS NULL
       LIMIT 1`,
    ).get(sessionId);
    if (row) {
      set.novel_pattern.fired = true;
      set.novel_pattern.detail = 'one or more shape candidates not in canonical vocabulary';
    }
  } catch { /* non-fatal */ }

  // T5: long-form design discussion (>30 min, conversation-shaped)
  // Heuristic: session duration > 30 min AND ≥20 turns AND tool_use/turn ratio < 0.5.
  // We approximate tool_use via session_events of any of the action-bearing
  // types (file_edit, file_create, command, build, test_run).
  try {
    const turnCntRow = cachedPrepare(db,
      `SELECT COUNT(*) AS cnt FROM conversation_turns WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number };
    const sessionRow = cachedPrepare(db,
      `SELECT created_at_epoch_ms, ended_at_epoch_ms FROM sessions WHERE session_id = ?`,
    ).get(sessionId) as { created_at_epoch_ms: number; ended_at_epoch_ms: number | null } | undefined;

    if (sessionRow && sessionRow.ended_at_epoch_ms && turnCntRow.cnt >= 20) {
      const durationMin = (sessionRow.ended_at_epoch_ms - sessionRow.created_at_epoch_ms) / 60000;
      const actionRow = cachedPrepare(db,
        `SELECT COUNT(*) AS cnt FROM session_events
         WHERE session_id = ?
           AND event_type IN ('file_edit', 'file_create', 'command', 'build', 'test_run')`,
      ).get(sessionId) as { cnt: number };
      const actionPerTurn = actionRow.cnt / Math.max(1, turnCntRow.cnt);
      if (durationMin > 30 && actionPerTurn < 0.5) {
        set.long_form.fired = true;
        set.long_form.detail = `${durationMin.toFixed(0)}min, ${turnCntRow.cnt} turns, action/turn=${actionPerTurn.toFixed(2)}`;
      }
    }
  } catch { /* non-fatal */ }

  set.fireCount = [
    set.corrections,
    set.framing_break,
    set.pivots,
    set.novel_pattern,
    set.long_form,
  ].filter(t => t.fired).length;

  return set;
}
