/**
 * Angel System — persistent guardian process for Claudex.
 *
 * The Angel is the architectural correction for the system's biggest structural
 * problem: ephemeral hooks trying to do reflective thinking. It sees full
 * conversations holistically, extracts patterns with real confidence, classifies
 * domains accurately, and coordinates across sessions.
 *
 * Brain lives in Claudex (where the data is). Nexus provides voice (phone/Telegram).
 *
 * Usage: node dist/angel/index.cjs [--interval <minutes>] [--model <model>]
 *
 * LLM: Uses a local llama.cpp server (Gemma 4 31B IT Q6_K) on 127.0.0.1:8081
 * for all generation tasks — pattern extraction, curated-context extraction,
 * entity summarization, observation consolidation, health reports. The server
 * is supervised by LlamaServerSupervisor and auto-launched at Angel startup.
 * Ollama is still used for embeddings (snowflake-arctic-embed2) but no
 * longer for generation. CliProxy has been removed entirely.
 *
 * Environment:
 *   CLAUDEX_DB_PATH — optional, overrides default DB location
 *   LLAMA_SERVER_EXE — optional, overrides path to llama-server.exe
 *   LLAMA_MODEL_PATH — optional, overrides path to the GGUF model file
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getDbPath, getClaudexHome } from '../shared/paths.js';
import { initializeSchema, runMigrations } from '../core/migrations.js';
import { ensureCollections, setVectorStoreDb } from '../embeddings/qdrant-client.js';
import { startHeartbeat, type TickResult } from './heartbeat.js';
import { DEFAULT_ANGEL_CONFIG, type AngelConfig } from './types.js';
import { RerankerSupervisor } from './reranker-supervisor.js';
import { LlamaServerSupervisor } from './llama-server-supervisor.js';
import { checkLlamaServerHealth } from './llama-client.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Partial<AngelConfig> {
  const config: Partial<AngelConfig> = {};

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--interval':
        if (argv[i + 1]) {
          const minutes = parseInt(argv[i + 1], 10);
          if (!isNaN(minutes) && minutes > 0) {
            config.heartbeatIntervalMs = minutes * 60 * 1000;
          }
          i++;
        }
        break;
      case '--model':
      case '--cloud-model':
        if (argv[i + 1]) {
          config.cloudModel = argv[i + 1];
          i++;
        }
        break;
      case '--local-model':
        if (argv[i + 1]) {
          config.localModel = argv[i + 1];
          i++;
        }
        break;
      case '--idle-threshold':
        if (argv[i + 1]) {
          const minutes = parseInt(argv[i + 1], 10);
          if (!isNaN(minutes) && minutes > 0) {
            config.idleThresholdSeconds = minutes * 60;
          }
          i++;
        }
        break;
      case '--auto-close-minutes':
        if (argv[i + 1]) {
          const minutes = parseInt(argv[i + 1], 10);
          if (!isNaN(minutes) && minutes > 0) {
            config.autoCloseMinutesAfterWarning = minutes;
          }
          i++;
        }
        break;
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

function getPidFilePath(): string {
  return path.join(getClaudexHome(), 'angel.pid');
}

function writePidFile(): void {
  try {
    const pidPath = getPidFilePath();
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid));
  } catch {
    // Non-fatal — Angel can run without PID file
  }
}

function removePidFile(): void {
  try {
    const pidPath = getPidFilePath();
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Check if another Angel instance is already running.
 * Reads the PID file and checks if the process exists.
 */
