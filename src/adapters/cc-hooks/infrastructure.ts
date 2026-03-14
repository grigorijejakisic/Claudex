/**
 * Shared infrastructure for all CC hook entry points.
 * Provides stdin/stdout JSON protocol, DB bootstrap, and wrapHook latency/error wrapper.
 * @see Architecture Section 3.2
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { openDatabase, closeDatabase } from '../../core/storage.js';
import type { Database } from 'better-sqlite3';
import { loadConfig } from '../../shared/config.js';
import type { ClaudexConfig } from '../../shared/config.js';
import { detectProjectScope, getProjectId } from '../../shared/scope-detector.js';
import { getDbPath } from '../../shared/paths.js';
import { emitTelemetry } from '../../observability/telemetry.js';

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

/** Hook name to RuntimeEvent kind mapping. */
const hookToEventKind: Record<string, string> = {
  SessionStart: 'session_init',
  UserPromptSubmit: 'before_prompt',
  PostToolUse: 'after_tool',
  Stop: 'after_turn',
  PreCompact: 'before_compact',
  SessionEnd: 'session_end',
};

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
 * Writes JSON to stdout. Non-throwing.
 */
export function writeStdout(output: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(output) + '\n');
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
  const project = getProjectId(input.cwd);

  return { db, config, project, scope, adapter: 'cc-hooks' };
}

/**
 * Validates that a transcript path is safe to read.
 * R21: Rejects UNC/device paths and paths outside the user's home directory.
 * Mirrors the isPathSafe check from src/gauge/token-gauge.ts (C9).
 * @internal
 */
function isTranscriptPathSafe(transcriptPath: string): boolean {
  const resolved = path.resolve(transcriptPath);
  // Reject UNC paths (\\server\share or //server/share)
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) return false;
  // Reject Windows device paths (\\.\ or \\?\)
  if (resolved.startsWith('\\\\.\\') || resolved.startsWith('\\\\?\\')) return false;
  // Must be under user's home directory
  let normalizedResolved = resolved;
  let home = os.homedir();
  try {
    if (process.platform === 'win32') {
      normalizedResolved = fs.realpathSync.native(resolved);
      home = fs.realpathSync.native(home);
    }
  } catch {
    // If file doesn't exist yet or realpath fails, use the resolved path as-is
  }
  const rel = path.relative(home, normalizedResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Extracts and validates transcript path from hook input. Non-throwing.
 * R21: Applies trust-boundary validation — rejects UNC, device, and out-of-home paths.
 */
export function getTranscriptPath(input: HookInput): string | undefined {
  try {
    const raw = (input.transcript_path as string) || (input.transcriptPath as string);
    if (!raw) return undefined;
    if (!isTranscriptPathSafe(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * R22: Sanitize error messages before persisting to telemetry.
 * Truncates to 200 chars and redacts file paths to prevent sensitive content leakage.
 */
export function sanitizeErrorForTelemetry(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .slice(0, 200)
    // Redact Windows absolute paths (C:\Users\..., D:\...)
    .replace(/[A-Za-z]:\\[^\s"',;)}\]]+/g, '[path]')
    // Redact Unix absolute paths (/home/..., /tmp/...)
    .replace(/\/(?:home|tmp|usr|var|etc)\/[^\s"',;)}\]]+/g, '[path]');
}

/**
 * Higher-order function wrapping a hook handler with:
 * - Latency measurement
 * - Error catching (writes {} on failure)
 * - Telemetry emission
 * - DB close in finally
 */
export function wrapHook(hookName: string, handler: HookHandler): () => Promise<void> {
  return async () => {
    const startMs = Date.now();
    let ctx: BootstrapResult | null = null;
    let input: HookInput | null = null;

    try {
      input = await readStdin();

      // C5: Fail-closed validation — reject missing/invalid required fields
      if (!input.session_id || typeof input.session_id !== 'string' ||
          !input.cwd || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
        writeStdout({});
        return;
      }

      ctx = bootstrapHook(input);
      const output = await handler(input, ctx);

      const elapsed = Date.now() - startMs;
      const hasInjection = !!(output.additionalContext || output.systemMessage);
      emitTelemetry(ctx.db, input.session_id, 'hook_invocation', {
        hook: hookName,
        duration_ms: elapsed,
        result: hasInjection ? 'inject' as const : 'skip' as const,
      }, elapsed, 'cc-hooks');

      writeStdout(output);
    } catch (err) {
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
