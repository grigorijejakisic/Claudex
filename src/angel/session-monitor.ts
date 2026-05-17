/**
 * Angel Session Monitor — detects idle, stuck, and completed sessions.
 *
 * Idle sessions: active sessions with no recent observations.
 * Stuck sessions: active sessions making no progress (repeated errors, loops).
 * Unprocessed sessions: completed sessions the Angel hasn't analyzed yet.
 *
 * A7 (Phase 11): CC's AgentSummary generates 3-5 word status strings every 30s
 * via a forked subagent. These live in CC's in-memory AppState (React component
 * state) — not persisted to disk or DB. Angel (separate process) cannot access
 * them. If CC ever exposes agent summaries via a SubagentStop hook payload or
 * file, Angel should consume them for richer session state awareness.
 *
 * Non-throwing — returns empty arrays/null on error.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { IdleSession, UnprocessedSession } from './types.js';

/**
 * Find active sessions that have been idle (no observations) for longer
 * than the threshold. These are candidates for /endsession reminders.
 */
export function getIdleSessions(
  db: Database,
  idleThresholdSeconds: number,
): IdleSession[] {
  try {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - idleThresholdSeconds;

    const sessions = cachedPrepare(db,
      `SELECT s.session_id, s.project, s.observation_count,
              COALESCE(MAX(o.timestamp_epoch_ms) / 1000, s.created_at_epoch_ms / 1000) AS last_activity_epoch,
              t.topic
       FROM sessions s
       LEFT JOIN observations o ON o.session_id = s.session_id
       LEFT JOIN thread_state t ON t.session_id = s.session_id
       WHERE s.status = 'active'
       GROUP BY s.session_id
       HAVING last_activity_epoch < ?
       ORDER BY last_activity_epoch ASC
       LIMIT 10`
    ).all(cutoff) as Array<{
      session_id: string;
      project: string;
      observation_count: number;
      last_activity_epoch: number;
      topic: string | null;
    }>;

    return sessions.map(s => ({
      ...s,
      idle_minutes: Math.floor((now - s.last_activity_epoch) / 60),
    }));
  } catch {
    return [];
  }
}

/**
 * Find completed sessions that the Angel hasn't processed yet.
 * "Processed" = has an 'angel_processed' session_event.
 *
 * Phase 4 note: the original Site A caller (heartbeat's pattern-extraction
 * loop) was deleted in Plan 04-02 along with its `markSessionProcessed`
 * write. The surviving caller (heartbeat.ts:283) drives directive extraction
 * + curated-context extraction, neither of which currently writes
 * `angel_processed` — meaning the same sessions are returned every tick.
 * Both downstream loops are idempotent (per-session dedup happens inside
 * each subsystem), so the cost is bounded; if Phase 7 retirement removes
 * the legacy table outright, this function and the
 * angel_processed event_type both retire with it.
 */
export function getUnprocessedSessions(
  db: Database,
  limit: number = 5,
): UnprocessedSession[] {
  try {
    const sessions = cachedPrepare(db,
      `SELECT s.session_id, s.project, s.ended_at_epoch_ms,
              t.topic,
              (SELECT COUNT(*) FROM conversation_turns ct WHERE ct.session_id = s.session_id) AS turn_count
       FROM sessions s
       LEFT JOIN thread_state t ON t.session_id = s.session_id
       WHERE s.status = 'completed'
         AND s.ended_at_epoch_ms IS NOT NULL
         AND s.session_id NOT IN (
           SELECT DISTINCT se.session_id FROM session_events se
           WHERE se.event_type = 'angel_processed'
         )
       ORDER BY turn_count DESC, s.ended_at_epoch_ms DESC
       LIMIT ?`
    ).all(limit) as Array<{
      session_id: string;
      project: string;
      ended_at_epoch_ms: number;
      topic: string | null;
      turn_count: number;
    }>;

    return sessions.filter(s => s.turn_count > 0);
  } catch {
    return [];
  }
}

/**
 * Check if the Angel has already sent an idle warning to this session.
 * Prevents duplicate warnings.
 */
