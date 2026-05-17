/**
 * Decision CRUD with fingerprint-based deduplication.
 * Plain functions with `db: Database` as first param.
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
  timestamp_epoch_ms: number;
  updated_at_epoch: number;
}

/**
 * Inserts a decision with fingerprint dedup (INSERT OR IGNORE on session_id+fingerprint).
 * Returns the inserted row id, or null if duplicate.
 * Project defaults to '__global__' for scope isolation.
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
 * Upsert a decision by topic key — evolving decisions stay in one record.
 * If a decision with the same topic_key exists in the project, update its content
 * and bump revision count. Otherwise insert new.
 *
 * Topic key format: "domain/subject" (e.g., "architecture/auth-model", "decision/db-backend").
 * Inspired by Engram's topic key upsert pattern.
 */
export function upsertDecisionByTopic(
  db: Database,
  decision: {
    session_id: string;
    project?: string;
    content: string;
    source: string;
    topic_key: string;
  },
): number {
  try {
    const project = decision.project ?? '__global__';

    // Check if a decision with this topic key exists
    const existing = cachedPrepare(db,
      `SELECT id, content FROM decisions
       WHERE project = ? AND fingerprint = ? LIMIT 1`
    ).get(project, `topic:${decision.topic_key}`) as { id: number; content: string } | undefined;

    if (existing) {
      // Update content, bump updated_at
      cachedPrepare(db,
        `UPDATE decisions SET content = ?, session_id = ?, source = ?,
                updated_at_epoch = unixepoch() WHERE id = ?`
      ).run(decision.content, decision.session_id, decision.source, existing.id);
      return existing.id;
    }

    // Insert new with topic key as fingerprint prefix
    const result = cachedPrepare(db,
      `INSERT INTO decisions (session_id, project, content, source, fingerprint)
       VALUES (?, ?, ?, ?, ?)`
    ).run(decision.session_id, project, decision.content, decision.source, `topic:${decision.topic_key}`);

    return Number(result.lastInsertRowid);
  } catch {
    return 0;
  }
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
  if (limit !== undefined) {
    return cachedPrepare(db,
        `SELECT * FROM decisions WHERE session_id = ?
         ORDER BY timestamp_epoch_ms DESC
         LIMIT ?`
      )
      .all(sessionId, limit) as DecisionRow[];
  }
  return cachedPrepare(db,
      `SELECT * FROM decisions WHERE session_id = ?
       ORDER BY timestamp_epoch_ms DESC`
    )
    .all(sessionId) as DecisionRow[];
}

