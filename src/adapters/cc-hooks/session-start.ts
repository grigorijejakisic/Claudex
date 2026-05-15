/**
 * SessionStart hook -> session_init event.
 * Creates session, recovers checkpoints, prunes telemetry, assembles full context.
 */

import { wrapHook } from './infrastructure.js';
import { ensureAngelRunning } from './angel-launcher.js';
import { createSession } from '../../core/sessions.js';
import { recoverFromDb } from '../../checkpoint/loader.js';
import { pruneTelemetry, emitTelemetry } from '../../observability/telemetry.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { assembleFullContext } from '../../assembly/assembler.js';
import { getIdentityDir } from '../../shared/paths.js';
import { normalizeText } from '../../shared/text-utils.js';
import { ingestFileArtifacts, pruneStaleFileArtifacts } from '../../core/file-ingester.js';
import { getLastSessionSummary, synthesizeSessionSummary, getSessionEvents, saveSessionSummary, recordEvent } from '../../core/session-events.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { captureRecallFlowEntry } from '../shared/lifecycle.js';
import { writeEnvironmentalEvent } from '../../core/episodic-events.js';
import { writeClaudeEnvFile, detectCcMemoryConflict } from '../shared/env-file.js';
import { nowIso } from './session-writer.js';
import { verifyMemoryMd } from '../../core/memory-md-verify.js';
import { predictSessionIntent, CONFIDENCE_THRESHOLD } from '../../intelligence/intent-predictor.js';
import { seedCriticalRules, promoteFromCapabilityTracker } from '../../intelligence/critical-reminders.js';
import { detectWindowSize } from '../../gauge/window-detector.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Qdrant support removed in session 47 (Phase 5 of the sqlite-vec migration).
// The vector store is now sqlite-vec (vec0 virtual tables in the shared SQLite
// database). No separate service needs to be spawned at session start. The
// virtual tables are created automatically by the V14→V15 migration when the
// DB is opened. See context/specs/SQLITE_VEC_MIGRATION.md.
//
// CliProxy removed in Path B (curated-context milestone). Angel's LLM
// generation now runs against a local llama.cpp server (Gemma 4 31B Q6_K)
// supervised by LlamaServerSupervisor. The supervisor is started inside
// Angel's main process, so session-start only has to spawn Angel —
// llama-server comes up as part of Angel's startup sequence. No CliProxy,
// no MAX subscription coupling for background work.

// Plan 04-06-03: `ensureAngelRunning` moved to `./angel-launcher.ts` so
// user-prompt-submit can import it without also triggering SessionStart's
// top-level `main()` (that double-fired the hook and broke smoke tests).

/**
 * INJ-06 prime contract (Phase 5 Plan 07).
 *
 * Computes the initialUserMessage emitted to Claude at session-start.
 * Returns null when ANY of the following are NOT satisfied:
 *   1. `<cwd>/context/handoffs/ACTIVE.md` exists.
 *   2. Frontmatter has `status: active` (case-insensitive).
 *   3. Frontmatter `phase` exactly equals `Current Phase` from STATE.md (string equality).
 *   4. Either `summary` is present in frontmatter, OR a non-blank, non-H1 body line exists.
 *
 * The prime format is fixed: `Resume handoff: ${summary}. Full state at .planning/handoffs/ACTIVE.md.`
 *
 * Caller is responsible for the sessionType gate (`startup` or `''`).
 *
 * Exported so unit tests can verify the matrix without spinning a CC hook harness.
 */
