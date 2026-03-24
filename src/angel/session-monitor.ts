/**
 * Angel Session Monitor — detects idle and completed sessions.
 *
 * Idle sessions: active sessions with no recent observations.
 * Unprocessed sessions: completed sessions the Angel hasn't analyzed yet.
 *
 * Non-throwing — returns empty arrays on error.
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
              COALESCE(MAX(o.timestamp_epoch), s.created_at_epoch) AS last_activity_epoch,
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
 */
export function getUnprocessedSessions(
  db: Database,
  limit: number = 5,
): UnprocessedSession[] {
  try {
    const sessions = cachedPrepare(db,
      `SELECT s.session_id, s.project, s.ended_at_epoch,
              t.topic,
              (SELECT COUNT(*) FROM conversation_turns ct WHERE ct.session_id = s.session_id) AS turn_count
       FROM sessions s
       LEFT JOIN thread_state t ON t.session_id = s.session_id
       WHERE s.status = 'completed'
         AND s.ended_at_epoch IS NOT NULL
         AND s.session_id NOT IN (
           SELECT DISTINCT se.session_id FROM session_events se
           WHERE se.event_type = 'angel_processed'
         )
       ORDER BY s.ended_at_epoch DESC
       LIMIT ?`
    ).all(limit) as Array<{
      session_id: string;
      project: string;
      ended_at_epoch: number;
      topic: string | null;
      turn_count: number;
    }>;

    return sessions.filter(s => s.turn_count > 0);
  } catch {
    return [];
  }
}

/**
 * Mark a session as processed by the Angel.
 * Records an 'angel_processed' session_event.
 */
export function markSessionProcessed(
  db: Database,
  sessionId: string,
  project: string,
  detail?: string,
): void {
  try {
    cachedPrepare(db,
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
       VALUES (?, ?, 'angel_processed', 'angel', 'processed', ?)`
    ).run(sessionId, project, detail ?? null);
  } catch {
    // Non-throwing
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
