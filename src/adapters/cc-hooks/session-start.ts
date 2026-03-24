/**
 * SessionStart hook -> session_init event.
 * Creates session, recovers checkpoints, prunes telemetry, assembles full context.
 */

import { wrapHook } from './infrastructure.js';
import { createSession } from '../../core/sessions.js';
import { recoverFromDb } from '../../checkpoint/loader.js';
import { pruneTelemetry, emitTelemetry } from '../../observability/telemetry.js';
import { emitErrorTelemetry } from '../../observability/error-telemetry.js';
import { assembleFullContext } from '../../assembly/assembler.js';
import { getIdentityDir } from '../../shared/paths.js';
import { ingestFileArtifacts, pruneStaleFileArtifacts } from '../../core/file-ingester.js';
import { getLastSessionSummary, synthesizeSessionSummary, getSessionEvents, saveSessionSummary } from '../../core/session-events.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { captureRecallFlowEntry } from '../shared/lifecycle.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';

/**
 * Ensure Qdrant is running. Checks HTTP health endpoint, spawns if not reachable.
 * Non-throwing — Qdrant is optional (graceful degradation to FTS5).
 */
async function ensureQdrantRunning(): Promise<void> {
  // Check if Qdrant is already running
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch('http://localhost:6333/healthz', { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) return; // Already running
  } catch {
    // Not running — try to start
  }

  const qdrantDir = path.join(os.homedir(), '.claudex', 'qdrant-bin');
  const qdrantExe = path.join(qdrantDir, 'qdrant.exe');
  const configPath = path.join(qdrantDir, 'config.yaml');

  if (!fs.existsSync(qdrantExe) || !fs.existsSync(configPath)) return;

  // Ensure storage dirs exist
  const storageDir = path.join(os.homedir(), '.claudex', 'qdrant', 'storage');
  const snapshotsDir = path.join(os.homedir(), '.claudex', 'qdrant', 'snapshots');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });

  // Spawn detached — survives hook process exit
  const child = spawn(qdrantExe, ['--config-path', configPath], {
    detached: true,
    stdio: 'ignore',
    cwd: qdrantDir,
  });
  child.unref();

  // Wait briefly for startup
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const resp = await fetch('http://localhost:6333/healthz', { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) return;
    } catch { /* still starting */ }
  }
}

/**
 * Ensure the Angel process is running. Checks PID file, spawns if not alive.
 * Non-throwing — Angel is optional enhancement.
 */
async function ensureAngelRunning(): Promise<void> {
  const pidPath = path.join(os.homedir(), '.claudex', 'angel.pid');
  // Resolve Angel from THIS file's install directory, not CWD (security: prevents
  // malicious repos from placing a trojan dist/angel/index.cjs)
  const angelDist = path.resolve(__dirname, '..', '..', 'angel', 'index.cjs');

  // Check if Angel dist exists
  if (!fs.existsSync(angelDist)) return;

  // Check if already running via PID file
  if (fs.existsSync(pidPath)) {
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (!isNaN(pid)) {
        process.kill(pid, 0); // Check existence
        return; // Already running
      }
    } catch {
      // Process not running — stale PID, continue to spawn
    }
  }

  // Spawn detached Angel process using absolute Node path (security: prevents
  // PATH hijacking with a malicious node.exe in the project directory)
  const child = spawn(process.execPath, [angelDist], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
    cwd: os.homedir(), // Safe CWD — not the project directory
  });
  child.unref();
}

const main = wrapHook('SessionStart', async (input, ctx) => {
  // Ensure Qdrant is running (non-blocking, non-fatal — FTS5 fallback on failure)
  try {
    await ensureQdrantRunning();
  } catch { /* Qdrant is optional */ }

  // Ensure Angel is running (non-blocking, non-fatal — optional enhancement)
  try {
    await ensureAngelRunning();
  } catch { /* Angel is optional */ }

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
    const orphans = cachedPrepare(ctx.db,
      `SELECT session_id FROM sessions WHERE status = 'active' AND created_at_epoch < ? AND session_id != ? AND project = ?`
    ).all(cutoff, input.session_id, ctx.project) as Array<{ session_id: string }>;

    for (const orphan of orphans) {
      // Generate recall metadata BEFORE closing — captures user framings,
      // topic chain, decisions as searchable recall aliases
      try {
        const events = getSessionEvents(ctx.db, orphan.session_id);
        captureRecallFlowEntry(ctx.db, orphan.session_id, ctx.project, events);
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

  const payload = assembleFullContext({
    db: ctx.db,
    project: ctx.project,
    projectDir: input.cwd,
    config: ctx.config,
    identityDir: getIdentityDir(),
    sessionId: input.session_id,
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
  try {
    const lastSummary = getLastSessionSummary(ctx.db, ctx.project);
    if (lastSummary) {
      const summarySection = `\n## Last Session\n${lastSummary}\n`;
      fullContent = fullContent ? fullContent + summarySection : summarySection;
    }
  } catch (e) {
    emitErrorTelemetry(ctx.db, input.session_id, 'session_start/last_session_summary', e);
  }

  if (fullContent) {
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: fullContent,
      },
    };
  }
  return {};
});

main();
