/**
 * Data Quality and Integrity — Guardian phase for DB health.
 *
 * All checks are SQL-based. No LLM calls. Runs every 120 minutes (configurable).
 * Each exported function is independently non-throwing.
 *
 * Responsibilities:
 *   1. fixZeroObservationSessions  — queue stale 'too few turns' sessions for Angel re-processing
 *   2. cleanOrphanedRecords        — delete child rows referencing non-existent sessions
 *   3. detectStaleEmbeddings       — null embeddings on recently-modified artifacts
 *   4. validateSchemaIntegrity     — FTS vs base-table row-count spot-checks
 *   5. runDataQualityChecks        — master function; rate-limited; calls all checks
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { DataQualityResult, RetentionConfig } from './types.js';

// ---------------------------------------------------------------------------
// Module-level rate limiting
// ---------------------------------------------------------------------------

let _lastQualityCheckEpoch = 0;

/** Reset the rate limit (for testing). */
export function resetQualityCheckRateLimit(): void {
  _lastQualityCheckEpoch = 0;
}

// ---------------------------------------------------------------------------
// Empty result sentinel
// ---------------------------------------------------------------------------

const EMPTY_RESULT: DataQualityResult = {
  zero_obs_sessions_queued: 0,
  orphaned_records_deleted: 0,
  stale_embeddings_nulled: 0,
  fts_discrepancies: 0,
};

// ---------------------------------------------------------------------------
// 1. fixZeroObservationSessions
// ---------------------------------------------------------------------------

/**
 * The critical 63% data-loss fix.
 *
 * Finds completed sessions that:
 *   - Have at least one conversation_turn (real content exists)
 *   - Have 0 observations
 *   - Have a stale angel_processed event with summary 'too few turns' or
 *     'insufficient content' (written before turn capture was implemented)
 *   - Have NOT already been requeued (no 'guardian_requeued' event)
 *
 * For each such session: DELETE the stale angel_processed marker and INSERT
 * a 'guardian_requeued' event so we never retry the same session twice.
 * This prevents an infinite loop: if the Angel re-processes and produces
 * "too few turns" again (genuinely sparse session), the requeue marker
 * ensures we don't remove the new marker and try again.
 *
 * Returns the number of sessions queued for re-processing.
 * Non-throwing.
 */
