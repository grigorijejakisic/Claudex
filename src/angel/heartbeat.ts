/**
 * Angel Heartbeat — configurable loop that runs when sessions are idle.
 *
 * Each tick:
 *   1. Check for idle active sessions → send warnings
 *   1b. Auto-close escalated idle sessions (warned but still idle after 30min)
 *   1c. Stuck detection on active sessions (A11) → send intervention
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

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { AngelConfig } from './types.js';
import { getIdleSessions, getUnprocessedSessions, hasIdleWarning, markSessionProcessed, getEscalatedIdleSessions, detectStuckSession } from './session-monitor.js';
import { sendIdleWarning, sendMessage } from './message-sender.js';
import { extractPatternsFromSession, classifySessionDomains, crystallizePatternToSkill } from './pattern-extractor.js';
import { getUnverifiedFrequentPatterns, incrementVerificationCount } from '../intelligence/experience-patterns.js';
import { monitorMemoryFiles } from './memory-monitor.js';
import { consolidateObservationBatch, shouldConsolidate, markConsolidationRan, runDreamConsolidation } from './consolidator.js';
import { syncUserProfiles } from './user-profile-sync.js';
import { runRetentionSweep } from './retention-sweep.js';
import * as path from 'path';
import { runCrossProjectConsolidation } from './cross-project-consolidator.js';
import { runDataQualityChecks } from './data-quality.js';
import { runProactiveCuration } from './proactive-curator.js';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary } from '../core/session-events.js';
import { captureRecallFlowEntry } from '../adapters/shared/lifecycle.js';
import type { RerankerSupervisor } from './reranker-supervisor.js';

export interface HeartbeatContext {
  db: Database;
  config: AngelConfig;
  /**
   * Optional supervisor references injected from main(). The heartbeat uses
   * them to drive recovery when service health checks fail — e.g., calling
   * `rerankerSupervisor.ensureRunning()` when the reranker /health probe
   * returns down. Tests may omit this field.
   */
  rerankerSupervisor?: RerankerSupervisor;
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
  patterns_promoted_to_always?: number;
  patterns_merged?: number;
  entities_summarized?: number;
  entities_updated?: number;
  // Dream consolidation
  dream_contradictions_resolved?: number;
  dream_stale_flagged?: number;
  // Phase 11: Angel Intelligence
  stuck_detected?: number;
  skills_crystallized?: number;
  // Local Intelligence Amplifier
  services_down?: string[];
  codebase_files_indexed?: number;
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

          // 5. Git commit — every session end produces a commit
          try {
            const { execSync } = require('child_process');
            const { resolveProjectPath } = require('../shared/scope-detector.js');
            const projectPath = resolveProjectPath(session.project);
            if (projectPath) {
              execSync('git add -A && git diff --cached --quiet || git commit -m "session(auto-close): Angel auto-closed idle session"', {
                cwd: projectPath,
                stdio: 'ignore',
                timeout: 10000,
              });
            }
          } catch { /* git commit failure is non-fatal */ }

          result.sessions_auto_closed = (result.sessions_auto_closed ?? 0) + 1;
        } catch {
          // Individual session auto-close failure — continue with others
        }
      }
    } catch {
      // Non-critical — auto-close failures don't break the heartbeat
    }

    // Phase 1c: Stuck session detection (A11)
    // Active (non-idle) sessions that are making no progress get an intervention.
    // Detects: repeated tool failures, looping prompts, no file progress.
    try {
      const activeSessions = cachedPrepare(ctx.db,
        `SELECT session_id, project FROM sessions WHERE status = 'active'`
      ).all() as Array<{ session_id: string; project: string }>;

      for (const session of activeSessions) {
        const stuckResult = detectStuckSession(ctx.db, session.session_id);
        if (stuckResult?.stuck) {
          const content = `Stuck session detected: ${stuckResult.reason}. Consider a different approach, or try reading the error message carefully and addressing the root cause.`;
          sendMessage(ctx.db, session.session_id, content, 'advisory', 'urgent');
          result.stuck_detected = (result.stuck_detected ?? 0) + 1;
        }
      }
    } catch {
      // Non-critical — stuck detection failure doesn't break the heartbeat
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
          ctx.config.maxPatternsPerSession,
          ctx.config.localModel,
        );

        result.sessions_processed++;
        result.patterns_extracted += extraction.patternsCreated;

        // Only mark as processed on definitive outcomes — NOT on transient failures.
        // 'too few turns', 'insufficient content', 'no patterns found/array' = definitive, mark processed.
        // 'extraction failed', 'no LLM available', 'empty LLM response' = transient, retry next tick.
        const definitiveOutcomes = ['too few turns', 'insufficient content', 'no patterns found', 'no patterns array'];
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
    // Service health checks — warn active sessions if critical services are down
    // =========================================================================
    //
    // Each down service records a structured outcome describing what the
    // heartbeat actually did (vs. the prior hardcoded "Auto-restart attempted"
    // string, which lied when no restart was attempted). The outcomes are
    // joined into the advisory so the user sees the truth: "restart attempted
    // in background", "restart succeeded", "cool-down 540s remaining", etc.
    try {
      // Qdrant removed in Phase 5 — vector search is now in-process via
      // sqlite-vec (no separate service to health-check).
      const services = [
        { name: 'CliProxy', url: 'http://127.0.0.1:8317/v1/models', purpose: 'LLM routing (Sonnet/GPT)' },
        { name: 'Reranker', url: 'http://127.0.0.1:7439/health', purpose: 'Neural cross-encoder (CUDA)' },
        { name: 'Ollama', url: 'http://localhost:11434/api/tags', purpose: 'Embeddings + local LLM' },
      ];
      interface DownOutcome { label: string; outcome: string; }
      const downOutcomes: DownOutcome[] = [];
      for (const svc of services) {
        let down = false;
        try {
          const resp = await fetch(svc.url, { signal: AbortSignal.timeout(3000) });
          if (!resp.ok) down = true;
        } catch {
          down = true;
        }
        if (down) {
          downOutcomes.push({ label: `${svc.name} (${svc.purpose})`, outcome: 'no auto-restart available' });
        }
      }
      if (downOutcomes.length > 0) {
        result.services_down = downOutcomes.map(o => o.label);

        // Reranker recovery: delegate to RerankerSupervisor.ensureRunning().
        // The supervisor owns the spawn/restart lifecycle including bounded
        // retries + cool-down; the heartbeat just kicks it when the service
        // is observed down. This replaces the old "supervisor is only called
        // once at Angel start" pattern that left the reranker permanently
        // dead after the first failure.
        const rerankerEntry = downOutcomes.find(o => o.label.includes('Reranker'));
        if (rerankerEntry && ctx.rerankerSupervisor) {
          try {
            const res = await ctx.rerankerSupervisor.ensureRunning();
            if (res.running) {
              rerankerEntry.outcome = res.attempted ? 'restart succeeded' : `recovered (${res.reason})`;
              // It's no longer down — drop it from the advisory entirely.
              const idx = downOutcomes.indexOf(rerankerEntry);
              if (idx >= 0) downOutcomes.splice(idx, 1);
              if (result.services_down) {
                result.services_down = result.services_down.filter(l => !l.includes('Reranker'));
              }
            } else {
              rerankerEntry.outcome = res.attempted
                ? `restart failed: ${res.reason}`
                : res.reason;
            }
          } catch (err) {
            rerankerEntry.outcome = `supervisor error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // CliProxy recovery: opportunistic detached spawn. Distinct from
        // reranker because CliProxy has no dedicated supervisor class — we
        // use the canonical Node detached-spawn pattern (not `start /B`,
        // which does not fully detach on Windows).
        const cliProxyEntry = downOutcomes.find(o => o.label.includes('CliProxy'));
        if (cliProxyEntry) {
          try {
            const { execSync, spawn } = await import('child_process');

            const isRunning = (processName: string): boolean => {
              try {
                const out = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, {
                  shell: 'cmd.exe', timeout: 3000, windowsHide: true, encoding: 'utf-8',
                });
                return out.toLowerCase().includes(processName.toLowerCase());
              } catch { return false; }
            };

            const spawnDetached = (command: string, args: string[] = [], cwd?: string): boolean => {
              try {
                const child = spawn(command, args, {
                  detached: true,
                  stdio: 'ignore',
                  windowsHide: true,
                  cwd,
                  shell: false,
                });
                child.unref();
                return true;
              } catch {
                return false;
              }
            };

            if (!isRunning('cli-proxy-api.exe')) {
              const spawned = spawnDetached('cli-proxy-api.exe');
              cliProxyEntry.outcome = spawned
                ? 'detached-spawn attempted'
                : 'detached-spawn failed';
            } else {
              cliProxyEntry.outcome = 'process running but /v1/models not responding';
            }
          } catch (err) {
            cliProxyEntry.outcome = `restart error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // If anything is still down after recovery attempts, advise active sessions.
        if (downOutcomes.length > 0) {
          const advisory = '⚠ Services down: '
            + downOutcomes.map(o => `${o.label} — ${o.outcome}`).join('; ');
          const activeSessions = cachedPrepare(ctx.db,
            `SELECT session_id FROM sessions WHERE status = 'active' ORDER BY created_at_epoch DESC LIMIT 5`
          ).all() as Array<{ session_id: string }>;
          const { sendMessage: sendMsg } = await import('./message-sender.js');
          for (const s of activeSessions) {
            sendMsg(ctx.db, s.session_id, advisory, 'advisory', 'advisory');
          }
        }
      }
    } catch { /* non-critical */ }

    // =========================================================================
    // Guardian of All Memory — Phases 4b-4e
    // All pure SQL, no LLM calls, individually rate-limited and non-throwing.
    // KAIROS-inspired triple gate: time + session-count + mutual exclusion.
    // =========================================================================

    // Triple gate check: skip heavy consolidation unless enough new sessions exist.
    const totalCompletedSessions = (cachedPrepare(ctx.db,
      `SELECT COUNT(*) as cnt FROM sessions WHERE status = 'completed'`
    ).get() as { cnt: number }).cnt;
    const sessionsSinceLastConsolidation = totalCompletedSessions - _sessionsAtLastConsolidation;
    const heavyConsolidationTimeElapsed = Date.now() - _lastHeavyConsolidationEpoch >= CONSOLIDATION_INTERVAL_MS;
    const heavyConsolidationGatePassed = sessionsSinceLastConsolidation >= HEAVY_CONSOLIDATION_MIN_SESSIONS
      && heavyConsolidationTimeElapsed;

    if (heavyConsolidationGatePassed) {
      _lastHeavyConsolidationEpoch = Date.now();
      _sessionsAtLastConsolidation = totalCompletedSessions;
    }

    // Phase 4b: Data retention sweep — per-table lifecycle enforcement.
    // Prunes conversation_turns (3-tier), artifacts, journal, events, etc.
    // Rate-limited internally (default: once per 60 min). Batch: 500 rows/table.
    // Retention sweep always runs (time-gated internally) — not session-gated.
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
    // Triple-gated: only runs when enough new sessions exist.
    if (heavyConsolidationGatePassed) try {
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
    // Triple-gated: only runs when enough new sessions exist.
    if (heavyConsolidationGatePassed) try {
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

    // Phase 4d2: Codebase index refresh (Amp Phase 3).
    // Re-indexes active projects' source files. Incremental — only changed files.
    // Rate-limited: once per heartbeat cycle (runs fast due to MD5 hash skip).
    try {
      const { indexProject } = await import('../indexer/codebase-indexer.js');
      const activeProjects = cachedPrepare(ctx.db,
        `SELECT DISTINCT p.project, s.cwd FROM sessions s
         JOIN (SELECT project, MAX(created_at_epoch) as latest FROM sessions WHERE status = 'active' GROUP BY project) p
         ON s.project = p.project AND s.created_at_epoch = p.latest
         LIMIT 3`
      ).all() as Array<{ project: string; cwd: string | null }>;

      let totalIndexed = 0;
      for (const p of activeProjects) {
        if (!p.cwd) continue;
        const srcPath = path.join(p.cwd, 'src');
        try {
          const { indexed } = indexProject(ctx.db, p.project, srcPath);
          totalIndexed += indexed;
        } catch { /* individual project failure — continue */ }
      }
      if (totalIndexed > 0) {
        result.codebase_files_indexed = totalIndexed;
      }
    } catch { /* non-critical */ }

    // Phase 4d3: MemRL temporal decay (Amp Phase 2).
    // Rate-limited to once per 24h — decay is designed as 1%/day.
    try {
      const nowMs = Date.now();
      if (nowMs - _lastDecayEpoch >= 86_400_000) { // 24 hours
        _lastDecayEpoch = nowMs;
        const { applyTemporalDecay } = await import('../intelligence/memrl-scorer.js');
        applyTemporalDecay(ctx.db, 1); // exactly 1 day of decay
      }
    } catch { /* non-critical */ }

    // Phase 4e: Proactive memory curation.
    // Promotes valuable artifacts, decays unused ones, detects contradictions,
    // manages project lifecycles, sends health reports, prepares away-digests.
    // Triple-gated: only runs when enough new sessions exist.
    if (heavyConsolidationGatePassed) try {
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

    // Phase 4e2: Entity summary generation (Hindsight-inspired observation layer).
    // Generates consolidated summaries for recurring entities with trend computation.
    // Triple-gated + time-gated: only runs when enough new sessions AND time has passed.
    if (heavyConsolidationGatePassed) try {
      const now = Date.now();
      if (now - _lastConsolidationEpoch >= CONSOLIDATION_INTERVAL_MS * 0.5) {
        const { generateEntitySummaries } = await import('./entity-summarizer.js');
        const entityResult = await generateEntitySummaries(ctx.db, ctx.config.cloudModel);
        if (entityResult.entities_summarized > 0 || entityResult.entities_updated > 0) {
          result.entities_summarized = entityResult.entities_summarized;
          result.entities_updated = entityResult.entities_updated;
        }
      }
    } catch {
      // Non-critical
    }

    // Phase 4e3a: Cross-agent session indexing — learn from Codex, Gemini, Aider sessions.
    try {
      const { indexCrossAgentSessions } = await import('../intelligence/cross-agent-indexer.js');
      const activeProject = cachedPrepare(ctx.db,
        `SELECT project FROM sessions WHERE status = 'active' ORDER BY created_at_epoch DESC LIMIT 1`
      ).get() as { project: string } | undefined;
      if (activeProject?.project) {
        indexCrossAgentSessions(ctx.db, 'angel-heartbeat', activeProject.project);
      }
    } catch { /* non-critical */ }

    // Phase 4e3b: Autonomous investigation — Angel reasons about uncertain opinions.
    // Picks low-confidence or contradicted opinions, searches memory for evidence,
    // and updates confidence based on what it finds. CARA "Reflect" operation.
    try {
      const { runAutonomousInvestigation } = await import('./autonomous-investigator.js');
      const activeProject = cachedPrepare(ctx.db,
        `SELECT project FROM sessions WHERE status = 'active' ORDER BY created_at_epoch DESC LIMIT 1`
      ).get() as { project: string } | undefined;
      if (activeProject?.project) {
        runAutonomousInvestigation(ctx.db, activeProject.project);
      }
    } catch { /* non-critical */ }

    // Phase 4e3c: CARA reasoning — derive opinions from proven patterns.
    // Angel forms opinions about tools, approaches, and patterns based on evidence.
    try {
      const { deriveOpinionsFromPatterns } = await import('./cara-reasoning.js');
      const projects = cachedPrepare(ctx.db,
        `SELECT DISTINCT project FROM sessions WHERE status = 'active' LIMIT 5`
      ).all() as Array<{ project: string }>;
      for (const p of projects) {
        if (p.project) deriveOpinionsFromPatterns(ctx.db, p.project);
      }
    } catch { /* non-critical */ }

    // Phase 4e4: Dream consolidation — holistic memory quality pass.
    // Contradiction detection (topic_key duplicates) + staleness pruning (dead file paths).
    // Triple-gated: only runs when enough new sessions exist.
    if (heavyConsolidationGatePassed) try {
      const dreamResult = runDreamConsolidation(ctx.db, process.cwd());
      if (dreamResult.contradictions_resolved > 0 || dreamResult.stale_learnings_flagged > 0 || dreamResult.stale_decisions_flagged > 0) {
        result.dream_contradictions_resolved = dreamResult.contradictions_resolved;
        result.dream_stale_flagged = (dreamResult.stale_learnings_flagged + dreamResult.stale_decisions_flagged);
      }
    } catch { /* non-critical */ }

    // Phase 4f: Pattern consolidation.
    // Clusters related experience patterns and promotes proven ones to 'always' retrieval mode.
    // Patterns that reach 'proven' maturity with score >= 50 are promoted to always-inject.
    // Rate-limited: once per 30 minutes.
    try {
      const now = Date.now();
      if (now - _lastConsolidationEpoch >= CONSOLIDATION_INTERVAL_MS) {
        _lastConsolidationEpoch = now;
        let promoted = 0;

        // Graduate saturated always-inject patterns to CLAUDE.md rules
        // Patterns triggered 100+ times with 90%+ helpful rate are fully proven —
        // they belong in permanent rules, not the dynamic injection budget.
        const MAX_ALWAYS_PATTERNS = 5;
        const saturated = cachedPrepare(ctx.db,
          `SELECT id, trigger_context, lesson, times_triggered, helpful_count, harmful_count
           FROM experience_patterns
           WHERE retrieval_mode = 'always' AND times_triggered >= 100
             AND CAST(helpful_count AS REAL) / MAX(helpful_count + harmful_count, 1) >= 0.9
           ORDER BY times_triggered DESC`
        ).all() as Array<{ id: string; trigger_context: string; lesson: string; times_triggered: number; helpful_count: number; harmful_count: number }>;

        // Graduate excess saturated patterns to 'categorical' (they're in CLAUDE.md already via Angel-Promoted Rules)
        const currentAlwaysCount = (cachedPrepare(ctx.db,
          `SELECT COUNT(*) as c FROM experience_patterns WHERE retrieval_mode = 'always'`
        ).get() as { c: number }).c;

        if (currentAlwaysCount > MAX_ALWAYS_PATTERNS && saturated.length > 0) {
          // Graduate the most-triggered saturated patterns to make room
          const toGraduate = saturated.slice(0, currentAlwaysCount - MAX_ALWAYS_PATTERNS);
          for (const g of toGraduate) {
            try {
              cachedPrepare(ctx.db,
                `UPDATE experience_patterns SET retrieval_mode = 'categorical' WHERE id = ?`
              ).run(g.id);
              promoted++; // Count as a promotion action (graduation)
            } catch { /* non-fatal */ }
          }
        }

        // Promote high-confidence proven patterns to 'always' retrieval mode
        // Only if we have room (under the cap)
        const updatedAlwaysCount = (cachedPrepare(ctx.db,
          `SELECT COUNT(*) as c FROM experience_patterns WHERE retrieval_mode = 'always'`
        ).get() as { c: number }).c;

        if (updatedAlwaysCount < MAX_ALWAYS_PATTERNS) {
          const candidates = cachedPrepare(ctx.db,
            `SELECT id, score, retrieval_mode FROM experience_patterns
             WHERE maturity = 'proven' AND score >= 50 AND retrieval_mode = 'reactive'
             ORDER BY score DESC
             LIMIT ?`
          ).all(MAX_ALWAYS_PATTERNS - updatedAlwaysCount) as Array<{ id: string; score: number; retrieval_mode: string }>;

          for (const c of candidates) {
            try {
              cachedPrepare(ctx.db,
                `UPDATE experience_patterns SET retrieval_mode = 'always' WHERE id = ?`
              ).run(c.id);
              promoted++;
            } catch { /* individual promotion failure */ }
          }
        }

        if (promoted > 0) {
          result.patterns_promoted_to_always = promoted;
        }

        // Merge similar patterns using Qdrant semantic similarity + LLM synthesis.
        // For each high-score pattern, find semantically similar ones via vector search.
        // If found, use LLM to synthesize an abstract principle, then merge.
        // Falls back to string-matching merge when Qdrant/LLM unavailable.
        try {
          const { findSimilarPatterns } = await import('../intelligence/experience-patterns.js');
          const mergeTargets = cachedPrepare(ctx.db,
            `SELECT id, trigger_context, lesson, score FROM experience_patterns
             WHERE score >= 5 ORDER BY score DESC LIMIT 10`
          ).all() as Array<{ id: string; trigger_context: string; lesson: string; score: number }>;

          const merged = new Set<string>();
          for (const target of mergeTargets) {
            if (merged.has(target.id)) continue;
            const similar = await findSimilarPatterns(ctx.db, target.id, target.trigger_context, 3, 0.80);
            const toMerge = similar.filter(s => !merged.has(s.id) && s.id !== target.id);
            if (toMerge.length === 0) continue;

            // Try LLM synthesis — combine lessons into one abstract principle
            let synthesizedLesson = target.lesson;
            try {
              const lessons = [target.lesson, ...toMerge.map(m => m.lesson)].join('\n- ');
              const prompt = `These are related learnings from a coding assistant's experience:\n- ${lessons}\n\nSynthesize ONE concise abstract principle (max 200 chars) that captures the common rule. Output only the principle, nothing else.`;

              const resp = await fetch('http://127.0.0.1:8317/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer cliproxy-no-key-needed',
                },
                body: JSON.stringify({
                  model: ctx.config.cloudModel,
                  messages: [{ role: 'user', content: prompt }],
                  max_tokens: 256,
                  temperature: 0,
                }),
                signal: AbortSignal.timeout(30000),
              });
              if (resp.ok) {
                const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
                const text = (data.choices?.[0]?.message?.content ?? '').trim();
                if (text.length > 10 && text.length < 300) {
                  synthesizedLesson = text;
                }
              }
            } catch { /* LLM failed — keep original lesson */ }

            // Merge: absorb scores, update lesson, delete absorbed patterns
            let totalAbsorbed = 0;
            for (const m of toMerge) {
              cachedPrepare(ctx.db,
                `UPDATE experience_patterns SET score = score + ? WHERE id = ?`
              ).run(m.score, target.id);
              cachedPrepare(ctx.db,
                `DELETE FROM experience_patterns WHERE id = ?`
              ).run(m.id);
              merged.add(m.id);
              totalAbsorbed += m.score;
            }

            // Update lesson with synthesized version
            if (synthesizedLesson !== target.lesson) {
              cachedPrepare(ctx.db,
                `UPDATE experience_patterns SET lesson = ? WHERE id = ?`
              ).run(synthesizedLesson, target.id);
            }
          }

          if (merged.size > 0) {
            result.patterns_merged = merged.size;
          }
        } catch { /* non-fatal — consolidation is best-effort */ }
      }
    } catch {
      // Non-critical
    }

    // Phase 4g: Skill crystallization (A10)
    // Crystallize proven patterns (maturity='proven', confidence>=0.8) into SKILL.md files.
    // Capped at 1 per heartbeat tick. Rate-limited by Phase 4f interval.
    try {
      const crystallized = crystallizePatternToSkill(ctx.db);
      if (crystallized > 0) {
        result.skills_crystallized = crystallized;
      }
    } catch {
      // Non-critical
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

/** Rate limit: run pattern consolidation at most once per 30 minutes. */
let _lastConsolidationEpoch = 0;
let _lastDecayEpoch = 0;
const CONSOLIDATION_INTERVAL_MS = 30 * 60 * 1000;

/**
 * KAIROS-inspired triple gate for heavy consolidation phases (4b-4f, entity summarization).
 * Gate 1: Time — minimum interval since last heavy consolidation (CONSOLIDATION_INTERVAL_MS).
 * Gate 2: Session count — at least N sessions completed since last consolidation run.
 * Gate 3: Mutual exclusion — single-threaded tick loop already enforces this.
 *
 * Prevents wasteful consolidation when there's no new data to process.
 */
let _lastHeavyConsolidationEpoch = 0;
let _sessionsAtLastConsolidation = 0;
const HEAVY_CONSOLIDATION_MIN_SESSIONS = 3;

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

/** Reset heavy consolidation gate (for testing). */
export function resetHeavyConsolidationGate(): void {
  _lastHeavyConsolidationEpoch = 0;
  _sessionsAtLastConsolidation = 0;
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
