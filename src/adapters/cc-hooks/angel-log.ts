/**
 * Angel log-file helper — opens ~/.claudex/logs/angel.log for append with
 * one-generation size-based rotation. Used by session-start (and the
 * user-prompt-submit liveness check) to capture Angel's stdout/stderr so
 * silent deaths become diagnosable.
 *
 * Before plan 04-06-01 the session-start spawn call used `stdio: 'ignore'`.
 * When Angel died during VRAM contention on 2026-04-24, there was no trace
 * of the exception anywhere — no telemetry, no log, just a stale PID file
 * and a dead process. This helper is Fix 1 of the three-layer resilience
 * hardening.
 *
 * Non-throwing by contract. All failures return `null` so the caller falls
 * back to `stdio: 'ignore'` — Angel staying up matters more than capturing
 * its stderr.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getClaudexHome } from '../../shared/paths.js';

/** 10 MB rotation threshold. */
export const ROTATE_AT_BYTES = 10 * 1024 * 1024;

/** Absolute path to the current Angel log file (~/.claudex/logs/angel.log). */
export function getAngelLogPath(): string {
  return path.join(getClaudexHome(), 'logs', 'angel.log');
}

/** Absolute path to the previous-generation rotated log (angel.log.1). */
export function getAngelLogRotatedPath(): string {
  return getAngelLogPath() + '.1';
}

export interface AngelLogOpenResult {
  /** File descriptor open for append, or null if open/rotate failed. */
  fd: number | null;
  /** Error message when fd is null — caller records a telemetry event. */
  reason: string | null;
}

/**
 * Ensure the log directory exists and open the log file for append. Performs
 * one-generation size-based rotation at `ROTATE_AT_BYTES`: the existing log
 * is renamed to angel.log.1 (replacing any prior .1 file) and a fresh log is
 * opened. Returns a raw fd suitable for passing as `stdio[1]` / `stdio[2]`
 * to `child_process.spawn`.
 *
 * Rotation and directory creation are best-effort — a failure at any stage
 * returns { fd: null, reason } and the caller must fall back to
 * `stdio: 'ignore'` so session-start never blocks on log-setup errors.
 */
export function openAngelLogForAppend(): AngelLogOpenResult {
  const logPath = getAngelLogPath();
  try {
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Rotate at size threshold. One generation only — angel.log.1 gets
    // clobbered each rotation. Keeps the on-disk footprint bounded at ~20MB.
    try {
      const stat = fs.statSync(logPath);
      if (stat.size >= ROTATE_AT_BYTES) {
        const rotatedPath = getAngelLogRotatedPath();
        try {
          if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
        } catch { /* non-fatal — rename will still try */ }
        fs.renameSync(logPath, rotatedPath);
      }
    } catch (err) {
      // ENOENT is expected on first run — nothing to rotate. Any other error
      // (EACCES, EBUSY on Windows if the .1 file is locked by a viewer) is
      // non-fatal; skip rotation and proceed with append.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // fall through — we still attempt to open the log for append.
      }
    }

    const fd = fs.openSync(logPath, 'a');
    return { fd, reason: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { fd: null, reason };
  }
}
