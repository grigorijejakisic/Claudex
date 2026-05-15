/**
 * Session lifecycle CRUD — create, query, end, and observation counting.
 * Plain functions with `db: Database` as first param.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export interface SessionRow {
  session_id: string;
  scope: string | null;
  project: string | null;
  cwd: string | null;
  source: string | null;
  adapter: string;
  status: string;
  observation_count: number;
  created_at_epoch_ms: number;
  ended_at_epoch_ms: number | null;
}

/**
 * Creates a new session record.
 */
export function createSession(
  db: Database,
  session: {
    session_id: string;
    scope?: string;
    project?: string;
    cwd?: string;
    source?: string;
    adapter?: string;
  }
): void {
  cachedPrepare(db,
    `INSERT INTO sessions (session_id, scope, project, cwd, source, adapter)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    session.session_id,
    session.scope ?? 'unknown',
    session.project ?? '__global__',
    session.cwd ?? '.',
    session.source ?? 'unknown',
    session.adapter ?? 'unknown'
  );
}

/**
 * Ends a session by updating its status and setting ended_at_epoch_ms (ms-precision).
 *
 * @deprecated Phase 14 Plan 14-05: use `promoteSessionToCompleted` from
 * `src/angel/boundary/boundary-detector.ts` for status='completed' transitions.
 * That function fires the ordered end-of-session action chain with per-action
 * telemetry. `endSession` is retained for the status='failed' path only until
 * callers are migrated. No production callers currently use status='completed'.
 */
export function endSession(
  db: Database,
  sessionId: string,
  status: 'completed' | 'failed'
): void {
  cachedPrepare(db,
    `UPDATE sessions SET status = ?, ended_at_epoch_ms = (unixepoch() * 1000)
     WHERE session_id = ?`
  ).run(status, sessionId);
}


