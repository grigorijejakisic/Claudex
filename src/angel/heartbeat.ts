/**
 * Angel Heartbeat — configurable loop that runs when sessions are idle.
 *
 * Each tick:
 *   1. Check for idle active sessions → send warnings
 *   1b. Auto-close escalated idle sessions (warned but still idle after 30min)
 *   1c. Stuck detection on active sessions (A11) → send intervention
 *   2. Find completed sessions the Angel hasn't processed → extract patterns
 *   3. Classify domains for unclassified sessions
 *   12. Curated context extraction (P2.1 injection slot fallback)
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
import { getIdleSessions, getUnprocessedSessions, hasIdleWarning, getEscalatedIdleSessions, detectStuckSession } from './session-monitor.js';
import { sendIdleWarning, sendMessage } from './message-sender.js';
import { classifySessionDomains } from './domain-classifier.js';
import {
  extractCuratedContextFromSession,
  getSessionsPendingCuratedExtraction,
} from './curated-context-extractor.js';
import { getUnverifiedFrequentPatterns, incrementVerificationCount } from '../intelligence/experience-patterns.js';
import { extractDirectivesFromSession } from '../intelligence/directive-detector.js';
import { monitorMemoryFiles } from './memory-monitor.js';
import { consolidateObservationBatch, shouldConsolidate, markConsolidationRan } from './consolidator.js';
import { syncUserProfiles } from './user-profile-sync.js';
import { runRetentionSweep } from './retention-sweep.js';
import { backfillTaskPatternsBatch } from './task-pattern-classifier.js';
import { getPidFilePath } from './pid-file.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getSessionEvents, synthesizeSessionSummary, saveSessionSummary } from '../core/session-events.js';
import { captureRecallFlowEntry } from '../adapters/shared/lifecycle.js';
import { writeEnvironmentalEvent } from '../core/episodic-events.js';
import { GLOBAL_PROJECT_SCOPE } from '../shared/constants.js';
import type { RerankerSupervisor } from './reranker-supervisor.js';
import type { LlamaServerSupervisor } from './llama-server-supervisor.js';
import {
  checkLlamaServerHealth,
  isCloudModel,
  LLAMA_MODEL_ALIAS,
} from './llama-client.js';

export interface HeartbeatContext {
  db: Database;
  config: AngelConfig;
  /**
   * Optional supervisor references injected from main(). The heartbeat uses
   * them to drive recovery when service health checks fail — e.g., calling
   * `rerankerSupervisor.ensureRunning()` when the reranker /health probe
   * returns down, or `llamaServerSupervisor.ensureRunning()` when the
   * llama-server /v1/models probe returns down. Tests may omit these.
   */
  rerankerSupervisor?: RerankerSupervisor;
  llamaServerSupervisor?: LlamaServerSupervisor;
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
  user_profiles_synced?: number;
  user_profile_conflicts?: number;
  // Guardian of All Memory
  retention_rows_deleted?: number;
  patterns_promoted_to_always?: number;
  patterns_merged?: number;
  entities_summarized?: number;
  entities_updated?: number;
  // Dream consolidation
  // Phase 11: Angel Intelligence
  stuck_detected?: number;
  // Phase 12: Curated Context Extraction
  curated_entries_proposed?: number;
  curated_sessions_scanned?: number;
  // Phase 2b: Directive detection (P2)
  directives_extracted?: number;
  directives_errors?: number;
  // Phase 5b: Session-completion artifact curation (P3, plan 04-04)
  chunks_created?: number;
  memory_md_written?: number;
  memory_curation_no_project_dir?: number;
  memory_curation_errors?: number;
  // Phase 5c: Phase 4.1 bridge sweeps (Plan 07)
  feedback_rules_promoted?: number;
  multi_project_markers_updated?: number;
  shape_vocab_promoted?: number;
  // Phase 5d: Phase 5.5 curation feedback sweeps
  pointers_archived?: number;
  pointers_promoted?: number;
  curation_errors?: number;
  // Local Intelligence Amplifier
  services_down?: string[];
  codebase_files_indexed?: number;
  // Phase 6: crash-resilient episode boundary tick
  boundary_closes_emitted?: number;
  boundary_closes_aborted?: number;
  boundary_reopens_emitted?: number;
  boundary_reopens_anomalous?: number;
  boundary_cursor_replays?: number;
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
    // Phase 4: dead — no extractor exists. Field kept to avoid breaking
    // observability surfaces (CLI dashboard, telemetry consumers). Phase 7
    // retirement work removes the field entirely.
    sessions_processed: 0,
    patterns_extracted: 0,
    domains_classified: 0,
    duration_ms: 0,
  };

  // V5 Plan 01-03 (EPI-03): episode-substrate environmental_event marker for
  // the tick. Required by Phase 6's idle-timeout sweep — fsnotify needs
  // heartbeat rows to distinguish "active" from "dormant" processes/sessions.
  // Angel may fire-and-forget per .claude/rules/hooks-safety.md, but
  // writeEnvironmentalEvent is synchronous so we just call it. Failures are
  // recorded as telemetry by the helper; we additionally swallow any throw
  // here so a substrate write does not break the heartbeat loop.
  try {
    writeEnvironmentalEvent({
      db: ctx.db,
      sessionId: 'angel-heartbeat',
      project: GLOBAL_PROJECT_SCOPE,
      type: 'environmental_event',
      source: 'angel/heartbeat',
      content: 'Heartbeat tick',
      metadata: { tick_started_epoch_ms: start },
    });
  } catch { /* non-fatal; telemetry-on-rollback already recorded */ }

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

          // 4b. Queue MEMORY.md curation — same trigger as /endsession hook
          // (plan 04-04-01). The user isn't around to run the /endsession
          // skill, so the auto-close path must enqueue too. Phase 5b picks
          // it up on a subsequent tick.
          cachedPrepare(ctx.db,
            `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
             VALUES (?, ?, 'memory_curation_pending', 'angel', 'enqueue', ?)`
          ).run(
            session.session_id,
            session.project,
            JSON.stringify({ project: session.project, session_id: session.session_id }),
          );

          // 5. Git commit — every session end produces a commit.
          // Direct execFileSync (no shell) so the embedded commit message
          // doesn't depend on cmd.exe vs /bin/sh quoting rules.
          try {
            const { execFileSync } = require('child_process');
            const { resolveProjectPath } = require('../shared/scope-detector.js');
            const projectPath = resolveProjectPath(session.project);
            if (projectPath) {
              const gitOpts = { cwd: projectPath, stdio: 'ignore' as const, timeout: 10000 };
              execFileSync('git', ['add', '-A'], gitOpts);
              // git diff --cached --quiet exits 0 if no staged changes, 1 if staged
              let hasStaged = false;
              try {
                execFileSync('git', ['diff', '--cached', '--quiet'], gitOpts);
              } catch {
                hasStaged = true;
              }
              if (hasStaged) {
                execFileSync(
                  'git',
                  ['commit', '-m', 'session(auto-close): Angel auto-closed idle session'],
                  gitOpts,
                );
              }
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
      // Phase 2a (P2): Directive detection — runs BEFORE generic pattern
      // extraction so that `directive_rule` artifacts are in place before the
      // pattern-extractor's manifest-builder reads existing artifacts for
      // dedup. Failure here must NOT block pattern extraction for the same
      // session; see RESEARCH §1.1.
      try {
        const dirResult = await extractDirectivesFromSession(
          ctx.db,
          session.session_id,
          session.project,
        );
        result.directives_extracted =
          (result.directives_extracted ?? 0) + dirResult.inserted + dirResult.updated;
        if (dirResult.errors > 0) {
          result.directives_errors = (result.directives_errors ?? 0) + dirResult.errors;
        }
      } catch {
        // Non-fatal — session is still marked processed by the existing
        // pattern-extractor post-condition below.
      }

      // Phase 4 (AR-01): Site A extraction-time pattern creation deleted.
      // The Angel's role is binding/indexing on Phase 1 substrate, not
      // extraction-time abstraction. classifySessionDomains survives
      // because it writes capability_boundaries (binding/indexing), not
      // experience_patterns. See .planning/reframes/2026-05-05-multi-handle-kill.md.
      //
      // result.sessions_processed and result.patterns_extracted stay as
      // 0-default fields for observability surfaces; Phase 7 retirement
      // work decides whether to drop them.
      try {
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
    // Phase 12: Curated Context Extraction — scan completed sessions for
    // reframes, directives, and other high-signal statements that belong in
    // the Project Curated Context slot (P2.1 injection). Angel's fallback
    // for sessions where the agent didn't curate at /endsession.
    //
    // Runs AFTER pattern extraction so both subsystems share the same
    // hasActiveSessions gate. Batch size matches — 3 when user is active,
    // 5 when autonomous. Each session triggers one local LLM call at most,
    // and sessions with no signal candidates are marked without calling
    // the LLM at all.
    //
    // See context/specs/CURATED_CONTEXT.md for the full design.
    try {
      const curatedBatchSize = hasActiveSessions ? 3 : 5;
      const pendingCurated = getSessionsPendingCuratedExtraction(ctx.db, curatedBatchSize);
      for (const session of pendingCurated) {
        try {
          const extraction = await extractCuratedContextFromSession(
            ctx.db,
            session.session_id,
            session.project,
          );
          result.curated_sessions_scanned = (result.curated_sessions_scanned ?? 0) + 1;
          result.curated_entries_proposed =
            (result.curated_entries_proposed ?? 0) + extraction.entriesCreated;
        } catch {
          // Individual session extraction failure — continue with others
        }
      }
    } catch {
      // Non-critical — curated extraction failure doesn't break the heartbeat
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
      // Reads experience_patterns (pre-Phase-4 legacy table). Phase 4 stopped
      // new INSERTs (V28 trigger blocks them). Phase 7 owns retirement direction
      // — drop / project / keep. See .planning/reframes/2026-05-05-multi-handle-kill.md.
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

    // Phase 5b: Session-completion artifact curation (P3, plan 04-04).
    // Consumes `memory_curation_pending` events: runs transcript chunker per
    // session, then MEMORY.md curator per unique project. Idempotent — chunker
    // short-circuits when chunks already exist; curator fast-paths when input
    // bytes and sentinel match.
    //
    // Ordering invariants:
    //   - MUST run AFTER Phase 2 (pattern extraction) — Recent Threads in the
    //     curated MEMORY.md reads freshly-chunked artifacts.
    //   - MUST run AFTER Phase 5 (memory_monitor) — the monitor's prune pass
    //     targets files WITHOUT the Angel sentinel today. Plan 04-04-04
    //     guards the monitor from touching Angel-managed files so our
    //     curated write isn't stomped within the same tick.
    //   - MUST run BEFORE Phase 6b (embedding backfill) — chunker inserts
    //     artifacts with `embedding_ref=null`; backfill sees them in this
    //     tick (or the next, still fine) and embeds them.
    // Plan 04-06-02: the drain is wrapped at iteration level AND per-operation.
    // Outer try/catch protects against DB connection errors etc. so one bad
    // SELECT cannot kill the heartbeat loop. Inner try/catches wrap the two
    // risky calls (chunker + curator) so one poisoned session/project logs
    // a `memory_curation_failed` event and the drain continues.
    //
    // Design choice: on failure we STILL insert `memory_curation_done` for
    // the pending row. The alternative (retry counter, N-failures-then-drop)
    // would pin a deterministically-broken session in the queue forever;
    // dropping after one attempt plus a failure event gives the next tick a
    // clean queue without hiding the failure. Error surfaces via the
    // `memory_curation_errors` tick counter AND the session_events row — the
    // full stack goes to ~/.claudex/logs/angel.log (from 04-06-01).
    //
    // Mirrors the Phase 3 `bdca0a3` per-candidate pattern in run-precision.ts:
    // narrow try/catch around the single risky async call, fallback/continue,
    // wider try/catch around the whole iteration.
    try {
      const pending = cachedPrepare(ctx.db,
        `SELECT se.id, se.session_id, se.project, se.timestamp_epoch
         FROM session_events se
         WHERE se.event_type = 'memory_curation_pending'
           AND NOT EXISTS (
             SELECT 1 FROM session_events done
             WHERE done.event_type = 'memory_curation_done'
               AND done.session_id = se.session_id
           )
         ORDER BY se.timestamp_epoch ASC
         LIMIT 20`
      ).all() as Array<{ id: number; session_id: string; project: string; timestamp_epoch: number }>;

      const curatedProjects = new Set<string>();

      for (const p of pending) {
        // Chunker: per-session. Errors record `memory_curation_failed` with
        // the error name + message (not the stack — the stack goes to
        // angel.log via the 04-06-01 stderr capture). Curator still runs
        // even if chunking failed — the two are independent: the curator
        // reads existing transcript_chunk rows from prior ticks and can
        // still produce a valid MEMORY.md even when today's chunk fails.
        try {
          const { chunkSessionTranscript } = await import('./transcript-chunker.js');
          const cr = await chunkSessionTranscript(ctx.db, p.session_id, p.project);
          result.chunks_created = (result.chunks_created ?? 0) + cr.inserted;
          if (cr.errors > 0) {
            result.memory_curation_errors = (result.memory_curation_errors ?? 0) + cr.errors;
          }
        } catch (err) {
          result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
          recordCurationFailure(
            ctx.db,
            p.session_id,
            p.project,
            'chunker',
            err,
          );
        }

        // Curator: dedup per project within this tick — batch sessions for
        // the same project trigger a single MEMORY.md write.
        if (!curatedProjects.has(p.project)) {
          try {
            const { curateMemoryMd } = await import('./memory-md-writer.js');
            const mr = curateMemoryMd(ctx.db, p.project);
            if (mr.written) {
              result.memory_md_written = (result.memory_md_written ?? 0) + 1;
            } else if (mr.reason === 'no_project_dir') {
              result.memory_curation_no_project_dir = (result.memory_curation_no_project_dir ?? 0) + 1;
            } else if (mr.reason !== 'idempotent_noop') {
              result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
            }
            curatedProjects.add(p.project);
          } catch (err) {
            result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
            recordCurationFailure(
              ctx.db,
              p.session_id,
              p.project,
              'curator',
              err,
            );
            // Still mark the project as curated-this-tick so batched pending
            // rows for the same project don't repeatedly trigger the throw.
            curatedProjects.add(p.project);
          }
        }

        // Mark done — a `memory_curation_done` event with the originating
        // pending id, so the SELECT above skips this session on the next tick.
        // We mark done even on chunker/curator failure: this is a
        // deliberate design choice (see block-level comment above).
        try {
          cachedPrepare(ctx.db,
            `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
             VALUES (?, ?, 'memory_curation_done', 'angel', 'processed', ?)`
          ).run(
            p.session_id,
            p.project,
            JSON.stringify({ pending_event_id: p.id, tick_epoch: Math.floor(Date.now() / 1000) }),
          );
        } catch { /* non-fatal — both sides of the pipeline are idempotent */ }
      }
    } catch (err) {
      // DB connection error, SELECT throw, any unexpected failure inside the
      // drain. Record a single rollup failure so we can see it in telemetry
      // and continue — one bad tick must not kill Angel.
      result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
      try {
        cachedPrepare(ctx.db,
          `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
           VALUES ('', '', 'memory_curation_failed', 'angel', 'drain_iteration', ?)`
        ).run(
          JSON.stringify({
            error_name: err instanceof Error ? err.name : 'Unknown',
            error_message: err instanceof Error ? err.message : String(err),
          }),
        );
      } catch { /* double-failure — DB itself is sick; angel.log still has the stack */ }
    }

    // Phase 5c: Phase 4.1 bridge sweeps (Plan 07).
    //
    // Sequencing rationale:
    //   - Runs AFTER Phase 5b (so curated lesson files written this tick are
    //     visible to feedback-promoter on the same tick — no extra latency).
    //   - Runs BEFORE Phase 6 (artifact linking) so newly-promoted critical_rules
    //     don't carry stale embeddings.
    //   - Multi-project sweep is cross-project (no `project` arg). It runs
    //     every tick — sub-millisecond for typical N < 100 system-promoted rules.
    //
    // Per-operation try/catch (Plan 04-06-02 pattern): one failing operation
    // does not skip the next two.
    try {
      // 5c-1: feedback density check per active project.
      // Iterate over CC projects with recent feedback_*.md files (last 7d).
      try {
        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        const sevenDaysAgo = Date.now() - 7 * 86_400 * 1000;
        const activeProjects: string[] = [];
        if (fs.existsSync(projectsDir)) {
          for (const entry of fs.readdirSync(projectsDir)) {
            const memDir = path.join(projectsDir, entry, 'memory');
            if (!fs.existsSync(memDir)) continue;
            try {
              const files = fs.readdirSync(memDir);
              const hasRecentFeedback = files.some(f => {
                if (!f.startsWith('feedback_')) return false;
                try {
                  const stat = fs.statSync(path.join(memDir, f));
                  return stat.mtimeMs >= sevenDaysAgo;
                } catch { return false; }
              });
              if (hasRecentFeedback) activeProjects.push(entry);
            } catch { /* skip */ }
          }
        }

        const { promoteFeedbackToCriticalRules } = await import('./feedback-promoter.js');
        let promoted = 0;
        for (const p of activeProjects) {
          try {
            promoted += promoteFeedbackToCriticalRules(ctx.db, p);
          } catch (err) {
            result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
          }
        }
        if (promoted > 0) result.feedback_rules_promoted = promoted;
      } catch { /* non-fatal */ }

      // 5c-2: multi-project marker update (cross-project sweep).
      try {
        const { updateMultiProjectMarkers } = await import('./multi-project-marker.js');
        const updated = updateMultiProjectMarkers(ctx.db);
        if (updated > 0) result.multi_project_markers_updated = updated;
      } catch { /* non-fatal */ }

      // 5c-3: shape vocabulary promotion (candidate → canonical at density ≥3).
      try {
        const { promoteShapeVocabulary } = await import('./shape-vocab-promoter.js');
        const promotedVocab = promoteShapeVocabulary(ctx.db);
        if (promotedVocab > 0) result.shape_vocab_promoted = promotedVocab;
      } catch { /* non-fatal */ }
    } catch {
      // Outer catch — should be unreachable since each inner has its own try.
    }

    // Phase 5d: Curation feedback sweeps (Phase 5.5).
    //
    // Sequencing rationale:
    //   - Runs AFTER Phase 5c so any vocab promotion this tick is committed
    //     before we re-render lesson frontmatter.
    //   - Runs BEFORE Phase 6 (artifact linking) — same constraint as 5c.
    //
    // Two operations, each with its own try/catch (Plan 04-06-02 pattern):
    //   5d-1: Auto-archive (24h cadence, internal time gate)
    //   5d-2: Auto-promote (7d cadence, internal time gate)
    try {
      const now = Date.now();
      const {
        sweepArchivePointers,
        sweepPromotePointers,
        shouldRunArchiveSweep,
        markArchiveSweepRan,
        shouldRunPromoteSweep,
        markPromoteSweepRan,
      } = await import('./curation-sweep.js');

      // 5d-1: Archive
      try {
        if (shouldRunArchiveSweep(now)) {
          const archived = sweepArchivePointers(ctx.db, now);
          if (archived > 0) result.pointers_archived = archived;
          markArchiveSweepRan(now);
        }
      } catch {
        result.curation_errors = (result.curation_errors ?? 0) + 1;
      }

      // 5d-2: Promote
      try {
        if (shouldRunPromoteSweep(now)) {
          const promoted = sweepPromotePointers(ctx.db, now);
          if (promoted > 0) result.pointers_promoted = promoted;
          markPromoteSweepRan(now);
        }
      } catch {
        result.curation_errors = (result.curation_errors ?? 0) + 1;
      }
    } catch {
      // Outer catch — should be unreachable because each inner has its own try.
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
      // Qdrant was removed in Phase 5 — vector search is in-process via
      // sqlite-vec. CliProxy was removed in Path B — Angel's generation
      // runs against the local llama-server (Gemma 4 31B Q6_K), supervised
      // by LlamaServerSupervisor.
      interface DownOutcome { label: string; outcome: string; }
      const downOutcomes: DownOutcome[] = [];

      // Generation backend — probes the Ollama daemon (or the legacy
      // llama-server in local mode) via checkLlamaServerHealth.
      const cloudMode = isCloudModel(LLAMA_MODEL_ALIAS);
      if (!(await checkLlamaServerHealth())) {
        const label = cloudMode
          ? `Ollama daemon (LLM generation — ${LLAMA_MODEL_ALIAS})`
          : 'llama-server (LLM generation — Gemma 4 31B Q6_K)';
        downOutcomes.push({
          label,
          outcome: 'no auto-restart available',
        });
      }
      // Reranker (neural cross-encoder)
      let rerankerDown = false;
      try {
        const resp = await fetch('http://127.0.0.1:7439/health', { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) rerankerDown = true;
      } catch {
        rerankerDown = true;
      }
      if (rerankerDown) {
        downOutcomes.push({
          label: 'Reranker (Neural cross-encoder, CUDA)',
          outcome: 'no auto-restart available',
        });
      }
      // Ollama (still used for embeddings — arctic-embed2)
      let ollamaDown = false;
      try {
        const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) ollamaDown = true;
      } catch {
        ollamaDown = true;
      }
      if (ollamaDown) {
        downOutcomes.push({
          label: 'Ollama (Embeddings — arctic-embed2)',
          outcome: 'no auto-restart available',
        });
      }

      if (downOutcomes.length > 0) {
        result.services_down = downOutcomes.map(o => o.label);

        // Reranker recovery: delegate to RerankerSupervisor.ensureRunning().
        const rerankerEntry = downOutcomes.find(o => o.label.includes('Reranker'));
        if (rerankerEntry && ctx.rerankerSupervisor) {
          try {
            const res = await ctx.rerankerSupervisor.ensureRunning();
            if (res.running) {
              rerankerEntry.outcome = res.attempted ? 'restart succeeded' : `recovered (${res.reason})`;
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

        // Generation backend recovery: delegate to LlamaServerSupervisor.
        // Matches cloud-mode label ("Ollama daemon") and legacy local label
        // ("llama-server"). In cloud mode the supervisor only health-probes;
        // it never spawns.
        const llamaEntry = downOutcomes.find(o =>
          o.label.includes('llama-server') || o.label.includes('Ollama daemon'),
        );
        if (llamaEntry && ctx.llamaServerSupervisor) {
          try {
            const res = await ctx.llamaServerSupervisor.ensureRunning();
            if (res.running) {
              llamaEntry.outcome = res.attempted ? 'restart succeeded' : `recovered (${res.reason})`;
              const idx = downOutcomes.indexOf(llamaEntry);
              if (idx >= 0) downOutcomes.splice(idx, 1);
              if (result.services_down) {
                result.services_down = result.services_down.filter(l => !l.includes('llama-server'));
              }
            } else {
              llamaEntry.outcome = res.attempted
                ? `restart failed: ${res.reason}`
                : res.reason;
            }
          } catch (err) {
            llamaEntry.outcome = `supervisor error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Filter the stale ollama-embeddings label when the same daemon is
        // already surfaced under the LLM label (cloud mode).
        if (cloudMode) {
          const embIdx = downOutcomes.findIndex(o =>
            o.label.startsWith('Ollama (Embeddings'),
          );
          if (embIdx >= 0 && downOutcomes.some(o => o.label.startsWith('Ollama daemon'))) {
            downOutcomes.splice(embIdx, 1);
            if (result.services_down) {
              result.services_down = result.services_down.filter(
                l => !l.startsWith('Ollama (Embeddings'),
              );
            }
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
    // Llama-server idle lifecycle — shut down when idle to free ~25GB VRAM,
    // wake up when sessions need it. Skipped in cloud mode (no local process).
    // =========================================================================
    try {
      if (ctx.llamaServerSupervisor && !isCloudModel(LLAMA_MODEL_ALIAS)) {
        if (ctx.llamaServerSupervisor.idledDown) {
          // Server was idle-shutdown. Wake it if there are active sessions
          // that will need LLM extraction work.
          const activeCount = (cachedPrepare(ctx.db,
            `SELECT COUNT(*) as c FROM sessions WHERE status = 'active'`
          ).get() as { c: number }).c;
          if (activeCount > 0) {
            ctx.llamaServerSupervisor.wakeFromIdle();
            const res = await ctx.llamaServerSupervisor.ensureRunning();
            if (!res.running) {
              result.services_down = result.services_down ?? [];
              result.services_down.push(`llama-server (wake from idle failed: ${res.reason})`);
            }
          }
        } else {
          // Server is (or should be) running — check idle timeout.
          ctx.llamaServerSupervisor.checkIdleAndShutdown();
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

    // Phase 4b.5: task-pattern fingerprint backfill (Phase 6.5).
    // Regex-only classification (~1-2 ms per artifact); 200/tick. Idempotent —
    // rows are filtered out via LEFT JOIN on artifact_task_pattern, so a tick
    // after full-coverage convergence is a no-op. Abstained rows write the
    // `__abstain__` sentinel so they're not retried.
    try {
      backfillTaskPatternsBatch(ctx.db, 200);
    } catch {
      // Non-critical — backfill failure doesn't break the heartbeat
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
        // Reads experience_patterns (pre-Phase-4 legacy table). Phase 4 stopped
        // new INSERTs (V28 trigger blocks them). Phase 7 owns retirement direction
        // — drop / project / keep. See .planning/reframes/2026-05-05-multi-handle-kill.md.
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

        // Dedup similar high-score patterns: vector search → score absorption +
        // DELETE absorbed rows. No content synthesis. Phase 4 deleted the LLM-
        // driven lesson rewrite (Site C of the extraction-creation kill).
        // See .planning/reframes/2026-05-05-multi-handle-kill.md.
        try {
          const { findSimilarPatterns } = await import('../intelligence/experience-patterns.js');
          const mergeTargets = cachedPrepare(ctx.db,
            `SELECT id, trigger_context, lesson, score FROM experience_patterns
             WHERE score >= 5 ORDER BY score DESC LIMIT 10`
          ).all() as Array<{ id: string; trigger_context: string; lesson: string; score: number }>;

          const merged = new Set<string>();
          // Phase 4: dedup + score absorption only. LLM lesson synthesis was
          // deleted because synthesizing a new abstract principle from N rows
          // is extraction-time abstraction (Mem0 trap at smaller scale).
          for (const target of mergeTargets) {
            if (merged.has(target.id)) continue;
            const similar = await findSimilarPatterns(ctx.db, target.id, target.trigger_context, 3, 0.80);
            const toMerge = similar.filter(s => !merged.has(s.id) && s.id !== target.id);
            if (toMerge.length === 0) continue;

            // Merge: absorb scores, delete absorbed patterns.
            for (const m of toMerge) {
              cachedPrepare(ctx.db,
                `UPDATE experience_patterns SET score = score + ? WHERE id = ?`
              ).run(m.score, target.id);
              cachedPrepare(ctx.db,
                `DELETE FROM experience_patterns WHERE id = ?`
              ).run(m.id);
              merged.add(m.id);
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

  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  // DIAG-07 freshness signal: touch the PID file mtime so `claudex doctor`
  // can verify Angel is alive even if it sits idle between meaningful work.
  // Best-effort: if the touch fails (FS race, removed PID file), don't break
  // the heartbeat — the next tick will re-attempt.
  try {
    const pidPath = getPidFilePath();
    const now = new Date();
    fs.utimesSync(pidPath, now, now);
  } catch {
    // Non-critical — heartbeat survival outweighs freshness signal accuracy
  }

  // V5 Phase 6: crash-resilient episode boundary tick. Runs after retention
  // so cursor advances are visible to subsequent observability surfaces.
  // Bounded LIMIT 25 inside runBoundaryTick. Failures are caught here so a
  // boundary-tick error never breaks the heartbeat loop.
  try {
    const { runBoundaryTick } = await import('./boundary/boundary-detector.js');
    const { loadThresholds } = await import('./boundary/thresholds.js');
    const boundary = runBoundaryTick(ctx.db, loadThresholds());
    result.boundary_closes_emitted    = boundary.closesEmitted;
    result.boundary_closes_aborted    = boundary.closesAborted;
    result.boundary_reopens_emitted   = boundary.reopensEmitted;
    result.boundary_reopens_anomalous = boundary.reopensAnomalous;
    result.boundary_cursor_replays    = boundary.cursorReplays;
  } catch (err) {
    try {
      const message = err instanceof Error ? err.message : String(err);
      cachedPrepare(ctx.db,
        `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
         VALUES ('angel-heartbeat', 'episodic_write_failure',
                 json_object('phase6','runBoundaryTick','error_message',?),
                 'angel-boundary')`
      ).run(message.slice(0, 500));
    } catch { /* last-resort */ }
  }

  result.duration_ms = Date.now() - start;
  return result;
}

// ---------------------------------------------------------------------------
// Plan 04-06-02 helpers
// ---------------------------------------------------------------------------

/**
 * Record a `memory_curation_failed` session_events row with enough detail to
 * diagnose (error.name + error.message — NOT the full stack; stacks go to
 * ~/.claudex/logs/angel.log via the 04-06-01 stderr capture). Non-throwing
 * by design — if the DB itself is sick, we swallow the insert failure; the
 * unrecoverable error was already routed to the log file.
 */
function recordCurationFailure(
  db: Database,
  sessionId: string,
  project: string,
  stage: 'chunker' | 'curator',
  err: unknown,
): void {
  try {
    const detail = JSON.stringify({
      stage,
      error_name: err instanceof Error ? err.name : 'Unknown',
      error_message: err instanceof Error ? err.message : String(err),
    });
    cachedPrepare(db,
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
       VALUES (?, ?, 'memory_curation_failed', 'angel', ?, ?)`
    ).run(sessionId, project, stage, detail);
  } catch { /* non-fatal — angel.log still has the stack */ }
}

// ---------------------------------------------------------------------------
// Phase 6: Bulk artifact linking
// ---------------------------------------------------------------------------

/** Rate limit: run pattern consolidation at most once per 30 minutes. */
let _lastConsolidationEpoch = 0;
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
export function computeNextInterval(
  db: Database,
  result: TickResult,
  consecutiveIdleTicks: number,
): { intervalMs: number; idle: boolean } {
  try {
    // Priority 0: Any critical service observed down this tick — stay on the
    // active cadence so ensureRunning() gets called promptly on the next tick,
    // not 10–30 min from now under idle backoff. Without this, the reranker
    // (or llama-server) dying during an idle window would leave retrieval
    // in bi-encoder fallback for up to MAX_INTERVAL_MS before recovery was
    // attempted. Pin to ACTIVE_INTERVAL_MS and reset the idle-tick counter
    // via `idle: false` so the exponential backoff starts fresh after recovery.
    if (result.services_down && result.services_down.length > 0) {
      return { intervalMs: ACTIVE_INTERVAL_MS, idle: false };
    }

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
      || (result.observations_consolidated ?? 0) > 0
      || (result.artifacts_linked ?? 0) > 0
      || (result.embeddings_backfilled ?? 0) > 0
      || (result.user_profiles_synced ?? 0) > 0;

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
