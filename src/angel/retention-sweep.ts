/**
 * Retention Sweep — per-table data lifecycle enforcement for the Angel Guardian.
 *
 * Each pruning function is independently non-throwing and batch-limited to 500
 * rows per invocation. The master runRetentionSweep() aggregates all results and
 * is rate-limited by config.sweepIntervalMinutes.
 *
 * Safety contract:
 *   - Sessions without an 'angel_processed' event in session_events are NEVER
 *     touched by conversation_turns pruning.
 *   - Artifacts with importance >= 5 are NEVER deleted.
 *   - session_journal 'summary' entries are NEVER deleted.
 *   - session_events 'angel_processed' entries are NEVER deleted.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { RetentionConfig, RetentionSweepResult } from './types.js';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Last sweep timestamp in ms (Date.now()). 0 = never run. */
let _lastSweepEpoch = 0;

/** Reset rate limit (for testing). */
export function resetSweepRateLimit(): void {
  _lastSweepEpoch = 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 500;

/** Returns Unix epoch (seconds) for `now - days`. */
function cutoff(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86_400;
}

const EMPTY_RESULT: RetentionSweepResult = {
  conversation_turns_skeletal: 0,
  conversation_turns_deleted: 0,
  artifacts_deleted: 0,
  journal_entries_deleted: 0,
  session_events_deleted: 0,
  retrieval_events_deleted: 0,
  artifact_links_deleted: 0,
  verified_facts_deleted: 0,
  session_messages_deleted: 0,
  observations_deleted: 0,
};

// ---------------------------------------------------------------------------
// 1. conversation_turns
// ---------------------------------------------------------------------------

/**
 * Three-tier retention for conversation_turns.
 *
 * Full (0–fullDays): no change.
 * Skeletal (fullDays–skeletalDays): NULL out assistant_text for angel-processed sessions.
 * Delete (skeletalDays+): hard-delete turns for angel-processed sessions.
 *
 * Sessions without an 'angel_processed' event are NEVER touched.
 */
export function pruneConversationTurns(
  db: Database,
  config: RetentionConfig,
): { skeletal: number; deleted: number } {
  try {
    const fullCutoff = cutoff(config.conversationTurnsFullDays);
    const skeletalCutoff = cutoff(config.conversationTurnsSkeletalDays);

    // Skeletal tier: sessions older than fullDays but newer than skeletalDays
    // NULL out assistant_text — keep user_text for reference
    const skeletalResult = cachedPrepare(db, `
      UPDATE conversation_turns
      SET assistant_text = NULL
      WHERE assistant_text IS NOT NULL
        AND session_id IN (
          SELECT s.session_id
          FROM sessions s
          WHERE s.ended_at_epoch < ?
            AND s.ended_at_epoch >= ?
            AND EXISTS (
              SELECT 1 FROM session_events se
              WHERE se.session_id = s.session_id
                AND se.event_type = 'angel_processed'
            )
        )
      LIMIT ?
    `).run(fullCutoff, skeletalCutoff, BATCH_LIMIT);

    // Delete tier: sessions older than skeletalDays
    const deleteResult = cachedPrepare(db, `
      DELETE FROM conversation_turns
      WHERE session_id IN (
        SELECT s.session_id
        FROM sessions s
        WHERE s.ended_at_epoch < ?
          AND EXISTS (
            SELECT 1 FROM session_events se
            WHERE se.session_id = s.session_id
              AND se.event_type = 'angel_processed'
          )
      )
      LIMIT ?
    `).run(skeletalCutoff, BATCH_LIMIT);

    // FTS5 sync: the DELETE trigger handles hard deletes automatically, but the
    // UPDATE (nulling assistant_text) has no trigger. Rebuild the affected FTS
    // rows so search results don't contain phantom assistant text.
    if (skeletalResult.changes > 0) {
      try {
        cachedPrepare(db, `
          INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_text, assistant_text)
          SELECT 'delete', ct.id, ct.user_text, ''
          FROM conversation_turns ct
          WHERE ct.assistant_text IS NULL
            AND ct.id IN (
              SELECT id FROM conversation_turns
              WHERE assistant_text IS NULL
              ORDER BY id DESC LIMIT ?
            )
        `).run(skeletalResult.changes);
        // Re-insert with NULL assistant_text
        cachedPrepare(db, `
          INSERT INTO conversation_turns_fts(rowid, user_text, assistant_text)
          SELECT ct.id, ct.user_text, ''
          FROM conversation_turns ct
          WHERE ct.assistant_text IS NULL
            AND ct.id IN (
              SELECT id FROM conversation_turns
              WHERE assistant_text IS NULL
              ORDER BY id DESC LIMIT ?
            )
        `).run(skeletalResult.changes);
      } catch { /* FTS rebuild is supplementary — non-fatal */ }
    }

    return {
      skeletal: skeletalResult.changes,
      deleted: deleteResult.changes,
    };
  } catch {
    return { skeletal: 0, deleted: 0 };
  }
}

// ---------------------------------------------------------------------------
// 2. artifacts
// ---------------------------------------------------------------------------

/**
 * Three cleanup targets for artifacts. Never deletes importance >= 5.
 *
 * - Superseded: superseded_by IS NOT NULL AND old enough → DELETE
 * - Cold unaccessed: packed + low importance + old + no recent retrievals → DELETE
 * - Ancient packed: packed + very old + moderate importance → DELETE
 */
export function pruneArtifacts(db: Database, config: RetentionConfig): number {
  let total = 0;

  try {
    // Target 1: superseded artifacts past their grace period
    const supersededCutoff = cutoff(config.artifactSupersededDeleteDays);
    const superseded = cachedPrepare(db, `
      DELETE FROM artifacts
      WHERE superseded_by IS NOT NULL
        AND timestamp_epoch < ?
        AND importance < 5
      LIMIT ?
    `).run(supersededCutoff, BATCH_LIMIT);
    total += superseded.changes;
  } catch { /* non-fatal */ }

  try {
    // Target 2: cold unaccessed packed artifacts
    // packed + importance < 3 + old enough + no retrieval events in last coldDeleteDays days
    const coldCutoff = cutoff(config.artifactColdDeleteDays);
    const cold = cachedPrepare(db, `
      DELETE FROM artifacts
      WHERE state = 'packed'
        AND importance < 3
        AND timestamp_epoch < ?
        AND importance < 5
        AND id NOT IN (
          SELECT DISTINCT artifact_id
          FROM retrieval_events
          WHERE timestamp_epoch > ?
        )
      LIMIT ?
    `).run(coldCutoff, coldCutoff, BATCH_LIMIT);
    total += cold.changes;
  } catch { /* non-fatal */ }

  try {
    // Target 3: ancient packed artifacts with low-moderate importance
    const ancientCutoff = cutoff(90);
    const ancient = cachedPrepare(db, `
      DELETE FROM artifacts
      WHERE state = 'packed'
        AND timestamp_epoch < ?
        AND importance < 4
      LIMIT ?
    `).run(ancientCutoff, BATCH_LIMIT);
    total += ancient.changes;
  } catch { /* non-fatal */ }

  return total;
}

// ---------------------------------------------------------------------------
// 3. session_journal
// ---------------------------------------------------------------------------

/**
 * Type-aware journal pruning.
 *
 * flow entries: deleted after journalFlowRetentionDays
 * milestone entries: deleted after journalMilestoneRetentionDays
 * summary entries: NEVER deleted
 */
export function pruneSessionJournal(db: Database, config: RetentionConfig): number {
  let total = 0;

  try {
    const flowCutoff = cutoff(config.journalFlowRetentionDays);
    const flow = cachedPrepare(db, `
      DELETE FROM session_journal
      WHERE entry_type = 'flow'
        AND timestamp_epoch < ?
      LIMIT ?
    `).run(flowCutoff, BATCH_LIMIT);
    total += flow.changes;
  } catch { /* non-fatal */ }

  try {
    const milestoneCutoff = cutoff(config.journalMilestoneRetentionDays);
    const milestone = cachedPrepare(db, `
      DELETE FROM session_journal
      WHERE entry_type = 'milestone'
        AND timestamp_epoch < ?
      LIMIT ?
    `).run(milestoneCutoff, BATCH_LIMIT);
    total += milestone.changes;
  } catch { /* non-fatal */ }

  // 'summary' entries are never deleted — not handled here by design

  return total;
}

// ---------------------------------------------------------------------------
// 4. session_events
// ---------------------------------------------------------------------------

/**
 * Prune old session_events, preserving 'angel_processed' events forever.
 *
 * session_events has a timestamp_epoch column (confirmed in schema DDL).
 */
export function pruneSessionEvents(db: Database, config: RetentionConfig): number {
  try {
    const eventsCutoff = cutoff(config.sessionEventsRetentionDays);
    const result = cachedPrepare(db, `
      DELETE FROM session_events
      WHERE timestamp_epoch < ?
        AND event_type != 'angel_processed'
      LIMIT ?
    `).run(eventsCutoff, BATCH_LIMIT);
    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 5. retrieval_events
// ---------------------------------------------------------------------------

/**
 * Prune old retrieval_events.
 *
 * retrieval_events has a timestamp_epoch column (confirmed in schema DDL).
 */
export function pruneRetrievalEvents(db: Database, config: RetentionConfig): number {
  try {
    const retrievalCutoff = cutoff(config.retrievalEventsRetentionDays);
    const result = cachedPrepare(db, `
      DELETE FROM retrieval_events
      WHERE timestamp_epoch < ?
      LIMIT ?
    `).run(retrievalCutoff, BATCH_LIMIT);
    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 6. artifact_links
// ---------------------------------------------------------------------------

/**
 * Two cleanup targets for artifact_links.
 *
 * - Orphan links: source_id or target_id no longer exists in artifacts
 * - Weak stale links: strength < 0.3 AND valid_at_epoch past 1-year threshold
 */
export function pruneArtifactLinks(db: Database, _config: RetentionConfig): number {
  let total = 0;

  try {
    // Orphan cleanup: dangling references from either end
    const orphans = cachedPrepare(db, `
      DELETE FROM artifact_links
      WHERE source_id NOT IN (SELECT id FROM artifacts)
         OR target_id NOT IN (SELECT id FROM artifacts)
      LIMIT ?
    `).run(BATCH_LIMIT);
    total += orphans.changes;
  } catch { /* non-fatal */ }

  try {
    // Weak stale links: low strength and not validated recently
    const weakCutoff = cutoff(365);
    const weak = cachedPrepare(db, `
      DELETE FROM artifact_links
      WHERE strength < 0.3
        AND valid_at_epoch < ?
      LIMIT ?
    `).run(weakCutoff, BATCH_LIMIT);
    total += weak.changes;
  } catch { /* non-fatal */ }

  return total;
}

// ---------------------------------------------------------------------------
// 7. verified_facts
// ---------------------------------------------------------------------------

/**
 * Prune verified_facts for sessions that ended long ago.
 *
 * verified_facts has created_at_epoch but not timestamp_epoch. Session age is
 * determined by joining to sessions.ended_at_epoch.
 */
export function pruneVerifiedFacts(db: Database, config: RetentionConfig): number {
  try {
    const factsCutoff = cutoff(config.verifiedFactsRetentionDays);
    const result = cachedPrepare(db, `
      DELETE FROM verified_facts
      WHERE session_id IN (
        SELECT session_id
        FROM sessions
        WHERE ended_at_epoch < ?
      )
      LIMIT ?
    `).run(factsCutoff, BATCH_LIMIT);
    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 8. session_messages
// ---------------------------------------------------------------------------

/**
 * Prune delivered session_messages older than 7 days.
 *
 * "delivered" is indicated by delivered_at_epoch IS NOT NULL (schema has no
 * boolean 'delivered' column — delivery is tracked by delivered_at_epoch).
 */
export function pruneSessionMessages(db: Database, _config: RetentionConfig): number {
  try {
    const msgCutoff = cutoff(7);
    const result = cachedPrepare(db, `
      DELETE FROM session_messages
      WHERE delivered_at_epoch IS NOT NULL
        AND created_at_epoch < ?
      LIMIT ?
    `).run(msgCutoff, BATCH_LIMIT);
    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 8b. Observation pruning — importance-tiered retention
// ---------------------------------------------------------------------------

/**
 * Prune old observations by importance tier:
 *   - Low (1-2): 30 days
 *   - Medium (3): 90 days
 *   - High (4-5): 180 days
 *
 * Observations that have been referenced by retrieval events are kept longer
 * (their access proves they're still useful). Batch-limited to 500.
 */
export function pruneObservations(db: Database, config: RetentionConfig): number {
  try {
    const now = Math.floor(Date.now() / 1000);
    let totalDeleted = 0;

    // Tier 1: Low importance (1-2), older than config days
    const lowCutoff = now - (config.observationLowImpRetentionDays ?? 30) * 86400;
    const lowResult = cachedPrepare(db,
      `DELETE FROM observations
       WHERE importance <= 2
         AND timestamp_epoch < ?
         AND id NOT IN (SELECT CAST(a.artifact_ref AS INTEGER) FROM artifacts a JOIN retrieval_events re ON a.id = re.artifact_id WHERE a.artifact_type = 'observation')
       LIMIT 500`
    ).run(lowCutoff);
    totalDeleted += lowResult.changes;

    // Tier 2: Medium importance (3), older than config days
    const medCutoff = now - (config.observationMedImpRetentionDays ?? 90) * 86400;
    const medResult = cachedPrepare(db,
      `DELETE FROM observations
       WHERE importance = 3
         AND timestamp_epoch < ?
         AND id NOT IN (SELECT CAST(a.artifact_ref AS INTEGER) FROM artifacts a JOIN retrieval_events re ON a.id = re.artifact_id WHERE a.artifact_type = 'observation')
       LIMIT 500`
    ).run(medCutoff);
    totalDeleted += medResult.changes;

    // Tier 3: High importance (4-5), older than config days
    const highCutoff = now - (config.observationHighImpRetentionDays ?? 180) * 86400;
    const highResult = cachedPrepare(db,
      `DELETE FROM observations
       WHERE importance >= 4
         AND timestamp_epoch < ?
         AND id NOT IN (SELECT CAST(a.artifact_ref AS INTEGER) FROM artifacts a JOIN retrieval_events re ON a.id = re.artifact_id WHERE a.artifact_type = 'observation')
       LIMIT 500`
    ).run(highCutoff);
    totalDeleted += highResult.changes;

    return totalDeleted;
  } catch {
    return 0;
  }
}

// 9. Master sweep
// ---------------------------------------------------------------------------

/**
 * Run all retention prune functions and return the aggregate result.
 *
 * Rate-limited by config.sweepIntervalMinutes. Returns an empty result if
 * the interval has not elapsed since the last sweep.
 *
 * Non-throwing — each sub-function is individually wrapped in try/catch.
 * The master function itself also wraps in try/catch for belt-and-suspenders.
 */
export function runRetentionSweep(
  db: Database,
  config: RetentionConfig,
): RetentionSweepResult {
  const now = Date.now();
  if (now - _lastSweepEpoch < config.sweepIntervalMinutes * 60_000) {
    return { ...EMPTY_RESULT };
  }

  _lastSweepEpoch = now;

  const result: RetentionSweepResult = { ...EMPTY_RESULT };

  try {
    const turns = pruneConversationTurns(db, config);
    result.conversation_turns_skeletal = turns.skeletal;
    result.conversation_turns_deleted = turns.deleted;
  } catch { /* non-fatal */ }

  try {
    result.artifacts_deleted = pruneArtifacts(db, config);
  } catch { /* non-fatal */ }

  try {
    result.journal_entries_deleted = pruneSessionJournal(db, config);
  } catch { /* non-fatal */ }

  try {
    result.session_events_deleted = pruneSessionEvents(db, config);
  } catch { /* non-fatal */ }

  try {
    result.retrieval_events_deleted = pruneRetrievalEvents(db, config);
  } catch { /* non-fatal */ }

  try {
    result.artifact_links_deleted = pruneArtifactLinks(db, config);
  } catch { /* non-fatal */ }

  try {
    result.verified_facts_deleted = pruneVerifiedFacts(db, config);
  } catch { /* non-fatal */ }

  try {
    result.session_messages_deleted = pruneSessionMessages(db, config);
  } catch { /* non-fatal */ }

  try {
    result.observations_deleted = pruneObservations(db, config);
  } catch { /* non-fatal */ }

  return result;
}
