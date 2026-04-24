/**
 * Angel launcher — shared helper for spawning and health-checking the Angel
 * process from CC hooks.
 *
 * Extracted from session-start.ts for plan 04-06-03 (hook-driven liveness):
 * user-prompt-submit.ts now imports and calls `ensureAngelRunning()` on every
 * user turn so Angel dying mid-session is revived within one user prompt.
 * Keeping the function in session-start.ts would re-run the whole SessionStart
 * `main()` at import time because that file registers itself as a hook entry
 * point with `main()` at module top level — causing the hook to double-fire
 * every turn (broke the build smoke test, caught during 04-06-03).
 *
 * The helper is:
 *   • Non-throwing (Angel is always optional — hook must never fail on its
 *     behalf).
 *   • Idempotent (checks PID file first; only spawns when needed).
 *   • Observable (when db+session are supplied, failures record
 *     `angel_log_open_failed` session events and respawns record
 *     `angel_respawn`).
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import type { Database } from 'better-sqlite3';
import { openAngelLogForAppend } from './angel-log.js';
import { recordEvent } from '../../core/session-events.js';

/**
 * Ensure the Angel process is running. Checks PID file, spawns if not alive.
 * Non-throwing — Angel is optional enhancement.
 *
 * Plan 04-06-01: stdout/stderr are captured to ~/.claudex/logs/angel.log
 * (appended, with one-generation 10 MB rotation). If the log file cannot be
 * opened, we fall back to `stdio: 'ignore'` and record a one-off
 * `angel_log_open_failed` session event so the failure is observable.
 *
 * Plan 04-06-03 (hook-driven liveness): this is called from both
 * session-start AND user-prompt-submit so each user turn verifies Angel is
 * alive and restarts on death. The `isUserTurn` flag is recorded in an
 * `angel_respawn` event whenever a respawn was actually attempted, so we
 * can see in telemetry how often hook-driven recovery kicks in.
 */
export async function ensureAngelRunning(
  db?: Database,
  sessionId?: string,
  project?: string,
  isUserTurn: boolean = false,
): Promise<void> {
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

  // Attempt to capture stdout/stderr to the Angel log file. On failure (disk
  // full, permission denied, etc.) fall back to stdio:'ignore' so Angel still
  // comes up; we record one angel_log_open_failed event per attempt so the
  // failure is observable instead of silent.
  const { fd: logFd, reason: logErr } = openAngelLogForAppend();
  if (logFd === null && db && sessionId) {
    recordEvent(
      db,
      sessionId,
      project ?? '',
      'angel_log_open_failed',
      'angel',
      'fallback_stdio_ignore',
      logErr ?? 'unknown error',
    );
  }

  // Spawn detached Angel process using absolute Node path (security: prevents
  // PATH hijacking with a malicious node.exe in the project directory)
  const stdio: ['ignore', number | 'ignore', number | 'ignore'] = logFd !== null
    ? ['ignore', logFd, logFd]
    : ['ignore', 'ignore', 'ignore'];
  const child = spawn(process.execPath, [angelDist], {
    detached: true,
    stdio,
    env: { ...process.env },
    cwd: os.homedir(), // Safe CWD — not the project directory
  });
  child.unref();

  // Close our copy of the fd — the spawned child now owns it via dup2. The
  // parent CC hook is ephemeral and exits in milliseconds; leaving the fd
  // open would briefly pin the file handle but not cause correctness issues.
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* child holds the real handle */ }
  }

  if (isUserTurn && db && sessionId) {
    recordEvent(
      db,
      sessionId,
      project ?? '',
      'angel_respawn',
      'angel',
      'hook_driven_liveness',
      JSON.stringify({ log_captured: logFd !== null }),
    );
  }
}
