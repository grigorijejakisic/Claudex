/**
 * Phase 6 chokidar JSONL watcher.
 *
 * Watches `~/.claude/projects/**\/*.jsonl` and updates
 * `sessions.last_jsonl_write_ts` on every JSONL `add` or `change` event.
 * Provides exponential-backoff error recovery so a transient chokidar
 * failure (EBADF, ENOENT race, permission error) never silently kills
 * the boundary detector.
 *
 * Design notes:
 *   - `ignoreInitial: true` prevents re-stamping every existing JSONL with
 *     `now` on watcher boot (Pitfall 1 in 06-RESEARCH.md). Existing files
 *     are quiet until they actually receive an append.
 *   - `awaitWriteFinish` debounces the rapid-fire JSONL appends Claude Code
 *     emits during a session, so we don't UPDATE the same row dozens of
 *     times per turn.
 *   - DB writes are wrapped in try/catch — a database error must NEVER kill
 *     the watcher. Same posture as `telemetry-counters.ts`.
 *   - The controller hides chokidar's FSWatcher so callers can't accidentally
 *     reach into the underlying chokidar instance from elsewhere in the codebase.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { loadThresholds, type BoundaryThresholds } from './thresholds.js';

const BACKOFF_LADDER_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const BACKOFF_CAP_MS = 30000;

export interface JsonlWatcherController {
  close(): Promise<void>;
  healthCheck(): { healthy: boolean; consecutiveErrors: number };
  /** Test-only: simulate a chokidar error event. Gated on NODE_ENV==='test'. */
  simulateError?(err: Error): void;
}

export interface JsonlWatcherOptions {
  /** Override the watch root (defaults to `~/.claude/projects`). Tests use this. */
  watchRoot?: string;
  /** Override threshold loader (tests want shorter debounce). */
  thresholds?: BoundaryThresholds;
}

/**
 * Parses `{project_flattened}/{session_id}.jsonl` from a path.
 * Returns null on malformed input. Exported for tests.
 *
 * Examples:
 *   .../.claude/projects/C--Users-foo-Projects-claudex/abc123.jsonl
 *     -> { project: 'C--Users-foo-Projects-claudex', sessionId: 'abc123' }
 */
export function parseSessionIdFromPath(filePath: string): { project: string; sessionId: string } | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/projects\/([^/]+)\/([^/]+)\.jsonl$/);
  if (!match) return null;
  const project = match[1];
  const sessionId = match[2];
  if (!project || !sessionId) return null;
  return { project, sessionId };
}

function writeWatcherErrorTelemetry(
  db: Database,
  errorMessage: string,
  consecutiveErrors: number,
  backoffMsNext: number,
): void {
  try {
    cachedPrepare(
      db,
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, 'jsonl_watcher_unreachable', ?, 'phase-6-watcher')`,
    ).run(
      'angel',
      JSON.stringify({
        error_message: errorMessage,
        consecutive_errors: consecutiveErrors,
        backoff_ms_next: backoffMsNext,
      }),
    );
  } catch {
    // Swallowed — telemetry write must never break the watcher. Pre-V29
    // DBs (or DBs without the 'jsonl_watcher_unreachable' enum extension)
    // silently drop the row.
  }
}

function nextBackoffMs(consecutiveErrors: number): number {
  const idx = Math.max(0, consecutiveErrors - 1);
  if (idx < BACKOFF_LADDER_MS.length) return BACKOFF_LADDER_MS[idx]!;
  return BACKOFF_CAP_MS;
}

export function startJsonlWatcher(
  db: Database,
  opts: JsonlWatcherOptions = {},
): JsonlWatcherController {
  const thresholds = opts.thresholds ?? loadThresholds();
  const watchRoot = opts.watchRoot ?? path.join(homedir(), '.claude', 'projects');

  let consecutiveErrors = 0;
  let closed = false;
  let backoffTimer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;

  const updateWriteTs = (filePath: string): void => {
    try {
      // Watch root is the projects directory; chokidar fires for ALL files
      // beneath it. Filter to *.jsonl here rather than via glob — chokidar 5.x
      // glob support on Windows (drive-letter colons) is fragile.
      if (!filePath.endsWith('.jsonl')) return;
      const parsed = parseSessionIdFromPath(filePath);
      if (!parsed) return;
      const now = Math.floor(Date.now() / 1000);
      cachedPrepare(
        db,
        `UPDATE sessions SET last_jsonl_write_ts = ? WHERE session_id = ?`,
      ).run(now, parsed.sessionId);
      if (consecutiveErrors > 0) consecutiveErrors = 0;
    } catch {
      // DB error — never kill the watcher.
    }
  };

  const handleError = (err: unknown): void => {
    if (closed) return;
    consecutiveErrors += 1;
    const message = err instanceof Error ? err.message : String(err);
    const backoffMs = nextBackoffMs(consecutiveErrors);
    writeWatcherErrorTelemetry(db, message, consecutiveErrors, backoffMs);
    if (backoffTimer) clearTimeout(backoffTimer);
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      if (closed) return;
      try {
        if (watcher) {
          void watcher.close();
        }
        bind();
      } catch {
        // Re-bind failed — the next chokidar 'error' event will re-trigger
        // handleError and ladder up the backoff.
      }
    }, backoffMs);
  };

  const bind = (): void => {
    if (closed) return;
    watcher = chokidar.watch(watchRoot, {
      ignoreInitial: true,
      ignored: (p: string) => /node_modules/.test(p),
      awaitWriteFinish: {
        stabilityThreshold: thresholds.jsonlDebounceMs,
        pollInterval: 50,
      },
      persistent: true,
      ignorePermissionErrors: true,
    });
    watcher.on('add', updateWriteTs);
    watcher.on('change', updateWriteTs);
    watcher.on('error', handleError);
  };

  bind();

  const controller: JsonlWatcherController = {
    async close() {
      closed = true;
      if (backoffTimer) {
        clearTimeout(backoffTimer);
        backoffTimer = null;
      }
      if (watcher) {
        try { await watcher.close(); } catch { /* swallow */ }
        watcher = null;
      }
    },
    healthCheck() {
      return { healthy: consecutiveErrors === 0, consecutiveErrors };
    },
  };

  if (process.env.NODE_ENV === 'test') {
    controller.simulateError = (err: Error): void => {
      handleError(err);
    };
  }

  return controller;
}
