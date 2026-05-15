/**
 * Learnings CRUD with promotion UPSERT semantics.
 * Plain functions with `db: Database` as first param.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export type LearningProvenance = 'organic' | 'injected' | 'tool_result' | 'environmental';

export interface LearningRow {
  id: number;
  project: string;
  agent_id: string;
  fingerprint: string;
  content: string;
  promotion_count: number;
  first_seen_epoch_ms: number;
  last_promoted_epoch_ms: number;
  updated_at_epoch_ms: number;
  provenance: LearningProvenance;
}

/**
 * Inserts a learning or increments promotion_count on duplicate (project+agent_id+fingerprint).
 * Defaults: project='__global__', agent_id='default', provenance='organic'.
 *
 * Phase 7 (V30 / MIG-02): provenance is the V25 episodic_events closed-enum
 * matched byte-for-byte. The promotion path does NOT overwrite provenance on
 * existing rows — duplicate detection bumps `promotion_count`; the existing
 * row's provenance stays whatever it was. Because Plan 07-03's upstream
 * parseWrappers filter ensures only organic content reaches this function,
 * in practice every row's provenance is 'organic' and the no-overwrite rule
 * is conservative.
 *
 * v5.0.1 hot-fix: shape-agnostic upsert. SQLite forbids
 * `INSERT ... ON CONFLICT ... DO UPDATE` on views (V17-collapsed DBs make
 * `learnings` a view over the `artifact` kernel) — the prior single-statement
 * UPSERT silently failed on every conflict (and after V30 added the
 * `provenance` column to the INSERT, on every row). Manual SELECT →
 * conditional INSERT or UPDATE works against both base-table and view-mode
 * shapes. Two prepared statements both go through stmt-cache; the perf
 * delta is negligible vs the loss-of-data the prior path was costing.
 */
export function upsertLearning(
  db: Database,
  learning: {
    project?: string;
    agent_id?: string;
    fingerprint: string;
    content: string;
    provenance?: LearningProvenance;
  }
): void {
  const project = learning.project ?? '__global__';
  const agent_id = learning.agent_id ?? 'default';
  const provenance = learning.provenance ?? 'organic';

  const existing = cachedPrepare(db,
    `SELECT id FROM learnings
     WHERE project = ? AND agent_id = ? AND fingerprint = ?
     LIMIT 1`
  ).get(project, agent_id, learning.fingerprint) as { id: number } | undefined;

  if (existing) {
    cachedPrepare(db,
      `UPDATE learnings SET
         promotion_count = promotion_count + 1,
         last_promoted_epoch_ms = (unixepoch() * 1000),
         updated_at_epoch_ms = (unixepoch() * 1000)
       WHERE id = ?`
    ).run(existing.id);
    return;
  }

  cachedPrepare(db,
    `INSERT INTO learnings (project, agent_id, fingerprint, content, provenance)
     VALUES (?, ?, ?, ?, ?)`
  ).run(project, agent_id, learning.fingerprint, learning.content, provenance);
}

/**
 * Returns learnings for a project (including __global__), ordered by promotion_count DESC.
 * Scoped by project, includes __global__ for cross-project learnings.
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
       ORDER BY promotion_count DESC, id ASC
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
