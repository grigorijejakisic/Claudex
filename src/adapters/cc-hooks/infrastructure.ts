/**
 * Shared infrastructure for all CC hook entry points.
 * Provides stdin/stdout JSON protocol, DB bootstrap, and wrapHook latency/error wrapper.
 */

import * as path from 'path';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import type { Database } from 'better-sqlite3';
import { loadConfig } from '../../shared/config.js';
import type { ClaudexConfig } from '../../shared/config.js';
import { detectProjectScope, deriveProjectId } from '../../shared/scope-detector.js';
import { getDbPath } from '../../shared/paths.js';
import { emitTelemetry, sanitizeErrorForTelemetry } from '../../observability/telemetry.js';
import { isPathSafe } from '../../shared/fs-helpers.js';

/** Parsed CC hook stdin payload. */
export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  [key: string]: unknown;
}

/** Bootstrap result: DB + config + project scope + adapter identity. */
export interface BootstrapResult {
  db: Database;
  config: ClaudexConfig;
  project: string;
  scope: string | null;
  adapter: 'cc-hooks';
}

/** Hook handler function signature. */
export type HookHandler = (input: HookInput, ctx: BootstrapResult) => Promise<Record<string, unknown>>;

/** Safe default for failed stdin reads. */
const SAFE_INPUT: HookInput = { hook_event_name: '', session_id: '', cwd: '' };

/** Hard limit on stdin payload size (1 MB). Prevents unbounded memory growth. */
const MAX_STDIN_BYTES = 1_000_000;

/**
 * Reads all stdin and JSON.parses. Non-throwing — returns safe default on error.
 */
export function readStdin(): Promise<HookInput> {
  return new Promise((resolve) => {
    try {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let resolved = false;
      process.stdin.on('data', (chunk: Buffer) => {
        if (resolved) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_STDIN_BYTES) {
          resolved = true;
          resolve(SAFE_INPUT);
          return;
        }
        chunks.push(chunk);
      });
      process.stdin.on('end', () => {
        if (resolved) return;
        resolved = true;
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const result: HookInput = {
              ...parsed,
              hook_event_name: parsed.hook_event_name ?? '',
              session_id: parsed.session_id ?? '',
              cwd: parsed.cwd ?? '',
            };
            resolve(result);
          } else {
            resolve(SAFE_INPUT);
          }
        } catch {
          resolve(SAFE_INPUT);
        }
      });
      process.stdin.on('error', () => {
        if (resolved) return;
        resolved = true;
        resolve(SAFE_INPUT);
      });
      process.stdin.resume();
    } catch {
      resolve(SAFE_INPUT);
    }
  });
}

/**
 * K4: Sanitize `cch=XXXXX` billing hash patterns to prevent CC's standalone binary
 * from performing global string substitution across all historical tool results,
 * which permanently breaks prompt cache. Replaces `=` with `_` so the pattern
 * no longer matches CC's regex while preserving the hash value for debugging.
 */
const CCH_PATTERN = /cch=[a-f0-9]{3,}/gi;

/**
 * Writes JSON to stdout. Non-throwing.
 * K4: All output is sanitized through CCH_PATTERN before writing.
 */
export function writeStdout(output: Record<string, unknown>): void {
  try {
    let json = JSON.stringify(output);
    json = json.replace(CCH_PATTERN, (match) => match.replace('=', '_'));
    process.stdout.write(json + '\n');
  } catch {
    // Non-throwing
  }
}

/**
 * Validates that a cwd path is safe: must be absolute and not a UNC or device path.
 * Returns true if valid, false if rejected.
 */
export function validateCwd(cwd: string): boolean {
  if (!cwd || typeof cwd !== 'string') return false;
  if (!path.isAbsolute(cwd)) return false;

  // Reject UNC paths (\\server\share or //server/share)
  if (cwd.startsWith('\\\\') || cwd.startsWith('//')) return false;

  // Reject Windows device paths (\\.\ or \\?\)
  if (cwd.startsWith('\\\\.') || cwd.startsWith('\\\\?')) return false;

  return true;
}

/**
 * Opens DB, loads config, detects project scope.
 * Throws if DB open fails or cwd validation fails (let wrapHook catch it).
 */
