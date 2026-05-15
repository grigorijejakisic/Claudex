/**
 * Cross-session learnings promotion with dedup and 50-per-project cap.
 */

import type { Database } from 'better-sqlite3';
import { upsertLearning, getLearningsByProject } from '../core/learnings.js';
import { normalizeForDedup, findDuplicate } from './semantic-dedup.js';
import { redactContent } from '../extraction/redaction.js';

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

    // Load all learnings for the project once upfront (avoid N+1 queries)
    let existing = getLearningsByProject(db, project, { limit: 100 });

    for (const learning of sessionLearnings) {
      if (!learning || !learning.trim()) continue;

      // Check for duplicate against pre-fetched list
      const match = findDuplicate(learning, existing);

      if (match) {
        // Phase 7 (MIG-02): all callers of promoteLearnings reach here via
        // captureInsightsAsLearnings, which strips wrapper-tagged content
        // upstream (lifecycle.ts via parseWrappers). Every insight is
        // therefore organic by construction — upsertLearning's default
        // provenance='organic' is correct. Future non-organic-derived callers
        // must set provenance explicitly at THEIR site, not here.
        // Promote existing — upsert with existing fingerprint triggers ON CONFLICT increment
        upsertLearning(db, {
          project,
          agent_id: agent,
          fingerprint: match.fingerprint,
          content: match.content,
        });
        promoted++;
      } else {
        // Insert new — redact content before storage to prevent secret leakage
        const redacted = redactContent(learning);
        const fp = normalizeForDedup(redacted);
        upsertLearning(db, {
          project,
          agent_id: agent,
          fingerprint: fp,
          content: redacted,
        });
        inserted++;
        // Refresh in-memory list so subsequent iterations see the new entry
        existing = [...existing, { content: redacted, fingerprint: fp } as (typeof existing)[number]];
      }
    }

    // Cap enforcement scoped by project only (not per agent_id)
    let pruned = 0;
    const scopedCount = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM learnings WHERE project = ?`
    ).get(project) as { cnt: number }).cnt;
    const excess = scopedCount - MAX_LEARNINGS_PER_PROJECT;

    if (excess > 0) {
      // Delete lowest promotion_count + oldest entries across all agents for this project
      db.prepare(
        `DELETE FROM learnings WHERE id IN (
          SELECT id FROM learnings
          WHERE project = ?
          ORDER BY promotion_count ASC, last_promoted_epoch_ms ASC
          LIMIT ?
        )`
      ).run(project, excess);
      pruned = excess;
    }

    return { promoted, inserted, pruned };
  } catch {
    return { promoted: 0, inserted: 0, pruned: 0 };
  }
}
