/**
 * Phase 4.1 shape vocabulary promotion sweep.
 *
 * Curates the bounded vocabulary that lesson `shape:` fields draw from.
 * Mechanism (CONTEXT.md lock): LLM proposes candidate values when extracting
 * shape from a lesson; candidates that recur in ≥3 distinct sessions are
 * promoted to canonical vocabulary.
 *
 * Cadence: heartbeat. Lightweight aggregate query; O(M) where M = candidate
 * count in shape_candidates table.
 *
 * Tables (Plan 01 V18 migration):
 *   shape_vocabulary(field, value, promoted_at_epoch, promoted_session_count)
 *     PRIMARY KEY (field, value)
 *   shape_candidates(field, value, session_id, project, proposed_at_epoch)
 *     PRIMARY KEY (field, value, session_id)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

const PROMOTION_DENSITY = 3;

/**
 * Record a candidate shape proposal. Idempotent on (field, value, session_id).
 */
export function recordShapeCandidate(
  db: Database,
  field: 'task_shape' | 'failure_mode' | 'solution_pattern',
  value: string,
  sessionId: string,
  project: string,
): void {
  const epochMs = Date.now();
  cachedPrepare(db,
    `INSERT OR IGNORE INTO shape_candidates (field, value, session_id, project, proposed_at_epoch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(field, value, sessionId, project, epochMs);
}

/**
 * Promote candidates with ≥3 distinct sessions to canonical vocabulary.
 *
 * After promotion, candidate rows are NOT deleted (they remain as historical
 * record of which sessions proposed the value). The canonical row is the
 * source of truth for vocabulary lookups.
 *
 * Returns the number of candidates promoted in this pass.
 */
export function promoteShapeVocabulary(db: Database): number {
  const candidates = cachedPrepare(db,
    `SELECT field, value, COUNT(DISTINCT session_id) AS sess_count
     FROM shape_candidates
     GROUP BY field, value
     HAVING sess_count >= ?`,
  ).all(PROMOTION_DENSITY) as Array<{ field: string; value: string; sess_count: number }>;

  let promoted = 0;
  const epochMs = Date.now();
  for (const c of candidates) {
    const exists = cachedPrepare(db,
      'SELECT 1 FROM shape_vocabulary WHERE field = ? AND value = ? LIMIT 1',
    ).get(c.field, c.value);
    if (exists) continue;

    cachedPrepare(db,
      `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES (?, ?, ?, ?)`,
    ).run(c.field, c.value, epochMs, c.sess_count);
    promoted++;
  }
  return promoted;
}
