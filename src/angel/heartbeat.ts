/**
 * Angel Heartbeat — configurable loop that runs when sessions are idle.
 *
 * Each tick:
 *   1. Check for idle active sessions → send warnings
 *   1b. Auto-close escalated idle sessions (warned but still idle after 30min)
 *   2. Find completed sessions the Angel hasn't processed → extract patterns
 *   3. Classify domains for unclassified sessions
 *   4. Guardian duties (pruning, verification, orphan cleanup)
 *   5. Memory monitor (CC auto-memory migration)
 *   6. Bulk artifact linking (Qdrant similarity)
 *   7. Observation consolidation (merge similar obs, rate-limited)
 *   8. RL policy training (lowest priority — only when idle)
 *   9. User profile sync (cross-project identity reconciliation)
 *   --- Guardian of All Memory phases ---
 *   4b. Data retention sweep (per-table lifecycle enforcement)
 *   4c. Cross-project knowledge consolidation (fingerprint dedup)
 *   4d. Data quality & integrity checks (0-obs fix, orphans, stale embeddings)
 *   4e. Proactive memory curation (promotion, decay, health reports, digests)
 *
 * The heartbeat only runs meaningful work — no busy loops.
 * Design: easy, fast, purposeful. Every piece earns its place.
 *
 * Non-throwing — individual tick failures don't kill the loop.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { AngelConfig } from './types.js';
import { getIdleSessions, getUnprocessedSessions, hasIdleWarning, markSessionProcessed, getEscalatedIdleSessions } from './session-monitor.js';
import { sendIdleWarning } from './message-sender.js';
import { extractPatternsFromSession, classifySessionDomains } from './pattern-extractor.js';
import { getUnverifiedFrequentPatterns, incrementVerificationCount } from '../intelligence/experience-patterns.js';
import { monitorMemoryFiles } from './memory-monitor.js';
import { consolidateObservationBatch, shouldConsolidate, markConsolidationRan } from './consolidator.js';
import { syncUserProfiles } from './user-profile-sync.js';
import { runRetentionSweep } from './retention-sweep.js';
import { runCrossProjectConsolidation } from './cross-project-consolidator.js';
import { runDataQualityChecks } from './data-quality.js';
import { runProactiveCuration } from './proactive-curator.js';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary } from '../core/session-events.js';
import { captureRecallFlowEntry } from '../adapters/shared/lifecycle.js';

export interface HeartbeatContext {
  db: Database;
  client: Anthropic;
  config: AngelConfig;
}

/** Telemetry for a single heartbeat tick. */
export interface TickResult {
  idle_warnings_sent: number;
  sessions_processed: number;
  patterns_extracted: number;
  domains_classified: number;
  learnings_pruned?: number;
  patterns_pruned?: number;
  memory_entries_migrated?: number;
  artifacts_linked?: number;
  embeddings_backfilled?: number;
  observations_consolidated?: number;
  consolidation_clusters?: number;
  sessions_auto_closed?: number;
  rl_training_episodes?: number;
  rl_avg_reward?: number;
  user_profiles_synced?: number;
  user_profile_conflicts?: number;
  // Guardian of All Memory
  retention_rows_deleted?: number;
  cross_project_deduped?: number;
  quality_issues_fixed?: number;
  artifacts_promoted?: number;
  artifacts_decayed?: number;
  health_report_sent?: boolean;
  duration_ms: number;
  error?: string;
}

/**
 * Execute a single heartbeat tick.
 * Non-throwing — returns result with error field on failure.
 */
