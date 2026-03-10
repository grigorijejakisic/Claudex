/**
 * Session lifecycle CRUD — create, query, end, and observation counting.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (sessions table)
 */

import type { Database } from 'better-sqlite3';

export interface SessionRow {
  session_id: string;
  scope: string | null;
  project: string | null;
  cwd: string | null;
  source: string | null;
  status: string;
  observation_count: number;
  created_at_epoch: number;
  ended_at_epoch: number | null;
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
  }
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, scope, project, cwd, source)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    session.session_id,
    session.scope ?? null,
    session.project ?? null,
    session.cwd ?? null,
    session.source ?? null
  );
}

/**
 * Retrieves a session by its ID.
 */
export function getSession(
  db: Database,
  sessionId: string
): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
    | SessionRow
    | undefined;
}

/**
 * Ends a session by updating its status and setting ended_at_epoch.
 */
export function endSession(
  db: Database,
  sessionId: string,
  status: 'completed' | 'failed'
): void {
  db.prepare(
    `UPDATE sessions SET status = ?, ended_at_epoch = unixepoch()
     WHERE session_id = ?`
  ).run(status, sessionId);
}

/**
 * Returns the most recent active session, optionally filtered by project.
 * QUAL-04: Filters by project scope when provided.
 */
export function getActiveSession(
  db: Database,
  project?: string
): SessionRow | undefined {
  if (project) {
    return db
      .prepare(
        `SELECT * FROM sessions
         WHERE status = 'active' AND project = ?
         ORDER BY created_at_epoch DESC LIMIT 1`
      )
      .get(project) as SessionRow | undefined;
  }
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE status = 'active'
       ORDER BY created_at_epoch DESC LIMIT 1`
    )
    .get() as SessionRow | undefined;
}

/**
 * Increments the observation count for a session.
 */
export function incrementObservationCount(
  db: Database,
  sessionId: string
): void {
  db.prepare(
    `UPDATE sessions SET observation_count = observation_count + 1
     WHERE session_id = ?`
  ).run(sessionId);
}
