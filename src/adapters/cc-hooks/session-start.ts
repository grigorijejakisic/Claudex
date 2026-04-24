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
import { ingestFileArtifacts, pruneStaleFileArtifacts } from '../../core/file-ingester.js';
import { getLastSessionSummary, synthesizeSessionSummary, getSessionEvents, saveSessionSummary, recordEvent } from '../../core/session-events.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { captureRecallFlowEntry } from '../shared/lifecycle.js';
import { writeClaudeEnvFile, detectCcMemoryConflict } from '../shared/env-file.js';
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

  // Intent prediction — predict what user will need BEFORE their first prompt (Phase 19).
  // Runs AFTER checkpoint recovery, BEFORE assembly. Non-throwing.
  let predictedContext: {
    intent: string;
    topic: string;
    confidence: number;
    reason: string;
  } | undefined;
  try {
    const prediction = predictSessionIntent(ctx.db, ctx.project, input.session_id);
    if (prediction && prediction.confidence >= CONFIDENCE_THRESHOLD) {
      predictedContext = {
        intent: prediction.intent,
        topic: prediction.topic,
        confidence: prediction.confidence,
        reason: prediction.reason,
      };
      // Record prediction as session event for accuracy tracking at session end
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
    predictedContext: isCompactResume ? undefined : predictedContext,
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

  // I1: Auto-priming via initialUserMessage — opt-in, startup-only.
  // When enabled and a handoff exists, injects a short directive as the first user
  // message so the model auto-responds with handoff priorities without user typing.
  let initialMessage: string | undefined;
  try {
    const sessionType = (input.type as string) ?? '';
    if (sessionType === 'startup' || sessionType === '') {
      // Check opt-in: read auto_prime from config.json (default: false)
      const configPath = path.join(os.homedir(), '.claudex', 'config.json');
      let autoPrime = false;
      if (fs.existsSync(configPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          autoPrime = raw?.auto_prime === true;
        } catch { /* malformed config — default false */ }
      }

      if (autoPrime) {
        const handoffPath = path.join(input.cwd, 'context', 'handoffs', 'ACTIVE.md');
        if (fs.existsSync(handoffPath)) {
          const handoffContent = fs.readFileSync(handoffPath, 'utf-8');
          // Check for active status in frontmatter
          const frontmatterMatch = handoffContent.match(/^---\s*\n([\s\S]*?)\n---/);
          const isActive = frontmatterMatch
            ? /status:\s*active/i.test(frontmatterMatch[1])
            : true; // No frontmatter — assume active

          if (isActive) {
            // Extract priorities from ## Priority or ## What I Was Working On
            const priorityMatch = handoffContent.match(
              /##\s*(?:Priority|What I Was Working On|Priorities)\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i,
            );
            if (priorityMatch) {
              const lines = priorityMatch[1].trim().split('\n')
                .filter(l => l.trim().startsWith('-') || l.trim().startsWith('1'))
                .slice(0, 3)
                .map((l, i) => `${i + 1}) ${l.replace(/^[\s-]*\d*[.)]*\s*/, '').trim()}`);
              if (lines.length > 0) {
                initialMessage = `A handoff is active. Priorities: ${lines.join(' ')}. Run /starthere for full context.`;
              }
            }
            // Fallback: if no priorities section found, still prime with generic message
            if (!initialMessage) {
              initialMessage = 'A handoff is active from the previous session. Run /starthere for full context.';
            }
          }
        }
      }
    }
  } catch { /* non-fatal — auto-priming is best-effort */ }

  if (fullContent) {
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: fullContent,
        ...(watchPaths.length > 0 ? { watchPaths } : {}),
        ...(initialMessage ? { initialUserMessage: initialMessage } : {}),
      },
    };
  }
  return {};
});

main();
