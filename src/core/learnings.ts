/**
 * Learnings CRUD with promotion UPSERT semantics.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (learnings table)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export interface LearningRow {
  id: number;
  project: string;
  agent_id: string;
  fingerprint: string;
  content: string;
  promotion_count: number;
  first_seen_epoch: number;
  last_promoted_epoch: number;
  updated_at_epoch: number;
}

/**
 * Inserts a learning or increments promotion_count on duplicate (project+agent_id+fingerprint).
 * Defaults: project='__global__', agent_id='default'.
 */
export function upsertLearning(
  db: Database,
  learning: {
    project?: string;
    agent_id?: string;
    fingerprint: string;
    content: string;
  }
): void {
  cachedPrepare(db,
    `INSERT INTO learnings (project, agent_id, fingerprint, content)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project, agent_id, fingerprint) DO UPDATE SET
       promotion_count = promotion_count + 1,
       last_promoted_epoch = unixepoch(),
       updated_at_epoch = unixepoch()`
  ).run(
    learning.project ?? '__global__',
    learning.agent_id ?? 'default',
    learning.fingerprint,
    learning.content
  );
}

/**
 * Returns learnings for a project (including __global__), ordered by promotion_count DESC.
 * QUAL-04: Scoped by project, includes __global__ for cross-project learnings.
 * Default limit: 50 (per config max_per_project).
 */
export function getLearningsByProject(
  db: Database,
  project: string,
  opts?: { limit?: number }
): LearningRow[] {
  const limit = opts?.limit ?? 50;
  return cachedPrepare(db,
      `SELECT * FROM learnings
       WHERE project = ? OR project = '__global__'
       ORDER BY promotion_count DESC
       LIMIT ?`
    )
    .all(project, limit) as LearningRow[];
}

/**
 * Returns top learnings for assembly injection.
 * Same as getLearningsByProject but defaults to count=10 (per config surface_count).
 */
export function getTopLearnings(
  db: Database,
  project: string,
  count?: number
): LearningRow[] {
  return getLearningsByProject(db, project, { limit: count ?? 10 });
}