function isAlreadyRunning(): boolean {
  try {
    const pidPath = getPidFilePath();
    if (!fs.existsSync(pidPath)) return false;

    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;

    // Check if the process exists
    try {
      process.kill(pid, 0); // Signal 0 = check existence, don't kill
      return true;
    } catch {
      // Process doesn't exist — stale PID file
      fs.unlinkSync(pidPath);
      return false;
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  process.stderr.write(`[${timestamp}] [angel/${level}] ${message}${dataStr}\n`);
}

function logTickResult(result: TickResult): void {
  const parts: string[] = [];
  if (result.idle_warnings_sent > 0) parts.push(`idle_warnings=${result.idle_warnings_sent}`);
  if (result.sessions_processed > 0) parts.push(`sessions=${result.sessions_processed}`);
  if (result.patterns_extracted > 0) parts.push(`patterns=${result.patterns_extracted}`);
  if (result.domains_classified > 0) parts.push(`domains=${result.domains_classified}`);
  if (result.learnings_pruned) parts.push(`learnings_pruned=${result.learnings_pruned}`);
  if (result.patterns_pruned) parts.push(`patterns_pruned=${result.patterns_pruned}`);
  if (result.memory_entries_migrated) parts.push(`memory_migrated=${result.memory_entries_migrated}`);
  if (result.artifacts_linked) parts.push(`linked=${result.artifacts_linked}`);
  if (result.embeddings_backfilled) parts.push(`backfilled=${result.embeddings_backfilled}`);
  if (result.observations_consolidated) parts.push(`consolidated=${result.observations_consolidated}`);
  if (result.sessions_auto_closed) parts.push(`auto_closed=${result.sessions_auto_closed}`);
  if (result.user_profiles_synced) parts.push(`profiles_synced=${result.user_profiles_synced}`);
  if (result.retention_rows_deleted) parts.push(`retention=${result.retention_rows_deleted}`);
  if (result.cross_project_deduped) parts.push(`deduped=${result.cross_project_deduped}`);
  if (result.quality_issues_fixed) parts.push(`quality_fixed=${result.quality_issues_fixed}`);
  if (result.artifacts_promoted) parts.push(`promoted=${result.artifacts_promoted}`);
  if (result.artifacts_decayed) parts.push(`decayed=${result.artifacts_decayed}`);
  if (result.health_report_sent) parts.push('health_report=sent');
  if (result.dream_contradictions_resolved) parts.push(`dream_contradictions=${result.dream_contradictions_resolved}`);
  if (result.dream_stale_flagged) parts.push(`dream_stale=${result.dream_stale_flagged}`);

  if (parts.length > 0) {
    log('info', `tick: ${parts.join(', ')} (${result.duration_ms}ms)`);
  }
  if (result.error) {
    log('error', `tick error: ${result.error}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Check for duplicate instance
  if (isAlreadyRunning()) {
    log('warn', 'Angel is already running — exiting');
    process.exit(0);
  }

  // Claim the PID file IMMEDIATELY — before any slow init — so concurrent
  // session-start hooks that race Angel boot can't double-spawn us. The
  // previous ordering wrote the PID file only after `rerankerSupervisor.start()`
  // which blocks up to 60s on a cold BGE-v2-m3 load. During that window,
  // a second session-start could see no PID file, pass its own
  // isAlreadyRunning() check, and spawn a rival Angel that would fight
  // over port 7439, the DB, and the PID file itself. Claim-first semantics
  // close the race.
  writePidFile();

  // Resolve projectRoot from __dirname instead of process.cwd(). The
  // session-start hook spawns Angel with `cwd: os.homedir()` (for security —
  // see src/adapters/cc-hooks/session-start.ts), so process.cwd() is the
  // user's home directory, not the repo root. Using that as the supervisor's
  // projectRoot would make it look for ~/services/reranker.py, which
  // doesn't exist, and every auto-spawned Angel would silently fall back to
  // bi-encoder retrieval. __dirname is resolved against the compiled bundle
  // location (dist/angel/index.cjs), so `../..` is the repo root regardless
  // of CWD. This is the same pattern the session-start hook uses to resolve
  // `angelDist` defensively.
  const projectRoot = path.resolve(__dirname, '..', '..');

  // Parse config
  const cliConfig = parseArgs(process.argv);
  const config: AngelConfig = {
    ...DEFAULT_ANGEL_CONFIG,
    ...cliConfig,
    pidFile: getPidFilePath(),
  };

  // Create DB connection
  const db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  initializeSchema(db);
  runMigrations(db);

  // Register this connection with the sqlite-vec backend so the feature-
  // flagged dispatcher in qdrant-client.ts can route to vec0 when
  // CLAUDEX_VECTOR_BACKEND=sqlite-vec. Angel opens the DB directly (not
  // via openDatabase) so we call setVectorStoreDb explicitly here.
  setVectorStoreDb(db);

  // Ensure Qdrant collections (non-fatal)
  try {
    await ensureCollections();
  } catch {
    log('warn', 'Qdrant collections check failed — semantic features may be limited');
  }

  // Supervise the Python reranker service. Non-blocking: if the reranker
  // can't come up, Angel continues and hybrid-retrieval falls back to the
  // bi-encoder path via Ollama. Supervision gives us logs (context/logs/
  // reranker.log), bounded restart (3 attempts), and clean shutdown —
  // replaces the old fire-and-forget `start /B` pattern that lost children
  // to broken stdio pipes on Windows.
  const rerankerSupervisor = new RerankerSupervisor({
    projectRoot,
    logger: (level, message) => log(level, `reranker: ${message}`),
  });
  await rerankerSupervisor.start();

  // Supervise the local llama.cpp generation server (Gemma 4 31B IT Q6_K).
  // Non-blocking: if the server can't come up, Angel continues and every
  // LLM-dependent subsystem (pattern extraction, curated-context extraction,
  // entity summarization, consolidation, health reports) skips its work
  // and retries next tick. Supervision gives us logs (context/logs/
  // llama-server.log), bounded restart (2 attempts), and clean shutdown.
  const llamaServerSupervisor = new LlamaServerSupervisor({
    projectRoot,
    logger: (level, message) => log(level, `llama-server: ${message}`),
  });
  await llamaServerSupervisor.start();
  const llamaHealthy = await checkLlamaServerHealth();

  // Log startup
  const intervalMin = Math.round(config.heartbeatIntervalMs / 60000);
  log('info', `Angel started`, {
    pid: process.pid,
    llm: llamaHealthy
      ? 'local llama-server (Gemma 4 31B Q6_K via 127.0.0.1:8081)'
      : 'local llama-server unavailable — generation tasks will retry',
    interval_minutes: intervalMin,
    idle_threshold_minutes: Math.round(config.idleThresholdSeconds / 60),
  });

  // Start heartbeat — wire both supervisors through so the heartbeat can
  // call ensureRunning() whenever their health probes report them as down.
  // Without this, a single supervisor failure at boot would leave the
  // service permanently dead until Angel itself restarted.
  const heartbeat = startHeartbeat(
    { db, config, rerankerSupervisor, llamaServerSupervisor },
    logTickResult,
  );

  // Signal handlers for graceful shutdown
  const shutdown = (signal: string) => {
    log('info', `${signal} received — shutting down`);
    heartbeat.stop();
    rerankerSupervisor.stop();
    llamaServerSupervisor.stop();
    setVectorStoreDb(null); // release reference before db.close()
    removePidFile();
    try { db.close(); } catch { /* */ }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log('error', `uncaught exception: ${err.message}`);
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  log('error', `fatal: ${err instanceof Error ? err.message : String(err)}`);
  removePidFile();
  process.exit(1);
});
