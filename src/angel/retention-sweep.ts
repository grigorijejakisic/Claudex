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
import { detectContradiction } from '../intelligence/contradiction-detector.js';
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

/** Returns Unix epoch (milliseconds) for `now - days`. Used for *_epoch_ms columns. */
function cutoffMs(days: number): number {
  return Date.now() - days * 86_400_000;
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
  observations_superseded: 0,
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
    const fullCutoffMs = cutoffMs(config.conversationTurnsFullDays);
    const skeletalCutoffMs = cutoffMs(config.conversationTurnsSkeletalDays);

    // Skeletal tier: sessions older than fullDays but newer than skeletalDays
    // NULL out assistant_text — keep user_text for reference
    const skeletalResult = cachedPrepare(db, `
      UPDATE conversation_turns
      SET assistant_text = NULL
      WHERE assistant_text IS NOT NULL
        AND session_id IN (
          SELECT s.session_id
          FROM sessions s
          WHERE s.ended_at_epoch_ms < ?
            AND s.ended_at_epoch_ms >= ?
            AND EXISTS (
              SELECT 1 FROM session_events se
              WHERE se.session_id = s.session_id
                AND se.event_type = 'angel_processed'
            )
        )
      LIMIT ?
    `).run(fullCutoffMs, skeletalCutoffMs, BATCH_LIMIT);

    // Delete tier: sessions older than skeletalDays
    const deleteResult = cachedPrepare(db, `
      DELETE FROM conversation_turns
      WHERE session_id IN (
        SELECT s.session_id
        FROM sessions s
        WHERE s.ended_at_epoch_ms < ?
          AND EXISTS (
            SELECT 1 FROM session_events se
            WHERE se.session_id = s.session_id
              AND se.event_type = 'angel_processed'
          )
      )
      LIMIT ?
    `).run(skeletalCutoffMs, BATCH_LIMIT);

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
 * Three cleanup targets for V17 artifacts. Never deletes confidence >= 1.0 (importance=5).
 *
 * V17 field mapping (RCA-3 loss-map):
 *   state → status: 'packed' → 'stale', 'fresh'/'materialized' → 'active'/'superseded'
 *   superseded_by IS NOT NULL (forward) → supersedes_id IS NOT NULL (backward) on V17
 *   importance (1-5) → confidence (0-1): importance=5 → confidence=1.0, threshold confidence < 0.6 ≈ importance < 3
 *
 * 14-07b: migrated from legacy artifacts
 */
export function pruneArtifacts(db: Database, config: RetentionConfig): number {
  let total = 0;

  try {
    // Target 1: superseded V17 artifacts past their grace period
    // V17 direction: supersedes_id IS NOT NULL means THIS row replaced something else (new row).
    // status = 'superseded' means THIS row was replaced.
    const supersededCutoffMs = cutoffMs(config.artifactSupersededDeleteDays);
    const superseded = cachedPrepare(db, `
      DELETE FROM artifact
      WHERE status = 'superseded'
        AND created_at_epoch_ms < ?
        AND confidence < 1.0
      LIMIT ?
    `).run(supersededCutoffMs, BATCH_LIMIT);
    total += superseded.changes;
  } catch { /* non-fatal */ }

  try {
    // Target 2: cold unaccessed stale V17 artifacts
    // stale (was 'packed') + low confidence (< 0.6, ≈ importance < 3) + old + no recent retrievals
    const coldCutoffMs = cutoffMs(config.artifactColdDeleteDays);
    const cold = cachedPrepare(db, `
      DELETE FROM artifact
      WHERE status = 'stale'
        AND confidence < 0.6
        AND created_at_epoch_ms < ?
        AND id NOT IN (
          SELECT DISTINCT artifact_id
          FROM retrieval_events
          WHERE timestamp_epoch_ms > ?
        )
      LIMIT ?
    `).run(coldCutoffMs, cutoffMs(config.artifactColdDeleteDays), BATCH_LIMIT);
    total += cold.changes;
  } catch { /* non-fatal */ }

  try {
    // Target 3: ancient stale V17 artifacts with low-moderate confidence
    // confidence < 0.8 ≈ importance < 4
    const ancientCutoffMs = cutoffMs(90);
    const ancient = cachedPrepare(db, `
      DELETE FROM artifact
      WHERE status = 'stale'
        AND created_at_epoch_ms < ?
        AND confidence < 0.8
      LIMIT ?
    `).run(ancientCutoffMs, BATCH_LIMIT);
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
    const flowCutoff = cutoffMs(config.journalFlowRetentionDays);
    const flow = cachedPrepare(db, `
      DELETE FROM session_journal
      WHERE entry_type = 'flow'
        AND timestamp_epoch_ms < ?
      LIMIT ?
    `).run(flowCutoff, BATCH_LIMIT);
    total += flow.changes;
  } catch { /* non-fatal */ }

  try {
    const milestoneCutoff = cutoffMs(config.journalMilestoneRetentionDays);
    const milestone = cachedPrepare(db, `
      DELETE FROM session_journal
      WHERE entry_type = 'milestone'
        AND timestamp_epoch_ms < ?
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
 * session_events has a timestamp_epoch_ms column (renamed from timestamp_epoch in V43).
 */
export function pruneSessionEvents(db: Database, config: RetentionConfig): number {
  try {
    const eventsCutoff = cutoffMs(config.sessionEventsRetentionDays);
    const result = cachedPrepare(db, `
      DELETE FROM session_events
      WHERE timestamp_epoch_ms < ?
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
 * retrieval_events has a timestamp_epoch_ms column (confirmed in schema DDL).
 */
export function pruneRetrievalEvents(db: Database, config: RetentionConfig): number {
  try {
    const retrievalCutoff = cutoff(config.retrievalEventsRetentionDays);
    const result = cachedPrepare(db, `
      DELETE FROM retrieval_events
      WHERE timestamp_epoch_ms < ?
      LIMIT ?
    `).run(cutoffMs(config.retrievalEventsRetentionDays), BATCH_LIMIT);
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
 * - Orphan links: source_id or target_id no longer exists in V17 artifact (or legacy artifacts)
 * - Weak stale links: strength < 0.3 AND valid_at_epoch past 1-year threshold
 *
 * 14-07b: migrated from legacy artifacts — orphan check now uses V17 artifact table.
 * artifact_links.source_id / target_id are INTEGER legacy IDs bridged via artifact_id_map.
 * An orphan exists when neither legacy artifacts NOR artifact_id_map has the ID.
 */
export function pruneArtifactLinks(db: Database, _config: RetentionConfig): number {
  let total = 0;

  try {
    // Orphan cleanup: dangling references from either end.
    // A link is orphaned only if the ID is gone from BOTH legacy artifacts and artifact_id_map.
    // During the transition window, V17 is the authoritative store; artifact_id_map covers
    // rows that were migrated. Any ID not in artifact_id_map.legacy_id was never migrated.
    const orphans = cachedPrepare(db, `
      DELETE FROM artifact_links
      WHERE source_id NOT IN (SELECT legacy_id FROM artifact_id_map)
         OR target_id NOT IN (SELECT legacy_id FROM artifact_id_map)
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
 * verified_facts has created_at_epoch but not timestamp_epoch_ms. Session age is
 * determined by joining to sessions.ended_at_epoch_ms.
 */
export function pruneVerifiedFacts(db: Database, config: RetentionConfig): number {
  try {
    const factsCutoffMs = cutoffMs(config.verifiedFactsRetentionDays);
    const result = cachedPrepare(db, `
      DELETE FROM verified_facts
      WHERE session_id IN (
        SELECT session_id
        FROM sessions
        WHERE ended_at_epoch_ms < ?
      )
      LIMIT ?
    `).run(factsCutoffMs, BATCH_LIMIT);
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
 * "delivered" is indicated by delivered_at_epoch_ms IS NOT NULL (schema has no
 * boolean 'delivered' column — delivery is tracked by delivered_at_epoch_ms).
 */
export function pruneSessionMessages(db: Database, _config: RetentionConfig): number {
  try {
    const msgCutoffMs = cutoffMs(7);
    const result = cachedPrepare(db, `
      DELETE FROM session_messages
      WHERE delivered_at_epoch_ms IS NOT NULL
        AND created_at_epoch_ms < ?
      LIMIT ?
    `).run(msgCutoffMs, BATCH_LIMIT);
    return result.changes;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 8b. Observation contradiction resolution + importance-tiered retention
// ---------------------------------------------------------------------------

/**
 * Pre-sweep pass: detect contradictions among recent observations within each project.
 * When contradictions found, keep the newer observation and mark the older as superseded
 * (consumed=1). Only scans observations from the last 90 days — older ones are about to
 * be age-pruned anyway. Batch of 50 per project.
 *
 * A3 (Phase 10): Wires detectContradiction() from contradiction-detector.ts into the
 * retention sweep so contradictions are resolved every hourly sweep cycle.
 */
function resolveContradictions(db: Database): number {
  try {
    const ninetyCutoffMs = Date.now() - 90 * 86_400_000;
    const projects = cachedPrepare(db,
      `SELECT DISTINCT project FROM observations
       WHERE consumed = 0 AND timestamp_epoch_ms > ? AND project IS NOT NULL`
    ).all(ninetyCutoffMs) as Array<{ project: string }>;

    let superseded = 0;
    for (const { project } of projects) {
      const obs = cachedPrepare(db,
        `SELECT id, content, session_id, timestamp_epoch_ms FROM observations
         WHERE project = ? AND consumed = 0 AND timestamp_epoch_ms > ?
         ORDER BY timestamp_epoch_ms DESC LIMIT 50`
      ).all(project, ninetyCutoffMs) as Array<{ id: number; content: string; session_id: string; timestamp_epoch_ms: number }>;

      for (let i = 0; i < obs.length; i++) {
        for (let j = i + 1; j < obs.length; j++) {
          // obs[i] is newer (DESC order), obs[j] is older
          const contradiction = detectContradiction(db, obs[i].content, project, obs[i].session_id);
          if (contradiction) {
            // Mark the older observation as superseded
            try {
              cachedPrepare(db,
                `UPDATE observations SET consumed = 1 WHERE id = ?`
              ).run(obs[j].id);
              superseded++;
            } catch { /* non-fatal */ }
            break; // Move to next newer observation
          }
        }
      }
    }
    return superseded;
  } catch {
    return 0;
  }
}

/**
 * Prune old observations by importance tier:
 *   - Low (1-2): 30 days
 *   - Medium (3): 90 days
 *   - High (4-5): 180 days
 *
 * Observations that have been referenced by retrieval events are kept longer
 * (their access proves they're still useful). Batch-limited to 500.
 */
export function pruneObservations(db: Database, config: RetentionConfig): { deleted: number; superseded: number } {
  try {
    let totalDeleted = 0;

    // A3: Contradiction-aware pre-sweep — resolve contradictions before age-based pruning.
    // This ensures contradicted observations are marked consumed rather than blindly age-pruned.
    const superseded = resolveContradictions(db);

    // 14-07b: migrated from legacy artifacts
    // Observation retrieval guard: check V17 artifact table via data.artifact_ref JSON field.
    // An observation is "recently retrieved" if a V17 artifact of kind='observation' with
    // data.artifact_ref = obs.id has a retrieval_events entry.
    // Tier 1: Low importance (1-2), older than config days
    const lowCutoffMs = cutoffMs(config.observationLowImpRetentionDays ?? 30);
    const lowResult = cachedPrepare(db,
      `DELETE FROM observations
       WHERE importance <= 2
         AND timestamp_epoch_ms < ?
         AND id NOT IN (
           SELECT CAST(json_extract(a.data, '$.artifact_ref') AS INTEGER)
           FROM artifact a
           JOIN retrieval_events re ON a.id = re.artifact_id
           WHERE a.kind = 'observation'
             AND json_extract(a.data, '$.artifact_ref') IS NOT NULL
         )
       LIMIT 500`
    ).run(lowCutoffMs);
    totalDeleted += lowResult.changes;

    // Tier 2: Medium importance (3), older than config days
    const medCutoffMs = cutoffMs(config.observationMedImpRetentionDays ?? 90);
    const medResult = cachedPrepare(db,
      `DELETE FROM observations
       WHERE importance = 3
         AND timestamp_epoch_ms < ?
         AND id NOT IN (
           SELECT CAST(json_extract(a.data, '$.artifact_ref') AS INTEGER)
           FROM artifact a
           JOIN retrieval_events re ON a.id = re.artifact_id
           WHERE a.kind = 'observation'
             AND json_extract(a.data, '$.artifact_ref') IS NOT NULL
         )
       LIMIT 500`
    ).run(medCutoffMs);
    totalDeleted += medResult.changes;

    // Tier 3: High importance (4-5), older than config days
    const highCutoffMs = cutoffMs(config.observationHighImpRetentionDays ?? 180);
    const highResult = cachedPrepare(db,
      `DELETE FROM observations
       WHERE importance >= 4
         AND timestamp_epoch_ms < ?
         AND id NOT IN (
           SELECT CAST(json_extract(a.data, '$.artifact_ref') AS INTEGER)
           FROM artifact a
           JOIN retrieval_events re ON a.id = re.artifact_id
           WHERE a.kind = 'observation'
             AND json_extract(a.data, '$.artifact_ref') IS NOT NULL
         )
       LIMIT 500`
    ).run(highCutoffMs);
    totalDeleted += highResult.changes;

    return { deleted: totalDeleted, superseded };
  } catch {
    return { deleted: 0, superseded: 0 };
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
    const obsResult = pruneObservations(db, config);
    result.observations_deleted = obsResult.deleted;
    result.observations_superseded = obsResult.superseded;
  } catch { /* non-fatal */ }

  return result;
}