export function bootstrapHook(input: HookInput): BootstrapResult {
  if (!validateCwd(input.cwd)) {
    throw new Error(`Invalid cwd: rejected by path validation`);
  }

  const db = openDatabase(getDbPath());
  const config = loadConfig();
  const scope = detectProjectScope(input.cwd);
  // Use scope directly if found, otherwise derive without re-reading projects.json
  const project = scope ?? deriveProjectId(input.cwd);

  return { db, config, project, scope, adapter: 'cc-hooks' };
}

/**
 * Extracts and validates transcript path from hook input. Non-throwing.
 * Applies trust-boundary validation — rejects UNC, device, and out-of-home paths.
 */
export function getTranscriptPath(input: HookInput): string | undefined {
  try {
    const raw = (input.transcript_path as string) || (input.transcriptPath as string);
    if (!raw) return undefined;
    if (!isPathSafe(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Higher-order function wrapping a hook handler with:
 * - Latency measurement
 * - Error catching (writes {} on failure)
 * - Telemetry emission
 * - DB close in finally
 *
 * ## CC-provided environment variables
 *
 * CC sets these env vars before spawning hook commands:
 *
 * - `CLAUDE_PROJECT_DIR` — Absolute path to the project root (always present).
 *   Note: this is the real root, not a worktree path. Claudex uses `cwd` from
 *   the stdin JSON payload instead, which is more reliable across shell types.
 *
 * - `CLAUDE_ENV_FILE` — Path to a bash-sourceable env file. Present only for
 *   SessionStart, Setup, CwdChanged, and FileChanged hooks, and only in bash
 *   shells (not PowerShell). Claudex writes to this in session-start via
 *   `writeClaudeEnvFile()` in env-file.ts.
 *
 * - `CLAUDE_PLUGIN_ROOT` — Plugin/skill root directory (plugins only).
 * - `CLAUDE_PLUGIN_DATA` — Plugin data directory (plugins only).
 * - `CLAUDE_PLUGIN_OPTION_*` — Plugin userConfig values (plugins only).
 *
 * The plugin env vars are irrelevant until Claudex is packaged as a CC plugin.
 */
export function wrapHook(hookName: string, handler: HookHandler): () => Promise<void> {
  return async () => {
    const startMs = Date.now();
    let ctx: BootstrapResult | null = null;
    let input: HookInput | null = null;

    try {
      input = await readStdin();

      // Fail-closed validation — reject missing/invalid required fields
      if (!input.session_id || typeof input.session_id !== 'string' ||
          !input.cwd || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
        writeStdout({});
        return;
      }

      ctx = bootstrapHook(input);
      const output = await handler(input, ctx);

      // Post-execution sanity check: verify session was created
      if (hookName === 'SessionStart' && ctx?.db && input?.session_id) {
        try {
          const row = ctx.db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(input.session_id);
          if (!row) {
            console.error(`[claudex] WARNING: SessionStart completed but session ${input.session_id} not found in DB`);
          }
        } catch {
          // Non-fatal — don't break the hook for a diagnostic check
        }
      }

      const elapsed = Date.now() - startMs;
      const hso = output.hookSpecificOutput as Record<string, unknown> | undefined;
      const hasInjection = !!(output.additionalContext || output.systemMessage || hso?.additionalContext);
      emitTelemetry(ctx.db, input.session_id, 'hook_invocation', {
        hook: hookName,
        duration_ms: elapsed,
        result: hasInjection ? 'inject' as const : 'skip' as const,
      }, elapsed, 'cc-hooks');

      writeStdout(output);
    } catch (err) {
      // Log to stderr so failures are visible even if DB is broken
      try { console.error(`[claudex] ${hookName} error:`, err instanceof Error ? err.message : String(err)); } catch {}
      // Try to emit error telemetry if DB is available
      if (ctx?.db) {
        try {
          const elapsed = Date.now() - startMs;
          emitTelemetry(ctx.db, input?.session_id ?? '', 'error', {
            subsystem: `cc-hooks/${hookName}`,
            error: sanitizeErrorForTelemetry(err),
          }, elapsed, 'cc-hooks');
        } catch {
          // Best effort — if telemetry fails too, just continue
        }
      }
      writeStdout({});
    } finally {
      if (ctx?.db) {
        closeDatabase(ctx.db);
      }
    }
  };
}