export async function heartbeatTick(ctx: HeartbeatContext): Promise<TickResult> {
  const start = Date.now();
  const result: TickResult = {
    idle_warnings_sent: 0,
    sessions_processed: 0,
    patterns_extracted: 0,
    domains_classified: 0,
    duration_ms: 0,
  };

  try {
    // Phase 1: Idle session detection
    const idleSessions = getIdleSessions(ctx.db, ctx.config.idleThresholdSeconds);

    for (const session of idleSessions) {
      // Don't spam — only warn once
      if (!hasIdleWarning(ctx.db, session.session_id)) {
        const sent = sendIdleWarning(ctx.db, session.session_id, session.idle_minutes, session.topic);
        if (sent) result.idle_warnings_sent++;
      }
    }

    // Phase 1b: Auto-close escalated idle sessions
    // Sessions that were warned but are STILL idle get closed with summary + recall capture.
    // Intentionally lighter than /endsession (no checkpoint/pruning — no user present).
    // This prevents sessions from being orphaned when the user walks away.
    try {
      const escalated = getEscalatedIdleSessions(ctx.db, ctx.config.autoCloseMinutesAfterWarning);

      for (const session of escalated) {
        try {
          // 1. Synthesize session summary from events
          const events = getSessionEvents(ctx.db, session.session_id);
          const summary = synthesizeSessionSummary(events);
          if (summary) {
            saveSessionSummary(ctx.db, session.session_id, summary);
          }

          // 2. Capture recall flow entry for future session context
          captureRecallFlowEntry(ctx.db, session.session_id, session.project, events);

          // 3. Close the session
          const now = Math.floor(Date.now() / 1000);
          cachedPrepare(ctx.db,
            `UPDATE sessions SET status = 'completed', ended_at_epoch = ? WHERE session_id = ?`
          ).run(now, session.session_id);

          // 4. Record the auto-close event
          cachedPrepare(ctx.db,
            `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
             VALUES (?, ?, 'angel_auto_close', 'angel', 'auto_closed',
                     'Session auto-closed after ' || ? || ' minutes idle (warned, no response)')`
          ).run(session.session_id, session.project, session.idle_minutes);

          result.sessions_auto_closed = (result.sessions_auto_closed ?? 0) + 1;
        } catch {
          // Individual session auto-close failure — continue with others
        }
      }
    } catch {
      // Non-critical — auto-close failures don't break the heartbeat
    }

    // Phase 2: Process completed sessions (pattern extraction)
    // Process up to 5 sessions when running autonomously (no active sessions),
    // or 3 when the user is working (save resources for hook responsiveness).
    const hasActiveSessions = (cachedPrepare(ctx.db,
      `SELECT COUNT(*) as c FROM sessions WHERE status = 'active'`
    ).get() as { c: number }).c > 0;
    const batchSize = hasActiveSessions ? 3 : 5;
    const unprocessed = getUnprocessedSessions(ctx.db, batchSize);

    for (const session of unprocessed) {
      try {
        const extraction = await extractPatternsFromSession(
          ctx.db,
          session.session_id,
          session.project,
          ctx.client,
          ctx.config.cloudModel,
          ctx.config.maxPatternsPerSession,
          ctx.config.localModel,
        );

        result.sessions_processed++;
        result.patterns_extracted += extraction.patternsCreated;

        // Only mark as processed on definitive outcomes — NOT on transient failures.
        // 'too few turns', 'insufficient content', 'no corrections found' = definitive, mark processed.
        // 'extraction failed', 'no LLM available', 'empty LLM response' = transient, retry next tick.
        const definitiveOutcomes = ['too few turns', 'insufficient content', 'no corrections found'];
        const isDefinitive = extraction.patternsCreated > 0 || definitiveOutcomes.some(o => extraction.summary.includes(o));
        if (isDefinitive && extraction.patternsCreated === 0) {
          markSessionProcessed(ctx.db, session.session_id, session.project, extraction.summary);
        }

        // Phase 3: Domain classification for this session (Ollama only — trivial task)
        const domains = await classifySessionDomains(
          ctx.db,
          session.session_id,
          session.project,
          ctx.config.localModel,
        );
        result.domains_classified += domains;
      } catch {
        // Individual session processing failure — continue with others
      }
    }
    // Phase 4: Guardian duties — learning curation, pattern quality, DB maintenance
    try {
      // 4a: Prune garbage learnings (apply quality gate retroactively)
      const garbageLearnings = cachedPrepare(ctx.db,
        `SELECT id, content FROM learnings WHERE LENGTH(content) < 60 OR content LIKE '%?'`
      ).all() as Array<{ id: number; content: string }>;
      for (const l of garbageLearnings) {
        cachedPrepare(ctx.db, 'DELETE FROM learnings WHERE id = ?').run(l.id);
      }
      if (garbageLearnings.length > 0) {
        result.learnings_pruned = garbageLearnings.length;
      }

      // 4b: Prune low-quality patterns (harmful > helpful after 5+ triggers)
      const badPatterns = cachedPrepare(ctx.db,
        `SELECT id FROM experience_patterns
         WHERE times_triggered >= 5 AND harmful_count > helpful_count`
      ).all() as Array<{ id: string }>;
      for (const p of badPatterns) {
        cachedPrepare(ctx.db, 'DELETE FROM experience_patterns WHERE id = ?').run(p.id);
      }
      if (badPatterns.length > 0) {
        result.patterns_pruned = badPatterns.length;
      }

      // 4c: Auto-verify patterns with strong positive signal (triggered 5+ times, all helpful)
      const unverified = getUnverifiedFrequentPatterns(ctx.db, '__global__', 5);
      for (const p of unverified) {
        if (p.helpful_count >= 3 && p.harmful_count === 0) {
          incrementVerificationCount(ctx.db, p.id);
          incrementVerificationCount(ctx.db, p.id); // Needs 2 to become verified
        }
      }

      // 4d: Close orphaned sessions (active > 2 hours with no recent observations)
      const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
      const orphans = cachedPrepare(ctx.db,
        `SELECT session_id FROM sessions
         WHERE status = 'active' AND created_at_epoch < ?
         AND session_id NOT IN (
           SELECT DISTINCT session_id FROM observations
           WHERE timestamp_epoch > ?
         )`
      ).all(twoHoursAgo, twoHoursAgo) as Array<{ session_id: string }>;
      for (const o of orphans) {
        cachedPrepare(ctx.db,
          `UPDATE sessions SET status = 'completed', ended_at_epoch = ? WHERE session_id = ?`
        ).run(Math.floor(Date.now() / 1000), o.session_id);
      }
    } catch {
      // Guardian duties are non-critical — failures don't break the heartbeat
    }

    // Phase 5: Memory monitor — migrate CC auto-memory to Claudex DB
    try {
      const memResult = monitorMemoryFiles(ctx.db);
      if (memResult.entries_migrated > 0) {
        result.memory_entries_migrated = memResult.entries_migrated;
      }
    } catch {
      // Non-critical — memory monitoring failure doesn't break the heartbeat
    }

    // Phase 6: Bulk artifact linking — populate artifact_links via Qdrant similarity
    try {
      const linked = await linkUnlinkedArtifacts(ctx.db);
      if (linked > 0) {
        result.artifacts_linked = linked;
      }
    } catch {
      // Non-critical — linking failure doesn't break the heartbeat
    }

    // Phase 6b: Embedding backfill — process unembedded artifacts, journal, threads.
    // Only runs when no heavy work happened this tick (same constraint as RL training).
    // Rate-limited internally by backfillEmbeddings batch size.
    try {
      const heavyWorkRan = result.sessions_processed > 0
        || (result.artifacts_linked ?? 0) > 0
        || (result.sessions_auto_closed ?? 0) > 0;
      if (!heavyWorkRan) {
        const { backfillEmbeddings } = await import('../embeddings/embed-pipeline.js');
        const backfill = await backfillEmbeddings(ctx.db, 10);
        const total = backfill.artifacts + backfill.journal + backfill.threads;
        if (total > 0) {
          result.embeddings_backfilled = total;
        }
      }
    } catch {
      // Non-critical — backfill failure doesn't break the heartbeat
    }

    // Phase 7: Observation consolidation — merge similar observations into summaries
    // Rate-limited to once per 5 minutes. Skipped if pattern extraction ran this tick
    // (avoid competing for resources).
    try {
      const patternExtractionRan = result.sessions_processed > 0;
      if (!patternExtractionRan && shouldConsolidate()) {
        markConsolidationRan();
        const consResult = await consolidateObservationBatch(
          ctx.db,
          50,
          ctx.config.localModel,
        );
        if (consResult.consolidated > 0) {
          result.observations_consolidated = consResult.consolidated;
          result.consolidation_clusters = consResult.clusters;
        }
      }
    } catch {
      // Non-critical — consolidation failure doesn't break the heartbeat
    }

    // Phase 8: RL policy training — learn from accumulated reward signals
    // Lowest priority: only runs when no other heavy work happened this tick.
    // Rate-limited internally by trainPolicyBatch (needs 100+ reward signals).
    try {
      const heavyWorkRan = result.sessions_processed > 0
        || (result.observations_consolidated ?? 0) > 0
        || (result.artifacts_linked ?? 0) > 0;
      if (!heavyWorkRan) {
        const { trainPolicyBatch } = await import('../intelligence/rl-trainer.js');
        const project = cachedPrepare(ctx.db,
          `SELECT project FROM sessions WHERE status = 'active' ORDER BY created_at_epoch DESC LIMIT 1`
        ).get() as { project: string } | undefined;
        if (project?.project) {
          const trainResult = await trainPolicyBatch(ctx.db, project.project);
          if (trainResult.episodes > 0) {
            result.rl_training_episodes = trainResult.episodes;
            result.rl_avg_reward = trainResult.avgReward;
          }
        }
      }
    } catch {
      // Non-critical — training failure doesn't break the heartbeat
    }
    // Phase 9: User profile sync — cross-project identity reconciliation.
    // Scans CC auto-memory dirs for type: user files, resolves conflicts by mtime,
    // upserts canonical versions as __global__ artifacts. Rate-limited internally.
    try {
      const syncResult = await syncUserProfiles(ctx.db);
      if (syncResult.profiles_synced > 0) {
        result.user_profiles_synced = syncResult.profiles_synced;
      }
      if (syncResult.conflicts_resolved > 0) {
        result.user_profile_conflicts = syncResult.conflicts_resolved;
      }
    } catch {
      // Non-critical — user profile sync failure doesn't break the heartbeat
    }

    // =========================================================================
    // Guardian of All Memory — Phases 4b-4e
    // All pure SQL, no LLM calls, individually rate-limited and non-throwing.
    // =========================================================================

    // Phase 4b: Data retention sweep — per-table lifecycle enforcement.
    // Prunes conversation_turns (3-tier), artifacts, journal, events, etc.
    // Rate-limited internally (default: once per 60 min). Batch: 500 rows/table.
    try {
      const sweepResult = runRetentionSweep(ctx.db, ctx.config.retention);
      const totalDeleted = sweepResult.conversation_turns_skeletal
        + sweepResult.conversation_turns_deleted
        + sweepResult.artifacts_deleted
        + sweepResult.journal_entries_deleted
        + sweepResult.session_events_deleted
        + sweepResult.retrieval_events_deleted
        + sweepResult.artifact_links_deleted
        + sweepResult.verified_facts_deleted
        + sweepResult.session_messages_deleted;
      if (totalDeleted > 0) {
        result.retention_rows_deleted = totalDeleted;
      }
    } catch {
      // Non-critical — retention failure doesn't break the heartbeat
    }

    // Phase 4c: Cross-project knowledge consolidation — fingerprint-based dedup.
    // Merges identical learnings/decisions/patterns into __global__ scope.
    // Rate-limited internally (default: once per 60 min).
    try {
      const consolidation = runCrossProjectConsolidation(ctx.db, ctx.config.retention);
      const totalDeduped = consolidation.learnings_deduped
        + consolidation.decisions_deduped
        + consolidation.patterns_deduped
        + consolidation.learnings_propagated;
      if (totalDeduped > 0) {
        result.cross_project_deduped = totalDeduped;
      }
    } catch {
      // Non-critical — consolidation failure doesn't break the heartbeat
    }

    // Phase 4d: Data quality & integrity checks.
    // Fixes 0-observation sessions, cleans orphans, detects stale embeddings.
    // Rate-limited internally (default: once per 120 min).
    try {
      const qualityResult = runDataQualityChecks(ctx.db, ctx.config.retention);
      const totalFixed = qualityResult.zero_obs_sessions_queued
        + qualityResult.orphaned_records_deleted
        + qualityResult.stale_embeddings_nulled;
      if (totalFixed > 0) {
        result.quality_issues_fixed = totalFixed;
      }
    } catch {
      // Non-critical — quality check failure doesn't break the heartbeat
    }

    // Phase 4e: Proactive memory curation.
    // Promotes valuable artifacts, decays unused ones, detects contradictions,
    // manages project lifecycles, sends health reports, prepares away-digests.
    // Rate-limited internally (default: once per 60 min, health reports per 24h).
    try {
      const curationResult = runProactiveCuration(ctx.db, ctx.config.retention);
      if (curationResult.artifacts_promoted > 0) {
        result.artifacts_promoted = curationResult.artifacts_promoted;
      }
      if (curationResult.artifacts_decayed > 0) {
        result.artifacts_decayed = curationResult.artifacts_decayed;
      }
      if (curationResult.health_report_sent) {
        result.health_report_sent = true;
      }
    } catch {
      // Non-critical — curation failure doesn't break the heartbeat
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

// ---------------------------------------------------------------------------
// Phase 6: Bulk artifact linking
// ---------------------------------------------------------------------------

/** Rate limit: run bulk linking at most once per 5 minutes. */
let _lastLinkingEpoch = 0;
const LINKING_INTERVAL_MS = 5 * 60 * 1000;

/** Max artifacts to link per tick. */
const LINKING_BATCH_SIZE = 20;

/** Minimum cosine similarity for creating a link. */
const LINKING_THRESHOLD = 0.6;

/** Max outgoing links per artifact. */
const MAX_LINKS_PER_ARTIFACT = 5;

/**
 * Find artifacts with embeddings but no outgoing links, then create
 * bidirectional 'related' links to their nearest Qdrant neighbors.
 *
 * Rate-limited to once per 5 minutes to avoid Qdrant pressure.
 * Batch size: 20 artifacts per tick.
 *
 * Non-throwing — returns 0 on any failure.
 */
export async function linkUnlinkedArtifacts(
  db: Database,
  batchSize: number = LINKING_BATCH_SIZE,
): Promise<number> {
  try {
    // Rate limit
    const now = Date.now();
    if (now - _lastLinkingEpoch < LINKING_INTERVAL_MS) return 0;
    _lastLinkingEpoch = now;

    // Find artifacts with embeddings but no outgoing links
    const unlinked = cachedPrepare(db,
      `SELECT a.id, a.project FROM artifacts a
       LEFT JOIN artifact_links al ON a.id = al.source_id
       WHERE al.source_id IS NULL
         AND a.embedding IS NOT NULL
         AND a.state != 'packed'
       LIMIT ?`
    ).all(batchSize) as Array<{ id: number; project: string }>;

    if (unlinked.length === 0) return 0;

    // Dynamic import — Qdrant is optional
    const { searchArtifacts } = await import('../embeddings/qdrant-client.js');

    let linksCreated = 0;

    const insertStmt = cachedPrepare(db,
      `INSERT OR IGNORE INTO artifact_links (source_id, target_id, link_type, strength, valid_at_epoch)
       VALUES (?, ?, 'related', ?, ?)`
    );

    const nowEpoch = Math.floor(Date.now() / 1000);

    for (const artifact of unlinked) {
      try {
        // Get the artifact's embedding BLOB from SQLite
        const row = cachedPrepare(db,
          'SELECT embedding FROM artifacts WHERE id = ?'
        ).get(artifact.id) as { embedding: Buffer | null } | undefined;

        if (!row?.embedding) continue;

        // Decode Float32Array BLOB → number[] (inverse of Buffer.from(Float32Array.buffer))
        const buf = row.embedding;
        const embedding = Array.from(
          new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
        );
        if (embedding.length === 0) continue;

        // Search Qdrant for similar artifacts (top MAX_LINKS_PER_ARTIFACT + 1 to account for self)
        const neighbors = await searchArtifacts(
          embedding,
          artifact.project,
          MAX_LINKS_PER_ARTIFACT + 1,
          { excludeSuperseded: true },
        );

        for (const neighbor of neighbors) {
          const neighborId = typeof neighbor.id === 'number'
            ? neighbor.id
            : (neighbor.payload?.artifact_id as number);

          if (!neighborId || neighborId === artifact.id) continue;
          if (neighbor.score < LINKING_THRESHOLD) continue;

          // Bidirectional: A→B and B→A
          insertStmt.run(artifact.id, neighborId, neighbor.score, nowEpoch);
          insertStmt.run(neighborId, artifact.id, neighbor.score, nowEpoch);
          linksCreated++;
        }
      } catch {
        // Individual artifact linking failure — continue with others
      }
    }

    return linksCreated;
  } catch {
    return 0;
  }
}

/** Reset linking rate limit (for testing). */
export function resetLinkingRateLimit(): void {
  _lastLinkingEpoch = 0;
}

/** Adaptive interval bounds (ms). */
const ACTIVE_INTERVAL_MS = 2 * 60 * 1000;   // 2 min — user is working
const BACKLOG_INTERVAL_MS = 30 * 1000;       // 30 sec — backlog to clear
const WIND_DOWN_INTERVAL_MS = 5 * 60 * 1000; // 5 min — work done, cooling down
const IDLE_INTERVAL_MS = 10 * 60 * 1000;     // 10 min — nothing happening
const MAX_INTERVAL_MS = 30 * 60 * 1000;      // 30 min — fully dormant

/**
 * Check if there's a backlog of work the Angel should keep chewing through.
 * This is the key difference from a simple "did work happen" check — the Angel
 * stays awake independently until ALL pending work is done.
 */
function hasPendingBacklog(db: Database): boolean {
  try {
    // Unprocessed completed sessions (pattern extraction queue)
    const unprocessed = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM sessions
       WHERE status = 'completed'
         AND session_id NOT IN (
           SELECT DISTINCT session_id FROM session_events
           WHERE event_type = 'angel_processed'
         )
         AND session_id IN (
           SELECT DISTINCT session_id FROM conversation_turns
         )`
    ).get() as { c: number };
    if (unprocessed.c > 0) return true;

    // Unembedded artifacts (embedding backfill queue)
    const unembedded = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM artifacts
       WHERE embedding IS NULL AND content IS NOT NULL
         AND artifact_type IN ('session_log', 'decision', 'learning', 'handoff', 'memory_file')
       LIMIT 1`
    ).get() as { c: number };
    if (unembedded.c > 0) return true;

    // Unlinked artifacts with embeddings (linking queue)
    const unlinked = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM artifacts a
       LEFT JOIN artifact_links al ON a.id = al.source_id
       WHERE al.source_id IS NULL
         AND a.embedding IS NOT NULL
         AND a.state != 'packed'
       LIMIT 1`
    ).get() as { c: number };
    if (unlinked.c > 0) return true;

    // Unconsolidated observation clusters (consolidation queue)
    const unconsolidated = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM observations
       WHERE consumed = 0
         AND consolidated_into IS NULL
         AND deleted_at_epoch IS NULL
         AND importance >= 2`
    ).get() as { c: number };
    if (unconsolidated.c > 50) return true; // Only if meaningful batch

    return false;
  } catch {
    return false;
  }
}

/**
 * Compute the next heartbeat interval based on workload.
 *
 * Adaptive strategy — the Angel works independently until done:
 * 1. Pending backlog exists → 30 sec (keep working, don't sleep)
 * 2. Active sessions exist → 2 min (responsive to user)
 * 3. Work was done this tick → 5 min (cooling down)
 * 4. Nothing to do → exponential backoff 10 → 20 → 30 min
 *
 * The Angel stays awake autonomously to clear backlogs (unprocessed sessions,
 * unembedded artifacts, unlinkd artifacts) regardless of whether the user
 * is online. It only sleeps when ALL queues are empty.
 */
function computeNextInterval(
  db: Database,
  result: TickResult,
  consecutiveIdleTicks: number,
): { intervalMs: number; idle: boolean } {
  try {
    // Priority 1: Pending backlog — stay awake and keep working
    if (hasPendingBacklog(db)) {
      return { intervalMs: BACKLOG_INTERVAL_MS, idle: false };
    }

    // Priority 2: Active sessions — responsive to user
    const active = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM sessions WHERE status = 'active'`
    ).get() as { c: number };

    if (active.c > 0) {
      return { intervalMs: ACTIVE_INTERVAL_MS, idle: false };
    }

    // Priority 3: Work was done this tick — more may come
    const workDone = (result.sessions_processed ?? 0) > 0
      || (result.patterns_extracted ?? 0) > 0
      || (result.retention_rows_deleted ?? 0) > 0
      || (result.cross_project_deduped ?? 0) > 0
      || (result.quality_issues_fixed ?? 0) > 0
      || (result.observations_consolidated ?? 0) > 0
      || (result.artifacts_linked ?? 0) > 0
      || (result.embeddings_backfilled ?? 0) > 0
      || (result.user_profiles_synced ?? 0) > 0
      || (result.artifacts_promoted ?? 0) > 0
      || (result.artifacts_decayed ?? 0) > 0;

    if (workDone) {
      return { intervalMs: WIND_DOWN_INTERVAL_MS, idle: false };
    }

    // Priority 4: Nothing to do — exponential backoff
    const backoff = Math.min(
      IDLE_INTERVAL_MS * Math.pow(2, consecutiveIdleTicks),
      MAX_INTERVAL_MS,
    );
    return { intervalMs: backoff, idle: true };
  } catch {
    return { intervalMs: IDLE_INTERVAL_MS, idle: true };
  }
}

/**
 * Start the adaptive heartbeat loop. Runs indefinitely until the process is killed.
 *
 * The interval adapts to workload:
 * - 2 min when active sessions exist (the user is working)
 * - 5 min when background work remains (pattern extraction, retention, etc.)
 * - 10-30 min exponential backoff when fully idle
 *
 * Returns a cleanup function.
 */
export function startHeartbeat(
  ctx: HeartbeatContext,
  onTick?: (result: TickResult) => void,
): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = true;
  let consecutiveIdleTicks = 0;

  async function tick() {
    if (!running) return;

    const result = await heartbeatTick(ctx);
    onTick?.(result);

    if (running) {
      const { intervalMs, idle } = computeNextInterval(ctx.db, result, consecutiveIdleTicks);
      consecutiveIdleTicks = idle ? consecutiveIdleTicks + 1 : 0;
      timer = setTimeout(tick, intervalMs);
    }
  }

  // Run first tick after a short delay (let the process settle)
  timer = setTimeout(tick, 5000);

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}
