/**
 * Cross-Project Knowledge Consolidator — deduplicates and propagates knowledge
 * across project boundaries using the __global__ scope.
 *
 * Pure SQL, zero LLM cost. All dedup is exact-match on fingerprints that already
 * exist in the DB.
 *
 * Four phases:
 *   1. deduplicateLearnings  — merge identical-fingerprint learnings into __global__
 *   2. deduplicateDecisions  — keep newest copy of duplicate-fingerprint decisions
 *   3. deduplicatePatterns   — merge patterns with identical trigger_context across projects
 *   4. propagateLearnings    — promote highly-proven learnings (promotion_count >= 5) to __global__
 *
 * Non-throwing — every function returns 0 on error. Runs at most once per
 * sweepIntervalMinutes (default 60 min).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { GLOBAL_PROJECT_SCOPE } from '../shared/constants.js';
import type { CrossProjectResult, RetentionConfig } from './types.js';
import { ulid } from 'ulid';

// ---------------------------------------------------------------------------
// Module-level rate limit
// ---------------------------------------------------------------------------

/** Epoch (seconds) of the last consolidation run. 0 = never run. */
let _lastConsolidationEpoch = 0;

/** Reset rate limit state (for testing). */
export function resetConsolidationRateLimit(): void {
  _lastConsolidationEpoch = 0;
}

// ---------------------------------------------------------------------------
// Phase 1: Deduplicate learnings
// ---------------------------------------------------------------------------

/**
 * Find learnings with identical fingerprints across 2+ projects (excluding __global__),
 * merge them into a single __global__ record, then delete the per-project copies.
 *
 * Schema columns used: id, project, agent_id, fingerprint, content,
 * promotion_count, first_seen_epoch, last_promoted_epoch, updated_at_epoch
 *
 * Returns the number of fingerprint groups consolidated.
 */