export function fixZeroObservationSessions(db: Database): number {
  try {
    const candidates = cachedPrepare(db, `
      SELECT DISTINCT s.session_id
      FROM sessions s
      INNER JOIN conversation_turns ct ON ct.session_id = s.session_id
      WHERE s.status = 'completed'
        AND s.observation_count = 0
        AND s.session_id IN (
          SELECT se.session_id FROM session_events se
          WHERE se.event_type = 'angel_processed'
            AND (se.detail LIKE '%too few turns%' OR se.detail LIKE '%insufficient content%')
        )
        AND s.session_id NOT IN (
          SELECT se2.session_id FROM session_events se2
          WHERE se2.event_type = 'guardian_requeued'
        )
      LIMIT 10
    `).all() as Array<{ session_id: string }>;

    if (candidates.length === 0) return 0;

    const deleteStaleMarker = cachedPrepare(db, `
      DELETE FROM session_events
      WHERE session_id = ?
        AND event_type = 'angel_processed'
        AND (detail LIKE '%too few turns%' OR detail LIKE '%insufficient content%')
    `);

    const markRequeued = cachedPrepare(db, `
      INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
      VALUES (?, '', 'guardian_requeued', 'angel:data_quality', 'requeued',
              'Stale angel_processed marker removed — one-time requeue for re-extraction')
    `);

    let queued = 0;
    for (const { session_id } of candidates) {
      try {
        const result = deleteStaleMarker.run(session_id);
        if (result.changes > 0) {
          markRequeued.run(session_id);
          queued++;
        }
      } catch {
        // Individual session failure — continue with others
      }
    }

    return queued;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 2. cleanOrphanedRecords
// ---------------------------------------------------------------------------

/**
 * Delete rows in child tables that reference non-existent sessions.
 *
 * Tables checked:
 *   - session_events    (excludes angel* and test* session_ids — special Angel records)
 *   - conversation_turns
 *   - thread_state
 *   - checkpoint_tracking
 *   - verified_facts
 *
 * Each DELETE is capped at 200 rows to avoid long-running locks.
 *
 * Returns total rows deleted across all tables.
 * Non-throwing.
 */
export function cleanOrphanedRecords(db: Database): number {
  let total = 0;

  // session_events: exclude angel* and test* — those are legitimate synthetic session_ids
  try {
    const r = cachedPrepare(db, `
      DELETE FROM session_events
      WHERE id IN (
        SELECT id FROM session_events
        WHERE session_id NOT IN (SELECT session_id FROM sessions)
          AND session_id NOT LIKE 'angel%'
          AND session_id NOT LIKE 'test%'
        LIMIT 200
      )
    `).run();
    total += r.changes;
  } catch {
    // Non-critical — continue with other tables
  }

  // conversation_turns
  try {
    const r = cachedPrepare(db, `
      DELETE FROM conversation_turns
      WHERE id IN (
        SELECT id FROM conversation_turns
        WHERE session_id NOT IN (SELECT session_id FROM sessions)
        LIMIT 200
      )
    `).run();
    total += r.changes;
  } catch {
    // Non-critical
  }

  // thread_state
  try {
    const r = cachedPrepare(db, `
      DELETE FROM thread_state
      WHERE session_id NOT IN (SELECT session_id FROM sessions)
        AND session_id IN (
          SELECT session_id FROM thread_state
          WHERE session_id NOT IN (SELECT session_id FROM sessions)
          LIMIT 200
        )
    `).run();
    total += r.changes;
  } catch {
    // Non-critical
  }

  // checkpoint_tracking
  try {
    const r = cachedPrepare(db, `
      DELETE FROM checkpoint_tracking
      WHERE session_id NOT IN (SELECT session_id FROM sessions)
        AND session_id IN (
          SELECT session_id FROM checkpoint_tracking
          WHERE session_id NOT IN (SELECT session_id FROM sessions)
          LIMIT 200
        )
    `).run();
    total += r.changes;
  } catch {
    // Non-critical
  }

  // verified_facts
  try {
    const r = cachedPrepare(db, `
      DELETE FROM verified_facts
      WHERE id IN (
        SELECT id FROM verified_facts
        WHERE session_id NOT IN (SELECT session_id FROM sessions)
        LIMIT 200
      )
    `).run();
    total += r.changes;
  } catch {
    // Non-critical
  }

  return total;
}

// ---------------------------------------------------------------------------
// 3. detectStaleEmbeddings
// ---------------------------------------------------------------------------

/**
 * Null embeddings on artifacts whose content was updated after their embedding
 * was computed — detected by file-ingester artifacts (artifact_ref IS NOT NULL)
 * that were recently modified.
 *
 * Only targets file-based artifacts (memory_file, session_log, handoff) that
 * the file ingester updates in-place. Regular artifacts created fresh always
 * get embedded at creation time.
 *
 * Capped at 50 artifacts per run.
 *
 * Returns the number of embeddings nulled.
 * Non-throwing.
 */
export function detectStaleEmbeddings(db: Database): number {
  try {
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

    // Only null embeddings on file-based artifacts that were recently updated.
    // These are the ones the file ingester modifies in-place (same artifact_ref,
    // new content). Regular artifacts are always created fresh with embeddings.
    const r = cachedPrepare(db, `
      UPDATE artifacts
      SET embedding = NULL
      WHERE embedding IS NOT NULL
        AND artifact_ref IS NOT NULL
        AND artifact_type IN ('memory_file', 'session_log', 'handoff')
        AND timestamp_epoch > ?
        AND id IN (
          SELECT id FROM artifacts
          WHERE embedding IS NOT NULL
            AND artifact_ref IS NOT NULL
            AND timestamp_epoch > ?
          LIMIT 50
        )
    `).run(oneDayAgo, oneDayAgo);

    return r.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 4. validateSchemaIntegrity
// ---------------------------------------------------------------------------

/** Acceptable divergence between a base table and its FTS shadow. */
const FTS_DISCREPANCY_THRESHOLD = 10;

/**
 * Check FTS5 virtual table row counts against their base tables.
 * When a discrepancy > threshold is found: REBUILD the FTS index.
 *
 * FTS5 supports `INSERT INTO fts_table(fts_table) VALUES('rebuild')` which
 * reconstructs the index from the content table. This is safe and idempotent.
 *
 * Checks + fixes:
 *   - observations_fts  (soft-delete aware — rebuilds from non-deleted rows)
 *   - artifacts_fts
 *   - artifact_fts      (V17: unified FTS5 for artifact kernel — replaces learnings_fts + experience_patterns_fts)
 *   - conversation_turns_fts
 *
 * Returns the number of tables that were rebuilt.
 * Non-throwing.
 */
export function validateSchemaIntegrity(db: Database): number {
  let rebuilt = 0;

  interface FtsCheckRow {
    base_count: number;
    fts_count: number;
  }

  const checks: Array<{
    name: string;
    query: string;
    rebuildCmd: string;
  }> = [
    {
      name: 'observations',
      // FTS indexes ALL rows including soft-deleted — compare against total, not just active
      query: `SELECT
        (SELECT COUNT(*) FROM observations) AS base_count,
        (SELECT COUNT(*) FROM observations_fts) AS fts_count`,
      rebuildCmd: `INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`,
    },
    {
      name: 'artifacts',
      query: `SELECT
        (SELECT COUNT(*) FROM artifacts) AS base_count,
        (SELECT COUNT(*) FROM artifacts_fts) AS fts_count`,
      rebuildCmd: `INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')`,
    },
    // V17: learnings_fts retired; artifact_fts (content='artifact') covers
    // all 6 kinds including learnings. Compare artifact rowcount against
    // artifact_fts rowcount here. This replaces the old learnings + experience_patterns
    // FTS5 sync checks in one row.
    {
      name: 'artifact',
      query: `SELECT
        (SELECT COUNT(*) FROM artifact) AS base_count,
        (SELECT COUNT(*) FROM artifact_fts) AS fts_count`,
      rebuildCmd: `INSERT INTO artifact_fts(artifact_fts) VALUES('rebuild')`,
    },
    {
      name: 'conversation_turns',
      query: `SELECT
        (SELECT COUNT(*) FROM conversation_turns) AS base_count,
        (SELECT COUNT(*) FROM conversation_turns_fts) AS fts_count`,
      rebuildCmd: `INSERT INTO conversation_turns_fts(conversation_turns_fts) VALUES('rebuild')`,
    },
  ];

  for (const check of checks) {
    try {
      const row = cachedPrepare(db, check.query).get() as FtsCheckRow | undefined;

      if (row && Math.abs(row.base_count - row.fts_count) > FTS_DISCREPANCY_THRESHOLD) {
        _logFtsDiscrepancy(db, check.name, row.base_count, row.fts_count);
        // REBUILD — reconstructs FTS index from the content table
        try {
          db.exec(check.rebuildCmd);
          rebuilt++;
        } catch {
          // Rebuild failure — log but continue
        }
      }
    } catch {
      // Non-critical
    }
  }

  return rebuilt;
}

/** Write a telemetry event for an FTS discrepancy. Non-throwing. */
function _logFtsDiscrepancy(
  db: Database,
  tableName: string,
  baseCount: number,
  ftsCount: number,
): void {
  try {
    cachedPrepare(db, `
      INSERT INTO telemetry (session_id, event_kind, detail)
      VALUES ('angel', 'error', json_object(
        'check', 'fts_integrity',
        'table', ?,
        'base_count', ?,
        'fts_count', ?,
        'delta', ?
      ))
    `).run(tableName, baseCount, ftsCount, Math.abs(baseCount - ftsCount));
  } catch {
    // Telemetry write failure is never fatal
  }
}

// ---------------------------------------------------------------------------
// 5. runDataQualityChecks — master function
// ---------------------------------------------------------------------------

/**
 * Run all data quality checks.
 *
 * Rate-limited to `config.qualityCheckIntervalMinutes` minutes between runs.
 * When rate-limited, returns an empty result immediately.
 *
 * Non-throwing — returns a safe empty result on any failure.
 */
export function runDataQualityChecks(
  db: Database,
  config: RetentionConfig,
): DataQualityResult {
  try {
    if (!config.dataQualityChecks) return { ...EMPTY_RESULT };

    const now = Date.now();
    const intervalMs = config.qualityCheckIntervalMinutes * 60_000;

    if (now - _lastQualityCheckEpoch < intervalMs) {
      return { ...EMPTY_RESULT };
    }

    _lastQualityCheckEpoch = now;

    const result: DataQualityResult = {
      zero_obs_sessions_queued: fixZeroObservationSessions(db),
      orphaned_records_deleted: cleanOrphanedRecords(db),
      stale_embeddings_nulled: detectStaleEmbeddings(db),
      fts_discrepancies: validateSchemaIntegrity(db),
    };

    return result;
  } catch {
    return { ...EMPTY_RESULT };
  }
}
