/**
 * Shared infrastructure for all CC hook entry points.
 * Provides stdin/stdout JSON protocol, DB bootstrap, and wrapHook latency/error wrapper.
 * @see Architecture Section 3.2
 */

import { openDatabase, closeDatabase } from '../../core/storage.js';
import type { Database } from 'better-sqlite3';
import { loadConfig } from '../../shared/config.js';
import type { ClaudexConfig } from '../../shared/config.js';
import { detectProjectScope, getProjectId } from '../../shared/scope-detector.js';
import { getDbPath } from '../../shared/paths.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { BRIDGE_KEY } from '../openclaw-bridge/bridge-types.js';

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
      process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on('end', () => {
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
      process.stdin.on('error', () => resolve(SAFE_INPUT));
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
 * Opens DB, loads config, detects project scope.
 * Throws if DB open fails (let wrapHook catch it).
 */
export function bootstrapHook(input: HookInput): BootstrapResult {
  const db = openDatabase(getDbPath());
  const config = loadConfig();
  const scope = detectProjectScope(input.cwd);
  const project = getProjectId(input.cwd, scope);

  return { db, config, project, scope, adapter: 'cc-hooks' };
}

/**
 * Detects adapter type from environment. Non-throwing.
 */
export function detectAdapter(): 'cc-hooks' | 'openclaw-bridge' {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as Record<symbol, unknown>)[BRIDGE_KEY]) {
      return 'openclaw-bridge';
    }
  } catch {
    // Non-throwing
  }
  return 'cc-hooks';
}

/**
 * Extracts transcript path from hook input. Non-throwing.
 */
export function getTranscriptPath(input: HookInput): string | undefined {
  try {
    const path = (input.transcript_path as string) || (input.transcriptPath as string);
    return path || undefined;
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
 */
export function wrapHook(hookName: string, handler: HookHandler): () => Promise<void> {
  return async () => {
    const startMs = Date.now();
    let ctx: BootstrapResult | null = null;
    let input: HookInput | null = null;

    try {
      input = await readStdin();
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
            error: err instanceof Error ? err.message : String(err),
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