export function deduplicateLearnings(db: Database): number {
  try {
    // Find fingerprints that appear in 2+ different non-global projects
    const duplicates = cachedPrepare(db, `
      SELECT fingerprint,
             GROUP_CONCAT(DISTINCT project) AS projects,
             COUNT(DISTINCT project)        AS project_count,
             SUM(promotion_count)           AS total_promos,
             MAX(updated_at_epoch)          AS newest_update
      FROM learnings
      WHERE project != ?
      GROUP BY fingerprint
      HAVING project_count >= 2
      LIMIT 20
    `).all(GLOBAL_PROJECT_SCOPE) as Array<{
      fingerprint: string;
      projects: string;
      project_count: number;
      total_promos: number;
      newest_update: number;
    }>;

    if (duplicates.length === 0) return 0;

    let consolidated = 0;

    const txn = db.transaction((rows: typeof duplicates) => {
      for (const row of rows) {
        try {
          // Check whether a __global__ version already exists
          const existing = cachedPrepare(db,
            `SELECT id FROM learnings WHERE project = ? AND fingerprint = ? LIMIT 1`
          ).get(GLOBAL_PROJECT_SCOPE, row.fingerprint) as { id: number } | undefined;

          if (!existing) {
            // Fetch the content from the newest per-project copy
            const newest = cachedPrepare(db,
              `SELECT content, agent_id, first_seen_epoch FROM learnings
               WHERE fingerprint = ? AND project != ?
               ORDER BY updated_at_epoch DESC
               LIMIT 1`
            ).get(row.fingerprint, GLOBAL_PROJECT_SCOPE) as {
              content: string;
              agent_id: string;
              first_seen_epoch: number;
            } | undefined;

            if (!newest) continue;

            const now = Math.floor(Date.now() / 1000);

            // Insert the merged __global__ record
            cachedPrepare(db, `
              INSERT INTO learnings
                (project, agent_id, fingerprint, content, promotion_count,
                 first_seen_epoch, last_promoted_epoch, updated_at_epoch)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              GLOBAL_PROJECT_SCOPE,
              newest.agent_id,
              row.fingerprint,
              newest.content,
              row.total_promos,
              newest.first_seen_epoch,
              now,
              now,
            );
          }

          // Delete per-project copies regardless of whether we just inserted or it pre-existed
          cachedPrepare(db,
            `DELETE FROM learnings WHERE fingerprint = ? AND project != ?`
          ).run(row.fingerprint, GLOBAL_PROJECT_SCOPE);

          consolidated++;
        } catch {
          // Individual fingerprint failure — continue with others
        }
      }
    });

    txn(duplicates);
    return consolidated;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Deduplicate decisions
// ---------------------------------------------------------------------------

/**
 * Find decisions with identical fingerprints (across any sessions/projects,
 * excluding __global__). Keep the newest by timestamp_epoch; delete the rest.
 *
 * Schema columns used: id, session_id, project, fingerprint, timestamp_epoch
 *
 * Returns the number of duplicate decisions removed.
 */
export function deduplicateDecisions(db: Database): number {
  try {
    // Find fingerprints with 2+ rows outside __global__
    const duplicates = cachedPrepare(db, `
      SELECT fingerprint,
             COUNT(*)              AS dup_count,
             MAX(timestamp_epoch)  AS newest
      FROM decisions
      WHERE project != ?
      GROUP BY fingerprint
      HAVING dup_count >= 2
      LIMIT 20
    `).all(GLOBAL_PROJECT_SCOPE) as Array<{
      fingerprint: string;
      dup_count: number;
      newest: number;
    }>;

    if (duplicates.length === 0) return 0;

    let removed = 0;

    const txn = db.transaction((rows: typeof duplicates) => {
      for (const row of rows) {
        try {
          // Identify the id of the newest row to keep
          const keeper = cachedPrepare(db,
            `SELECT id FROM decisions
             WHERE fingerprint = ? AND project != ?
             ORDER BY timestamp_epoch DESC
             LIMIT 1`
          ).get(row.fingerprint, GLOBAL_PROJECT_SCOPE) as { id: number } | undefined;

          if (!keeper) continue;

          // Delete all older duplicates
          const result = cachedPrepare(db,
            `DELETE FROM decisions
             WHERE fingerprint = ? AND project != ? AND id != ?`
          ).run(row.fingerprint, GLOBAL_PROJECT_SCOPE, keeper.id);

          removed += result.changes;
        } catch {
          // Individual fingerprint failure — continue
        }
      }
    });

    txn(duplicates);
    return removed;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Deduplicate experience patterns
// ---------------------------------------------------------------------------

/**
 * Find experience_patterns with identical trigger_context across 2+ source_projects
 * (excluding __global__). Merge them into a single __global__ pattern by summing
 * counters and keeping the best score/confidence.
 *
 * Schema columns used: id (TEXT), pattern_type, trigger_context, lesson, anti_pattern,
 * severity, score, times_triggered, times_useful, source_session, source_project,
 * created_at_epoch, last_triggered_epoch, trigger_glob, trigger_command,
 * assumption, reality, root_cause, generalized_rule, abstraction_level,
 * verified, verification_count, helpful_count, harmful_count,
 * escalation_level, maturity, confidence
 *
 * Returns the number of trigger_context groups consolidated.
 */
export function deduplicatePatterns(db: Database): number {
  try {
    // Find trigger_context values present in 2+ non-global projects
    const duplicates = cachedPrepare(db, `
      SELECT trigger_context,
             COUNT(DISTINCT source_project) AS proj_count,
             GROUP_CONCAT(id)               AS pattern_ids
      FROM experience_patterns
      WHERE source_project != ?
      GROUP BY trigger_context
      HAVING proj_count >= 2
      LIMIT 20
    `).all(GLOBAL_PROJECT_SCOPE) as Array<{
      trigger_context: string;
      proj_count: number;
      pattern_ids: string;
    }>;

    if (duplicates.length === 0) return 0;

    let consolidated = 0;

    const txn = db.transaction((rows: typeof duplicates) => {
      for (const row of rows) {
        try {
          const ids = row.pattern_ids.split(',').map(s => s.trim()).filter(Boolean);
          if (ids.length === 0) continue;

          // Fetch all matching per-project patterns
          const placeholders = ids.map(() => '?').join(',');
          const patterns = cachedPrepare(db,
            `SELECT * FROM experience_patterns WHERE id IN (${placeholders})`
          ).all(...ids) as Array<{
            id: string;
            pattern_type: string;
            trigger_context: string;
            lesson: string;
            anti_pattern: string | null;
            severity: string;
            score: number;
            times_triggered: number;
            times_useful: number;
            source_session: string | null;
            source_project: string;
            created_at_epoch: number;
            last_triggered_epoch: number | null;
            trigger_glob: string | null;
            trigger_command: string | null;
            assumption: string | null;
            reality: string | null;
            root_cause: string | null;
            generalized_rule: string | null;
            abstraction_level: string | null;
            verified: number;
            verification_count: number;
            helpful_count: number;
            harmful_count: number;
            escalation_level: string;
            maturity: string | null;
            confidence: number | null;
          }>;

          if (patterns.length === 0) continue;

          // Check if __global__ version already exists for this trigger_context
          const existing = cachedPrepare(db,
            `SELECT id FROM experience_patterns
             WHERE source_project = ? AND trigger_context = ?
             LIMIT 1`
          ).get(GLOBAL_PROJECT_SCOPE, row.trigger_context) as { id: string } | undefined;

          if (!existing) {
            // Merge: pick best values, sum counters
            const best = patterns.reduce((a, b) => a.score >= b.score ? a : b);
            const totalTriggered = patterns.reduce((sum, p) => sum + p.times_triggered, 0);
            const totalUseful    = patterns.reduce((sum, p) => sum + p.times_useful, 0);
            const totalHelpful   = patterns.reduce((sum, p) => sum + p.helpful_count, 0);
            const totalHarmful   = patterns.reduce((sum, p) => sum + p.harmful_count, 0);
            const bestScore      = Math.max(...patterns.map(p => p.score));
            const bestConfidence = Math.max(...patterns.map(p => p.confidence ?? 0.5));
            const minCreated     = Math.min(...patterns.map(p => p.created_at_epoch));
            const maxTriggered   = patterns
              .map(p => p.last_triggered_epoch ?? 0)
              .reduce((a, b) => Math.max(a, b), 0);

            const newId = ulid();
            const now = Math.floor(Date.now() / 1000);

            cachedPrepare(db, `
              INSERT INTO experience_patterns (
                id, pattern_type, trigger_context, lesson, anti_pattern,
                severity, score, times_triggered, times_useful,
                source_session, source_project, created_at_epoch, last_triggered_epoch,
                trigger_glob, trigger_command, assumption, reality, root_cause,
                generalized_rule, abstraction_level, verified, verification_count,
                helpful_count, harmful_count, escalation_level, maturity, confidence
              ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?
              )
            `).run(
              newId,
              best.pattern_type,
              best.trigger_context,
              best.lesson,
              best.anti_pattern,
              best.severity,
              bestScore,
              totalTriggered,
              totalUseful,
              best.source_session,
              GLOBAL_PROJECT_SCOPE,
              minCreated,
              maxTriggered || now,
              best.trigger_glob,
              best.trigger_command,
              best.assumption,
              best.reality,
              best.root_cause,
              best.generalized_rule,
              best.abstraction_level,
              best.verified,
              best.verification_count,
              totalHelpful,
              totalHarmful,
              best.escalation_level,
              best.maturity,
              bestConfidence,
            );
          }

          // Delete per-project copies (leave the __global__ one)
          cachedPrepare(db,
            `DELETE FROM experience_patterns
             WHERE trigger_context = ? AND source_project != ?`
          ).run(row.trigger_context, GLOBAL_PROJECT_SCOPE);

          consolidated++;
        } catch {
          // Individual group failure — continue
        }
      }
    });

    txn(duplicates);
    return consolidated;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Propagate proven learnings to __global__
// ---------------------------------------------------------------------------

/**
 * Copy learnings with promotion_count >= 5 in any non-global project to __global__,
 * provided their fingerprint doesn't already exist there.
 *
 * This ensures highly-confirmed knowledge is visible across all projects.
 *
 * Returns the number of learnings promoted.
 */
export function propagateLearnings(db: Database): number {
  try {
    const candidates = cachedPrepare(db, `
      SELECT id, project, agent_id, fingerprint, content, promotion_count,
             first_seen_epoch, last_promoted_epoch
      FROM learnings
      WHERE promotion_count >= 5
        AND project != ?
        AND fingerprint NOT IN (
          SELECT fingerprint FROM learnings WHERE project = ?
        )
      LIMIT 10
    `).all(GLOBAL_PROJECT_SCOPE, GLOBAL_PROJECT_SCOPE) as Array<{
      id: number;
      project: string;
      agent_id: string;
      fingerprint: string;
      content: string;
      promotion_count: number;
      first_seen_epoch: number;
      last_promoted_epoch: number;
    }>;

    if (candidates.length === 0) return 0;

    const now = Math.floor(Date.now() / 1000);
    let promoted = 0;

    const txn = db.transaction((rows: typeof candidates) => {
      for (const row of rows) {
        try {
          cachedPrepare(db, `
            INSERT OR IGNORE INTO learnings
              (project, agent_id, fingerprint, content, promotion_count,
               first_seen_epoch, last_promoted_epoch, updated_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            GLOBAL_PROJECT_SCOPE,
            row.agent_id,
            row.fingerprint,
            row.content,
            row.promotion_count,
            row.first_seen_epoch,
            row.last_promoted_epoch,
            now,
          );
          promoted++;
        } catch {
          // Individual row failure — continue
        }
      }
    });

    txn(candidates);
    return promoted;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Master function
// ---------------------------------------------------------------------------

/**
 * Run all cross-project consolidation phases.
 *
 * Rate-limited to once per config.sweepIntervalMinutes (default 60 min).
 * Non-throwing — returns zero counts on any failure.
 */
export function runCrossProjectConsolidation(
  db: Database,
  config: Pick<RetentionConfig, 'sweepIntervalMinutes' | 'crossProjectConsolidation'>,
): CrossProjectResult {
  const result: CrossProjectResult = {
    learnings_deduped: 0,
    decisions_deduped: 0,
    patterns_deduped: 0,
    learnings_propagated: 0,
  };

  try {
    if (!config.crossProjectConsolidation) return result;

    // Rate limit: once per sweepIntervalMinutes (or 60 min if unset)
    const intervalSec = (config.sweepIntervalMinutes ?? 60) * 60;
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (nowEpoch - _lastConsolidationEpoch < intervalSec) return result;
    _lastConsolidationEpoch = nowEpoch;

    result.learnings_deduped   = deduplicateLearnings(db);
    result.decisions_deduped   = deduplicateDecisions(db);
    result.patterns_deduped    = deduplicatePatterns(db);
    result.learnings_propagated = propagateLearnings(db);
  } catch {
    // Non-throwing contract — swallow top-level failures
  }

  return result;
}
