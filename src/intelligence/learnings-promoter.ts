/**
 * Cross-session learnings promotion with dedup and 50-per-project cap.
 * @see Architecture Section 6.5
 */

import type { Database } from 'better-sqlite3';
import { upsertLearning, getLearningsByProject } from '../core/learnings.js';
import { normalizeForDedup, findDuplicate } from './semantic-dedup.js';

const MAX_LEARNINGS_PER_PROJECT = 50;

/**
 * Promotes session learnings into the cross-session learnings store.
 * - Deduplicates via semantic-dedup findDuplicate
 * - Duplicates promote existing entries (increment promotion_count)
 * - New learnings inserted with promotion_count = 1
 * - Enforces 50-per-project cap by pruning lowest-promoted, oldest entries
 * Non-throwing.
 */
export function promoteLearnings(params: {
  db: Database;
  project: string;
  agentId?: string;
  sessionLearnings: string[];
}): { promoted: number; inserted: number; pruned: number } {
  try {
    const { db, project, agentId, sessionLearnings } = params;
    const agent = agentId ?? 'default';
    let promoted = 0;
    let inserted = 0;

    for (const learning of sessionLearnings) {
      if (!learning || !learning.trim()) continue;

      // Get existing learnings for dedup
      const existing = getLearningsByProject(db, project, { limit: 100 });

      // Check for duplicate
      const match = findDuplicate(learning, existing);

      if (match) {
        // Promote existing — upsert with existing fingerprint triggers ON CONFLICT increment
        upsertLearning(db, {
          project,
          agent_id: agent,
          fingerprint: match.fingerprint,
          content: match.content,
        });
        promoted++;
      } else {
        // Insert new
        upsertLearning(db, {
          project,
          agent_id: agent,
          fingerprint: normalizeForDedup(learning),
          content: learning,
        });
        inserted++;
      }
    }

    // Cap enforcement — count and prune from the same scope (project + agent_id)
    let pruned = 0;
    const scopedCount = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM learnings WHERE project = ? AND agent_id = ?`
    ).get(project, agent) as { cnt: number }).cnt;
    const excess = scopedCount - MAX_LEARNINGS_PER_PROJECT;

    if (excess > 0) {
      // Delete lowest promotion_count + oldest entries
      db.prepare(
        `DELETE FROM learnings WHERE id IN (
          SELECT id FROM learnings
          WHERE project = ? AND agent_id = ?
          ORDER BY promotion_count ASC, last_promoted_epoch ASC
          LIMIT ?
        )`
      ).run(project, agent, excess);
      pruned = excess;
    }

    return { promoted, inserted, pruned };
  } catch {
    return { promoted: 0, inserted: 0, pruned: 0 };
  }
}
