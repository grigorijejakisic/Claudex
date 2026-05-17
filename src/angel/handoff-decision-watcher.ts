/**
 * Phase 14-07l — Continuous Handoff Refresh (CHR) watcher.
 *
 * Per-turn boundary detection orchestration:
 *   1. Check CLAUDEX_CHR_DISABLED env — bail early if set.
 *   2. Check throttle (handoff_refresh_state table; 60s cooldown per session).
 *   3. Call classifyDecisionBoundary (Ollama; hook-safe).
 *   4. If confidence ≥ 0.5 and is_decision_boundary: call recordDecisionShift,
 *      update throttle state, emit telemetry.
 *   5. If confidence ≥ 0.85: also emit a session message to operator.
 *   6. Emit chr_boundary_detected or chr_no_boundary telemetry on every path.
 *
 * Non-throwing contract: catch all paths; failures emit chr_classify_failed.
 *
 * Called from stop.ts per turn (non-blocking from hook perspective).
 */

import type { Database } from 'better-sqlite3';
import { classifyDecisionBoundary } from '../intelligence/directive-detector.js';
import { recordDecisionShift } from './handoff-writer.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WatcherContext {
  db: Database;
  project: string;
  session_id: string;
  user_text: string | null;
  assistant_text: string;
  source_turn_uuid: string;
}

export interface WatcherResult {
  refreshed: boolean;
  throttled: boolean;
  boundary_type: string | null;
}

// ---------------------------------------------------------------------------
// Throttle state helpers
// ---------------------------------------------------------------------------

/** Default cooldown window in ms. */
const DEFAULT_COOLDOWN_MS = 60_000;

interface ThrottleRow {
  last_refresh_epoch_ms: number;
  refresh_count: number;
}

/**
 * Load the throttle state for a session from handoff_refresh_state.
 * Returns null if no row exists (never refreshed).
 * Non-throwing.
 */
export function getThrottleState(db: Database, sessionId: string): ThrottleRow | null {
  try {
    const row = db.prepare(
      `SELECT last_refresh_epoch_ms, refresh_count
       FROM handoff_refresh_state
       WHERE session_id = ?`,
    ).get(sessionId) as ThrottleRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert throttle state for session: set last_refresh_epoch_ms = now, increment refresh_count.
 * Non-throwing.
 */
export function updateThrottleState(db: Database, sessionId: string, project: string): void {
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO handoff_refresh_state (session_id, project, last_refresh_epoch_ms, refresh_count, updated_at_epoch_ms)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_refresh_epoch_ms = excluded.last_refresh_epoch_ms,
         refresh_count = refresh_count + 1,
         updated_at_epoch_ms = excluded.updated_at_epoch_ms`,
    ).run(sessionId, project, now, now);
  } catch {
    // Non-fatal: throttle failure is not a hard error.
  }
}

/**
 * Returns true if the session is within the cooldown window.
 * Returns false (not throttled) on any DB error — fail-open is safer than fail-closed.
 */
export function isThrottled(db: Database, sessionId: string, cooldown_ms = DEFAULT_COOLDOWN_MS): boolean {
  try {
    const state = getThrottleState(db, sessionId);
    if (!state) return false;
    return (Date.now() - state.last_refresh_epoch_ms) < cooldown_ms;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Telemetry helper
// ---------------------------------------------------------------------------

type ChrEventKind =
  | 'chr_boundary_detected'
  | 'chr_no_boundary'
  | 'chr_classify_failed'
  | 'chr_throttled';

/**
 * Emit a CHR telemetry event. Non-throwing; direct INSERT to bypass the
 * typed EventKindDetailMap (new event kinds not yet in the map — same pattern
 * as handoff_parse_failed in Plan 14-01).
 */
function emitChrTelemetry(
  db: Database,
  sessionId: string,
  eventKind: ChrEventKind,
  detail: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, ?, ?, ?)`,
    ).run(sessionId, eventKind, JSON.stringify(detail), '14-07l-chr');
  } catch {
    // Swallow — telemetry must never break the caller.
  }
}

// ---------------------------------------------------------------------------
// Session message helper
// ---------------------------------------------------------------------------