export function hasIdleWarning(
  db: Database,
  sessionId: string,
): boolean {
  try {
    const row = cachedPrepare(db,
      `SELECT 1 FROM session_messages
       WHERE target_session = ? AND sender = 'angel' AND message_type = 'advisory'
         AND content LIKE '%idle%'
       LIMIT 1`
    ).get(sessionId);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Find sessions that were warned about being idle but are STILL idle.
 * These sessions need auto-close: the warning was sent but nobody acted on it.
 *
 * Criteria:
 * - Status is 'active'
 * - An idle warning was already sent
 * - Session is still idle (no observations since the warning)
 * - Warning was sent > escalationMinutes ago
 */
export function getEscalatedIdleSessions(
  db: Database,
  escalationMinutes: number = 30,
): Array<{ session_id: string; project: string; idle_minutes: number; topic: string | null }> {
  try {
    const nowMs = Date.now();
    const warningCutoffMs = nowMs - (escalationMinutes * 60000);

    // Find sessions that have an idle warning older than the escalation window
    // AND are still active with no activity since the warning
    const sessions = cachedPrepare(db,
      `SELECT s.session_id, s.project,
              t.topic,
              sm.created_at_epoch_ms AS warning_epoch_ms,
              COALESCE(MAX(o.timestamp_epoch_ms), s.created_at_epoch_ms) AS last_activity_epoch_ms
       FROM sessions s
       INNER JOIN session_messages sm
         ON sm.target_session = s.session_id
         AND sm.sender = 'angel'
         AND sm.message_type = 'advisory'
         AND sm.content LIKE '%idle%'
       LEFT JOIN observations o ON o.session_id = s.session_id
       LEFT JOIN thread_state t ON t.session_id = s.session_id
       WHERE s.status = 'active'
         AND sm.created_at_epoch_ms < ?
       GROUP BY s.session_id
       HAVING last_activity_epoch_ms < sm.created_at_epoch_ms
       ORDER BY last_activity_epoch_ms ASC
       LIMIT 5`
    ).all(warningCutoffMs) as Array<{
      session_id: string;
      project: string;
      topic: string | null;
      warning_epoch_ms: number;
      last_activity_epoch_ms: number;
    }>;

    return sessions.map(s => ({
      session_id: s.session_id,
      project: s.project,
      topic: s.topic,
      idle_minutes: Math.floor((nowMs - s.last_activity_epoch_ms) / 60000),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// A11: Stuck session detection
// ---------------------------------------------------------------------------

export interface StuckResult {
  stuck: boolean;
  reason: string;
}

/**
 * A11 (Phase 11): Detect whether an active session is stuck.
 *
 * "Stuck" differs from "idle" — stuck means the session is ACTIVE but making
 * no progress (repeated errors, looping behavior, all talk no work).
 *
 * Detection signals (bounded to last 20 minutes):
 * 1. Repeated tool failures: 3+ session_events with action containing 'error'/'fail'
 * 2. Looping prompts: 3+ conversation_turns with same first 50 chars of user_text
 * 3. No file progress: 10+ turns but 0 file_edit/file_create events
 *
 * 10-minute debounce: skips if a stuck advisory was already sent recently.
 */
export function detectStuckSession(
  db: Database,
  sessionId: string,
): StuckResult | null {
  try {
    const nowMs = Date.now();

    // Debounce: check for recent stuck advisory (10 min)
    const recentAdvisory = cachedPrepare(db,
      `SELECT 1 FROM session_messages
       WHERE target_session = ? AND sender = 'angel'
         AND content LIKE '%stuck%'
         AND created_at_epoch_ms > ?
       LIMIT 1`
    ).get(sessionId, nowMs - 600000);
    if (recentAdvisory) return null; // Already warned recently

    // Signal 1: Repeated tool failures in last 20 minutes
    const twentyMinAgoMs = nowMs - 1200000;
    const failures = cachedPrepare(db,
      `SELECT action, COUNT(*) as c FROM session_events
       WHERE session_id = ? AND timestamp_epoch_ms > ?
         AND (action LIKE '%error%' OR action LIKE '%fail%')
       GROUP BY action
       HAVING c >= 3
       LIMIT 1`
    ).get(sessionId, twentyMinAgoMs) as { action: string; c: number } | undefined;

    if (failures) {
      return {
        stuck: true,
        reason: `Repeated failures detected: "${failures.action}" occurred ${failures.c} times in last 20 minutes`,
      };
    }

    // Signal 2: Looping prompts — 3+ turns with same first 50 chars
    const recentTurns = cachedPrepare(db,
      `SELECT user_text FROM conversation_turns
       WHERE session_id = ? AND user_text IS NOT NULL
       ORDER BY turn_number DESC
       LIMIT 10`
    ).all(sessionId) as Array<{ user_text: string }>;

    const prefixCounts = new Map<string, number>();
    for (const turn of recentTurns) {
      const prefix = turn.user_text.substring(0, 50).toLowerCase();
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
    for (const [prefix, count] of prefixCounts) {
      if (count >= 3) {
        return {
          stuck: true,
          reason: `Looping detected: similar prompt repeated ${count} times ("${prefix.substring(0, 30)}...")`,
        };
      }
    }

    // Signal 3: No file progress — 10+ turns but 0 file edits/creates
    const turnCount = (cachedPrepare(db,
      `SELECT COUNT(*) as c FROM conversation_turns WHERE session_id = ?`
    ).get(sessionId) as { c: number }).c;

    if (turnCount >= 10) {
      const fileEvents = (cachedPrepare(db,
        `SELECT COUNT(*) as c FROM session_events
         WHERE session_id = ? AND event_type IN ('file_edit', 'file_create')`
      ).get(sessionId) as { c: number }).c;

      if (fileEvents === 0) {
        return {
          stuck: true,
          reason: `No file progress: ${turnCount} turns completed but no files edited or created`,
        };
      }
    }

    return null; // Not stuck
  } catch {
    return null;
  }
}
