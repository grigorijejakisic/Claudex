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
 * Auth: Reads OAuth token from ~/.claude/.credentials.json (MAX subscription).
 * Fallback: ANTHROPIC_API_KEY env var.
 *
 * Environment:
 *   CLAUDEX_DB_PATH — optional, overrides default DB location
 */

import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDbPath, getClaudexHome } from '../shared/paths.js';
import { initializeSchema, runMigrations } from '../core/migrations.js';
import { ensureCollections } from '../embeddings/qdrant-client.js';
import { startHeartbeat, type TickResult } from './heartbeat.js';
import { DEFAULT_ANGEL_CONFIG, type AngelConfig } from './types.js';

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
// OAuth credential loading (MAX subscription)
// ---------------------------------------------------------------------------

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    subscriptionType?: string;
  };
}

/**
 * Read OAuth token from ~/.claude/.credentials.json (MAX subscription).
 * Returns the access token or null if not available.
 */
function loadOAuthToken(): string | null {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) return null;

    const raw = fs.readFileSync(credPath, 'utf-8');
    const creds: ClaudeCredentials = JSON.parse(raw);

    if (creds.claudeAiOauth?.accessToken) {
      return creds.claudeAiOauth.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if CliProxy is available on localhost:8317.
 * CliProxy exposes OAuth as an OpenAI/Anthropic-compatible API — no API key needed.
 */
async function isCliProxyAvailable(): Promise<boolean> {
  try {
    // CliProxy doesn't have /health — use /v1/models to verify it's alive
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch('http://127.0.0.1:8317/v1/models', { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Create Anthropic client with the best available auth method.
 * Priority: CliProxy (localhost:8317) > OAuth token > ANTHROPIC_API_KEY.
 * CliProxy exposes MAX subscription OAuth as a standard API — best option.
 * OAuth token from ~/.claude/.credentials.json works directly with Anthropic API.
 */
function createAnthropicClient(useCliProxy: boolean): { client: Anthropic; authMethod: string } | null {
  // Priority 1: CliProxy on localhost:8317 (uses MAX subscription OAuth internally)
  if (useCliProxy) {
    return {
      client: new Anthropic({ apiKey: 'cliproxy', baseURL: 'http://127.0.0.1:8317' }),
      authMethod: 'cliproxy (MAX subscription via localhost:8317)',
    };
  }

  // Priority 2: API key env var
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return {
      client: new Anthropic({ apiKey }),
      authMethod: 'api_key',
    };
  }

  return null;
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

  // Create Anthropic client
  // Priority: CliProxy (localhost:8317, MAX subscription) > API key
  // If neither available, Angel runs Ollama-only for all LLM tasks.
  // Never uses Claude CLI subprocess — it triggers hooks and creates phantom sessions.
  const cliProxyAvailable = await isCliProxyAvailable();
  const auth = createAnthropicClient(cliProxyAvailable);
  if (!auth) {
    log('warn', 'No API auth available — Angel will use Ollama for all LLM tasks');
  }

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

  // Ensure Qdrant collections (non-fatal)
  try {
    await ensureCollections();
  } catch {
    log('warn', 'Qdrant collections check failed — semantic features may be limited');
  }

  // Write PID file
  writePidFile();

  // Create a fallback client if no auth available (pattern-extractor falls back to Ollama)
  const client = auth?.client ?? new Anthropic({ apiKey: 'no-auth-ollama-only', baseURL: 'http://127.0.0.1:0' });

  // Log startup
  const intervalMin = Math.round(config.heartbeatIntervalMs / 60000);
  log('info', `Angel started`, {
    pid: process.pid,
    auth: auth?.authMethod ?? 'none (Ollama only)',
    cloudModel: config.cloudModel,
    localModel: config.localModel,
    interval_minutes: intervalMin,
    idle_threshold_minutes: Math.round(config.idleThresholdSeconds / 60),
  });

  // Start heartbeat
  const heartbeat = startHeartbeat(
    { db, client, config },
    logTickResult,
  );

  // Signal handlers for graceful shutdown
  const shutdown = (signal: string) => {
    log('info', `${signal} received — shutting down`);
    heartbeat.stop();
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