/**
 * Emit a session message to the operator when confidence ≥ 0.85.
 * Uses the session_messages table (Angel's message bus).
 * Non-throwing.
 *
 * The session_messages schema uses:
 *   target_session TEXT — the recipient session
 *   sender TEXT — who sent it
 *   content TEXT — message body
 *   message_type TEXT — 'advisory' for CHR notifications
 */
function emitOperatorMessage(db: Database, sessionId: string, summary: string): void {
  try {
    db.prepare(
      `INSERT INTO session_messages (
         target_session, sender, content, message_type, priority
       ) VALUES (?, 'chr-system', ?, 'advisory', 'normal')`,
    ).run(
      sessionId,
      `Handoff refreshed: ${summary}`,
    );
  } catch {
    // Non-fatal: if session_messages table doesn't exist or schema differs, skip.
  }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Phase 14-07l: Per-turn boundary detection + handoff refresh.
 *
 * Called from stop hook. Non-throwing on all paths.
 */
export async function classifyTurnAsDecisionBoundary(
  ctx: WatcherContext,
): Promise<WatcherResult> {
  const noop: WatcherResult = { refreshed: false, throttled: false, boundary_type: null };

  // 1. Operator disable env.
  if (process.env['CLAUDEX_CHR_DISABLED'] === '1') {
    return noop;
  }

  try {
    // 2. Throttle check.
    if (isThrottled(ctx.db, ctx.session_id, DEFAULT_COOLDOWN_MS)) {
      emitChrTelemetry(ctx.db, ctx.session_id, 'chr_throttled', {
        session_id: ctx.session_id,
        project: ctx.project,
        source_turn_uuid: ctx.source_turn_uuid,
      });
      return { refreshed: false, throttled: true, boundary_type: null };
    }

    // 3. Classify the turn.
    const classification = await classifyDecisionBoundary({
      user_text: ctx.user_text,
      assistant_text: ctx.assistant_text,
    });

    // 4. Handle classification failure.
    if (classification === null) {
      emitChrTelemetry(ctx.db, ctx.session_id, 'chr_classify_failed', {
        session_id: ctx.session_id,
        project: ctx.project,
        source_turn_uuid: ctx.source_turn_uuid,
        reason: 'llm_null_response',
      });
      return noop;
    }

    // 5. Confidence floor and boundary gate.
    const { is_decision_boundary, boundary_type, summary, confidence } = classification;

    if (!is_decision_boundary || confidence < 0.5) {
      emitChrTelemetry(ctx.db, ctx.session_id, 'chr_no_boundary', {
        session_id: ctx.session_id,
        project: ctx.project,
        is_boundary: is_decision_boundary,
        boundary_type: boundary_type ?? null,
        confidence,
        throttled: false,
        refreshed: false,
        source_turn_uuid: ctx.source_turn_uuid,
      });
      return noop;
    }

    // 6. Boundary detected with confidence ≥ 0.5 — refresh handoff.
    const refreshResult = recordDecisionShift({
      db: ctx.db,
      project: ctx.project,
      boundary_type: boundary_type!,
      summary: summary ?? `${boundary_type} detected`,
      source_turn_uuid: ctx.source_turn_uuid,
      session_id: ctx.session_id,
    });

    // 7. Update throttle state.
    updateThrottleState(ctx.db, ctx.session_id, ctx.project);

    // 8. High-confidence operator notification.
    if (confidence >= 0.85 && summary) {
      emitOperatorMessage(ctx.db, ctx.session_id, summary);
    }

    // 9. Emit full telemetry.
    emitChrTelemetry(ctx.db, ctx.session_id, 'chr_boundary_detected', {
      session_id: ctx.session_id,
      project: ctx.project,
      is_boundary: true,
      boundary_type,
      confidence,
      summary: summary ?? null,
      throttled: false,
      refreshed: refreshResult.refreshed,
      source_turn_uuid: ctx.source_turn_uuid,
    });

    return {
      refreshed: refreshResult.refreshed,
      throttled: false,
      boundary_type,
    };
  } catch {
    // Non-throwing contract: any uncaught error becomes a silent no-op.
    return noop;
  }
}
