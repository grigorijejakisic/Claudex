/**
 * Decision CRUD with fingerprint-based deduplication.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (decisions table)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export interface DecisionRow {
  id: number;
  session_id: string;
  project: string;
  content: string;
  source: string;
  fingerprint: string;
  timestamp_epoch: number;
  updated_at_epoch: number;
}

/**
 * Inserts a decision with fingerprint dedup (INSERT OR IGNORE on session_id+fingerprint).
 * Returns the inserted row id, or null if duplicate.
 * QUAL-04: project defaults to '__global__' for scope isolation.
 */
export function insertDecision(
  db: Database,
  decision: {
    session_id: string;
    project?: string;
    content: string;
    source: string;
    fingerprint: string;
  }
): number | null {
  const result = cachedPrepare(db,
      `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      decision.session_id,
      decision.project ?? '__global__',
      decision.content,
      decision.source,
      decision.fingerprint
    );

  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

/**
 * Returns all decisions for a session, newest first.
 * Pass opts.limit to cap the result set (default: unlimited).
 */
export function getDecisionsBySession(
  db: Database,
  sessionId: string,
  opts?: { limit?: number }
): DecisionRow[] {
  const limit = opts?.limit;
  if (limit) {
    return cachedPrepare(db,
        `SELECT * FROM decisions WHERE session_id = ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`
      )
      .all(sessionId, limit) as DecisionRow[];
  }
  return cachedPrepare(db,
      `SELECT * FROM decisions WHERE session_id = ?
       ORDER BY timestamp_epoch DESC`
    )
    .all(sessionId) as DecisionRow[];
}

/**
 * Returns all decisions for a project, newest first.
 * QUAL-04: Scoped by project.
 */
export function getDecisionsByProject(
  db: Database,
  project: string
): DecisionRow[] {
  return cachedPrepare(db,
      `SELECT * FROM decisions WHERE project = ?
       ORDER BY timestamp_epoch DESC`
    )
    .all(project) as DecisionRow[];
}

/**
 * Deletes all decisions for a session. Returns count deleted.
 * Used in beforeCompact transaction.
 */
export function resetSessionDecisions(
  db: Database,
  sessionId: string
): number {
  const result = cachedPrepare(db, 'DELETE FROM decisions WHERE session_id = ?')
    .run(sessionId);
  return result.changes;
}