export function computeInitialUserMessage(cwd: string): string | null {
  try {
    const handoffPath = path.join(cwd, 'context', 'handoffs', 'ACTIVE.md');
    if (!fs.existsSync(handoffPath)) return null;
    const handoffContent = normalizeText(fs.readFileSync(handoffPath, 'utf-8'));
    const fmMatch = handoffContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fmBlock = fmMatch[1];

    const isActive = /^status:\s*active\b/im.test(fmBlock);
    if (!isActive) return null;

    const handoffPhaseMatch = fmBlock.match(/^phase:\s*["']?([^"'\n]+?)["']?\s*$/im);
    const handoffPhase = handoffPhaseMatch?.[1]?.trim();
    if (!handoffPhase) return null;

    const statePath = path.join(cwd, '.planning', 'STATE.md');
    if (!fs.existsSync(statePath)) return null;
    const stateContent = normalizeText(fs.readFileSync(statePath, 'utf-8'));
    // Tolerate `**Current Phase:** 5` markdown bold (matches state-reader extractor).
    const m = stateContent.match(/Current Phase:\**\s*\*?([0-9]+(?:\.[0-9]+)?)/);
    const statePhase = m?.[1]?.trim();
    if (!statePhase) return null;

    // EXACT string equality (per team-lead Q3 verdict 2026-04-29).
    if (handoffPhase !== statePhase) return null;

    // Extract summary: prefer `summary:` frontmatter; fall back to first
    // non-blank, non-H1 body line.
    const summaryMatch = fmBlock.match(/^summary:\s*["']?(.+?)["']?\s*$/im);
    let summary = summaryMatch?.[1]?.trim();
    if (!summary) {
      const body = handoffContent.slice(fmMatch[0].length).trim();
      summary = body.split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0 && !l.startsWith('#'));
    }
    if (!summary) return null;

    return `Resume handoff: ${summary}. Full state at .planning/handoffs/ACTIVE.md.`;
  } catch {
    return null;
  }
}

const main = wrapHook('SessionStart', async (input, ctx) => {
  // Qdrant spawn removed in Phase 5 — vector store is now sqlite-vec (in-process,
  // no external service). The V14→V15 migration runs automatically when the DB
  // is opened by wrapHook infrastructure.
  //
  // CliProxy spawn removed in Path B — Angel now supervises a local
  // llama.cpp server (Gemma 4 31B Q6_K) internally. Starting Angel is
  // sufficient; no separate CliProxy bootstrap needed.

  // Ensure Angel is running (non-blocking, non-fatal — optional enhancement).
  // When Angel starts it auto-launches the llama-server via LlamaServerSupervisor.
  // DB is passed so a failed log-file open records an observable telemetry event.
  try {
    await ensureAngelRunning(ctx.db, input.session_id, ctx.project);
  } catch { /* Angel is optional */ }

  // Phase 13.1 defensive indexer: scan Sessions/ folders for new/modified
  // markdown and re-index via the same upsertChunk pipeline Angel uses.
  // Wrapped with a 3s budget so a slow scan doesn't block session-start.
  // This is defense in depth: if Angel's heartbeat is hung (Phase 13.1 W2
  // root cause not yet fixed), retrieval at next UserPromptSubmit still
  // sees fresh chunks because we caught up the index here.
  try {
    const { scanAndIndexSessions } = await import('../../angel/sessions-indexer.js');
    await Promise.race([
      scanAndIndexSessions(ctx.db),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch { /* indexer failure non-fatal — Angel will catch up later */ }

  // Phase 13.1 Fix #2 (2026-05-15): defensive MEMORY.md regeneration.
  // The Angel-driven heartbeat owns curation, but when it hangs (Phase 13.1
  // W2 root cause), MEMORY.md surfaces (notably ## Handoff) go stale and
  // contradict ACTIVE.md — the 2026-05-15 substrate-readout test caught
  // MEMORY.md still pointing at a 5-day-old phase header. curateMemoryMd
  // has an idempotent sentinel fast-path (memory-md-writer.ts L723), so
  // calling it every session-start is cheap when nothing changed and
  // converges MEMORY.md to ACTIVE.md when something did.
  //
  // Guard: skip when the DB context has no `artifact` rows. computeMemoryMd
  // resolves the project ID to a real `~/.claude/projects/<slug>/MEMORY.md`
  // path via the Claudex project registry, so it writes to the LIVE file
  // even from a temporary smoke-test DB (CLAUDEX_DB_PATH=<tmpdb>). Without
  // this guard, smoke tests wipe `## Active Projects` against the empty
  // temp DB. The guard is a sentinel for "this DB has enough state to
  // generate a meaningful index" — production DBs always have artifact
  // rows; smoke/CI temp DBs do not.
  try {
    const probe = ctx.db.prepare(`SELECT 1 FROM artifact LIMIT 1`).get();
    if (probe) {
      const { curateMemoryMd } = await import('../../angel/memory-md-writer.js');
      curateMemoryMd(ctx.db, ctx.project);
    }
  } catch { /* non-fatal — MEMORY.md is an advisory index, and `artifact` may not exist on pre-V17 DBs */ }

  // Write CLAUDE_ENV_FILE — inject env flags for CC's bash environment.
  // X3: CC sources this file before every BashTool command for the session.
  // T1/T2: Disable CC auto-memory (~11K tokens/turn saved).
  // T8: Preserve hook additionalContext in transcripts for session resume.
  // B6: Only session-agnostic flags — session ID from hook payload, not env file.
  writeClaudeEnvFile();

  // Each operation isolated — if A fails, B and C still run
  try {
    createSession(ctx.db, {
      session_id: input.session_id,
      project: ctx.project,
      scope: ctx.scope ?? undefined,
      cwd: input.cwd,
      source: 'cc-hooks',
      adapter: 'cc-hooks',
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/create', e);
  }

  // V5 Plan 01-03 (EPI-03): episode-substrate session_boundary marker.
  // Phase 6 reads start+end pairs to compute episode windows; Phase 1
  // populates them. Non-fatal — telemetry-on-rollback handles failure.
  try {
    writeEnvironmentalEvent({
      db: ctx.db,
      sessionId: input.session_id,
      project: ctx.project,
      type: 'session_boundary',
      source: 'cc-hooks/session-start',
      content: `Session opened: ${input.session_id}`,
      metadata: {
        session_id: input.session_id,
        project: ctx.project,
        cwd: input.cwd,
      },
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/episodic_boundary', e);
  }

  // Close orphaned sessions: any session still 'active' but older than 1 hour
  // is a crash/disconnect victim. Retroactively close it with a summary so the
  // data isn't lost. Runs before checkpoint recovery to avoid stale state.
  try {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 3600;
    // Close ALL orphaned active sessions across all projects — not just the current one.
    // Cross-project cleanup prevents stale sessions from accumulating (e.g. Oracle/Nexus
    // sessions that were never closed because the user switched projects).
    const orphans = cachedPrepare(ctx.db,
      `SELECT session_id, project FROM sessions WHERE status = 'active' AND created_at_epoch < ? AND session_id != ?`
    ).all(cutoff, input.session_id) as Array<{ session_id: string; project: string | null }>;

    for (const orphan of orphans) {
      // Generate recall metadata BEFORE closing — captures user framings,
      // topic chain, decisions as searchable recall aliases
      try {
        const orphanProject = orphan.project || ctx.project;
        const events = getSessionEvents(ctx.db, orphan.session_id);
        captureRecallFlowEntry(ctx.db, orphan.session_id, orphanProject, events);
        const summary = synthesizeSessionSummary(events);
        if (summary) saveSessionSummary(ctx.db, orphan.session_id, summary);
      } catch { /* non-fatal per orphan */ }

      cachedPrepare(ctx.db,
        `UPDATE sessions SET status = 'completed', ended_at_epoch = ? WHERE session_id = ?`
      ).run(now, orphan.session_id);
    }

    if (orphans.length > 0) {
      emitTelemetry(ctx.db, input.session_id, 'decay_prune', {
        action: 'orphan_session_recovery',
        count: orphans.length,
      });
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/orphan_recovery', e);
  }

  // B2: Resume cost awareness — log when session is a resume (disproportionate token cost).
  // Resume sessions re-read the full conversation, draining token budget (regression since CC v2.1.69).
  try {
    const sessionType = (input.type as string) ?? '';
    if (sessionType === 'resume') {
      const ccVersion = (input.version as string) ?? 'unknown';
      recordEvent(ctx.db, input.session_id, ctx.project,
        'session_resume_cost', 'session_start', 'warning',
        JSON.stringify({ cc_version: ccVersion, type: sessionType }),
      );
    }
  } catch { /* non-fatal — telemetry only */ }

  // C1: GrowthBook flag conflict detection — verify CC auto-memory stays disabled.
  // If CC wrote memory files since our last session, the env flag mechanism may have failed.
  try {
    const conflictFiles = detectCcMemoryConflict(
      ctx.db, input.session_id, ctx.project, ctx.scope ?? undefined,
    );
    if (conflictFiles.length > 0) {
      recordEvent(ctx.db, input.session_id, ctx.project,
        'cc_memory_conflict', 'session_start', 'warning',
        JSON.stringify({ new_files: conflictFiles }),
      );
    }
  } catch { /* Non-fatal — detection is best-effort */ }

  try {
    await recoverFromDb(ctx.db, input.cwd);
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/recover', e);
  }

  try {
    if (ctx.config.observability.enabled) {
      pruneTelemetry(ctx.db, {
        retentionDays: ctx.config.observability.retention_days,
        retainErrorCount: ctx.config.observability.retain_error_count,
      });
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/prune_telemetry', e);
  }

  // Ingest file-based context sources (memory files, session logs, handoffs)
  // into the artifact pipeline so searchArtifactsGlobal finds them.
  try {
    const ingestResult = await ingestFileArtifacts(ctx.db, input.session_id, ctx.project, input.cwd);
    if (ingestResult.errors > 0) {
      emitErrorTelemetry(ctx.db, input.session_id, 'session_start/file_ingest',
        new Error(`${ingestResult.errors} file(s) failed to ingest`));
    }
    await pruneStaleFileArtifacts(ctx.db, ctx.project);
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/file_ingest', e);
  }

  // MEMORY.md verification — read-only invariant check (CUR-03 SC-5).
  // Records memory_md_invalid session event if the Angel-managed file is
  // oversize, missing sentinel, or malformed. Never mutates the file.
  try {
    verifyMemoryMd(ctx.db, ctx.project, input.session_id, {
      scope: ctx.scope ?? undefined,
      cwd: input.cwd,
    });
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/memory_md_verify', e);
  }

  // Seed critical rules from CLAUDE.md markers (Phase 2: Critical Reminders Tier)
  try {
    seedCriticalRules(ctx.db, ctx.project, input.cwd);
    promoteFromCapabilityTracker(ctx.db, ctx.project);
  } catch { /* non-fatal — critical reminders are best-effort */ }

  // Intent prediction — Phase 5 (P4) deletion: assembleFullContext no longer reads
  // params.predictedContext, so the prediction layer is dead code at session-start.
  // Telemetry-only run is preserved so accuracy tracking continues to function.
  try {
    const prediction = predictSessionIntent(ctx.db, ctx.project, input.session_id);
    if (prediction && prediction.confidence >= CONFIDENCE_THRESHOLD) {
      recordEvent(ctx.db, input.session_id, ctx.project,
        'intent_prediction', 'predictor', prediction.intent,
        JSON.stringify({
          confidence: prediction.confidence,
          layer: prediction.layer,
          topic: prediction.topic,
          reason: prediction.reason,
        }),
      );
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/intent_prediction', e);
  }

  // Detect context window from model name (available in CC hook payloads).
  // At session-start there's no transcript yet, so we can't use observed tokens.
  // Model-only detection assumes 1M for Claude 4+ — see window-detector.ts.
  const model = (input.model as string) ?? undefined;
  const contextWindowTokens = detectWindowSize({ model });

  // CC environment detection — log CC version and memory mode for adaptive behavior.
  // Source: Claude Code v2.1.88 leak revealed feature flags (KAIROS, TEAMMEM,
  // EXTRACT_MEMORIES, COMPACTION_REMINDERS) that change how CC handles memory.
  // Claudex must detect and adapt to avoid conflicts.
  let ccKairosActive = false;
  try {
    const ccVersion = (input.version as string) ?? 'unknown';
    const ccAutoMemDir = path.join(os.homedir(), '.claude', 'projects',
      ctx.scope ?? ctx.project, 'memory');
    const ccMemoryMdExists = fs.existsSync(path.join(ccAutoMemDir, 'MEMORY.md'));
    const ccKairosLogDir = path.join(ccAutoMemDir, 'logs');
    ccKairosActive = fs.existsSync(ccKairosLogDir);

    recordEvent(ctx.db, input.session_id, ctx.project,
      'cc_environment', 'session_start', 'detected',
      JSON.stringify({
        cc_version: ccVersion,
        model,
        auto_memory_active: ccMemoryMdExists,
        kairos_mode: ccKairosActive,
        context_window: contextWindowTokens,
      }),
    );

    // C3: KAIROS mode detection — dedicated event + one-line warning.
    // KAIROS is CC's experimental daily-log memory format. When active,
    // Angel consolidation may conflict with KAIROS's own log writes.
    if (ccKairosActive) {
      recordEvent(ctx.db, input.session_id, ctx.project,
        'kairos_detected', 'session_start', 'warning',
        JSON.stringify({ cc_version: ccVersion, log_dir: ccKairosLogDir }),
      );
    }
  } catch { /* non-fatal — detection is best-effort */ }

  // Detect post-compaction re-fire: CC fires SessionStart with type='compact' after
  // compaction completes. The assembler's isPostCompaction path skips identity/project/
  // continuity (already in context from CLAUDE.md) and adds P4.5 Rules Reminder.
  const isCompactResume = ((input.type as string) ?? '') === 'compact';

  const payload = assembleFullContext({
    db: ctx.db,
    project: ctx.project,
    projectDir: input.cwd,
    config: ctx.config,
    identityDir: getIdentityDir(),
    sessionId: input.session_id,
    isPostCompaction: isCompactResume,
    contextWindowTokens,
  });

  if (payload.tokenEstimate > 0) {
    try {
      emitTelemetry(ctx.db, input.session_id, 'injection', {
        trigger: 'session_start' as const,
        sections_included: payload.sources,
        sections_skipped: [],
        total_tokens: payload.tokenEstimate,
        budget_remaining: ctx.config.injection.budget_tokens - payload.tokenEstimate,
      });
    } catch { /* non-fatal */ }
  }

  // Append last session summary to the assembled context (cross-session reconstruction)
  let fullContent = payload.content || '';

  // Phase 13 Plan 04: per-turn timestamp injection at the top of additionalContext.
  // ISO 8601 + local timezone offset — supplements the static `currentDate` memory
  // line with sub-day precision so the agent can compute elapsed time.
  const currentTimeLine = `**Current time:** ${nowIso()}`;
  fullContent = currentTimeLine + (fullContent ? '\n\n' + fullContent : '');

  // C3: KAIROS warning injection — one line, only when KAIROS is active
  if (ccKairosActive) {
    fullContent += '\nKAIROS mode active -- Angel consolidation may conflict\n';
  }
  try {
    const lastSummary = getLastSessionSummary(ctx.db, ctx.project);
    if (lastSummary) {
      const summarySection = `\n## Last Session\n${lastSummary}\n`;
      fullContent = fullContent ? fullContent + summarySection : summarySection;
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/last_session_summary', e);
  }

  // Build watchPaths — CC will notify the model if these files change mid-session.
  // Discovered in CC v2.1.88 source (hooks.ts:632): SessionStart hooks can return
  // watchPaths[] and CC sets up file watchers via fileChangedWatcher.ts.
  const watchPaths: string[] = [];
  try {
    const handoffPath = path.join(input.cwd, 'context', 'handoffs', 'ACTIVE.md');
    if (fs.existsSync(handoffPath)) watchPaths.push(handoffPath);
    // Watch CLAUDE.md for live config changes
    const claudeMdPath = path.join(input.cwd, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) watchPaths.push(claudeMdPath);
  } catch { /* non-fatal */ }

  // INJ-06: initialUserMessage prime — frontmatter-contract-gated, default-on.
  // Per Phase 5 / 05-HANDOFF-FRONTMATTER-SPEC.md: fires only when handoff
  // frontmatter status: active AND phase EXACTLY matches STATE.md Current
  // Phase. No config flag, no mtime gate. EXACT match — handoff phase=4.1
  // against STATE phase=4 does NOT prime (per team-lead Q3 verdict 2026-04-29).
  let initialMessage: string | undefined;
  try {
    const sessionType = (input.type as string) ?? '';
    if (sessionType === 'startup' || sessionType === '') {
      initialMessage = computeInitialUserMessage(input.cwd) ?? undefined;
    }
  } catch { /* non-fatal — auto-prime is best-effort */ }

  // fullContent always carries at least the **Current time:** line, so this
  // branch is the steady-state return path.
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: fullContent,
      ...(watchPaths.length > 0 ? { watchPaths } : {}),
      ...(initialMessage ? { initialUserMessage: initialMessage } : {}),
    },
  };
});

main();
