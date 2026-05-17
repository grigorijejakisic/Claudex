/**
 * Claude Code subprocess generation backend.
 *
 * Replaces the Ollama daemon (callLocalLLM) for synthesis workloads. Spawns
 * the local `claude` CLI in --print mode and parses the structured JSON
 * envelope returned by --output-format json. Uses MAX subscription OAuth
 * credentials from `~/.claude/.credentials.json` — no API key juggling.
 *
 * Why subprocess: see `feedback_benchmarks_are_sanity_not_gates.md` companion
 * doc. The "hook deadlock" rule forbids in-process CC API calls from a hook
 * of the SAME CC instance. Spawning a NEW `claude` process is a different OS
 * process — verified deadlock-safe (2026-05-17, smoke test from inside a CC
 * hook returned cleanly).
 *
 * Recursive-hook risk: a naive `claude --print` invocation runs the child's
 * SessionStart/Stop hooks, which would in turn invoke Angel + write session
 * rows + enqueue CHR work for the child itself. Suppressed via the
 * `CLAUDEX_GENERATION_CHILD=1` env var injected into the spawn. Every claudex
 * hook checks this env var at entry and short-circuits before any DB writes.
 *
 * Default model is haiku (high-throughput classification: CHR, directives,
 * domain). Synthesis workloads (LSS, highlights) pass model='sonnet' for the
 * quality jump where it matters.
 *
 * All calls are telemetered (cost, latency, tokens). Concurrency capped to
 * MAX_CONCURRENT_CALLS to avoid bursting MAX subscription rate limits.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum concurrent `claude` subprocesses. */
const MAX_CONCURRENT_CALLS = 4;

/** Default request timeout — 90s covers slowest Sonnet synthesis cleanly. */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Default model — Haiku for classification volume. Override per call. */
const DEFAULT_MODEL = 'haiku';

/** Retry parameters for transient failures (429 rate limit, model overload). */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1500;

/** Path to the `claude` CLI. Override via CLAUDE_CLI_PATH for tests/CI. */
const CLAUDE_CLI = process.env['CLAUDE_CLI_PATH'] ?? 'claude';

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

let _inflight = 0;
const _waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (_inflight < MAX_CONCURRENT_CALLS) {
    _inflight++;
    return;
  }
  await new Promise<void>((resolve) => _waiters.push(resolve));
  _inflight++;
}

function releaseSlot(): void {
  _inflight--;
  const next = _waiters.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeSubprocessCallOptions {
  /** User-role prompt content. */
  prompt: string;

  /** System-prompt override (replaces default CC system). */
  system?: string;

  /** Append-only system prompt addition (preserves CC defaults). */
  appendSystem?: string;

  /**
   * Model alias or full ID. Accepts 'haiku' | 'sonnet' | 'opus' or any
   * Anthropic model ID. Defaults to DEFAULT_MODEL.
   */
  model?: string;

  /**
   * JSON Schema for structured output. When provided, the CLI uses
   * --json-schema and the response is validated server-side. Returned as
   * a parsed object in `content`.
   */
  schema?: Record<string, unknown>;

  /** Sampling temperature passthrough (currently unused by --print). */
  temperature?: number;

  /** Per-call timeout. Default 90s. */
  timeoutMs?: number;

  /** Test injection point. */
  spawnFn?: typeof spawn;

  /**
   * Database for telemetry emission. When omitted, the call still runs
   * but no telemetry row is written.
   */
  db?: Database;

  /**
   * Tag for telemetry — names the calling subsystem (e.g. 'lss', 'chr',
   * 'highlights', 'directives', 'domain'). Aids downstream cost attribution.
   */
  subsystem?: string;
}

export interface ClaudeSubprocessResult {
  /**
   * Parsed structured output when `schema` was provided; otherwise the
   * plain text response string.
   */
  content: string | Record<string, unknown>;

  /** USD cost for this call, parsed from the CLI's `total_cost_usd`. */
  costUsd: number;

  /** Token usage breakdown. */
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
  };

  /** Wall-clock latency in ms (includes subprocess startup). */
  latencyMs: number;

  /** Model that produced the result. */
  model: string;

  /** True if the call retried at least once. */
  retried: boolean;

  /** Final retry count consumed. */
  attempts: number;
}

/** Raw CLI envelope returned by `claude --print --output-format json`. */
interface ClaudeCliEnvelope {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  api_error_status?: number | null;
  duration_ms: number;
  duration_api_ms?: number;
  result: string;
  stop_reason: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  structured_output?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Errors worth retrying with backoff. */
function isTransientError(envelope: ClaudeCliEnvelope | null, stderr: string): boolean {
  if (envelope && envelope.is_error) {
    const status = envelope.api_error_status ?? 0;
    // 429 rate limit, 529 overloaded, 503 unavailable.
    if (status === 429 || status === 529 || status === 503) return true;
  }
  const lower = stderr.toLowerCase();
  return (
    lower.includes('rate limit') ||
    lower.includes('overloaded') ||
    lower.includes('please try again') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout')
  );
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

function emitTelemetry(
  db: Database,
  subsystem: string,
  detail: Record<string, unknown>,
  isError: boolean,
): void {
  try {
    // Use existing event_kind 'enrichment' for successes, 'error' for failures —
    // both already in the CHECK constraint, no schema bump needed.
    const kind = isError ? 'error' : 'enrichment';
    cachedPrepare(
      db,
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(
      'angel-claude-subprocess',
      kind,
      JSON.stringify({ subsystem: `claude_subprocess/${subsystem}`, ...detail }),
      (detail['latency_ms'] as number) ?? null,
    );
  } catch {
    /* telemetry must never escalate */
  }
}

// ---------------------------------------------------------------------------
// Subprocess invocation (single attempt)
// ---------------------------------------------------------------------------

interface SingleCallOutcome {
  envelope: ClaudeCliEnvelope | null;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  parseError: string | null;
}

async function invokeClaudeOnce(
  opts: ClaudeSubprocessCallOptions,
): Promise<SingleCallOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? DEFAULT_MODEL;
  const spawnFn = opts.spawnFn ?? spawn;

  const args = [
    '--print',
    '--model', model,
    '--output-format', 'json',
    '--tools', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (opts.system) {
    args.push('--system-prompt', opts.system);
  }
  if (opts.appendSystem) {
    args.push('--append-system-prompt', opts.appendSystem);
  }
  if (opts.schema) {
    args.push('--json-schema', JSON.stringify(opts.schema));
  }

  const child: ChildProcess = spawnFn(CLAUDE_CLI, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Critical: child claude must not run claudex hooks. Every claudex
      // hook checks this env var at entry and short-circuits.
      CLAUDEX_GENERATION_CHILD: '1',
      // Disable any color/TTY-shaped output that could break JSON parsing.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

  // Write the user prompt to stdin and close.
  child.stdin?.write(opts.prompt);
  child.stdin?.end();

  // Race process exit vs timeout.
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force-kill after grace period.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 2000);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (timedOut || exitCode === null) {
    return { envelope: null, stderr: stderr || 'timeout', exitCode, timedOut, parseError: null };
  }

  if (exitCode !== 0) {
    return { envelope: null, stderr: stderr || `exit ${exitCode}`, exitCode, timedOut: false, parseError: null };
  }

  // Parse the JSON envelope.
  try {
    const envelope = JSON.parse(stdout.trim()) as ClaudeCliEnvelope;
    return { envelope, stderr, exitCode, timedOut: false, parseError: null };
  } catch (e) {
    return {
      envelope: null,
      stderr,
      exitCode,
      timedOut: false,
      parseError: `JSON parse failed: ${(e as Error).message}. First 200 chars: ${stdout.slice(0, 200)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call Claude Code as a subprocess generation backend.
 *
 * Throws on:
 *   - Subprocess failure after MAX_RETRIES retries
 *   - Timeout after retries exhausted
 *   - JSON envelope parse failure (no retry — malformed output is permanent)
 *   - CLI exit code != 0 with non-transient error
 *
 * Returns rich result with cost, usage, latency. Telemetry row written when
 * `db` is provided. Caller is responsible for catching transient failures
 * if they want to skip-and-retry-next-tick (the heartbeat pattern).
 */
export async function callClaudeSubprocess(
  opts: ClaudeSubprocessCallOptions,
): Promise<ClaudeSubprocessResult> {
  await acquireSlot();
  const start = Date.now();
  let lastErr: Error | null = null;
  let attempts = 0;

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      attempts = attempt;
      const outcome = await invokeClaudeOnce(opts);

      // Success path.
      if (outcome.envelope && !outcome.envelope.is_error) {
        const env = outcome.envelope;
        const content =
          opts.schema && env.structured_output
            ? env.structured_output
            : env.result;

        if (content === undefined || content === null || content === '') {
          throw new Error(
            `Claude subprocess returned empty content (schema=${!!opts.schema}, stop_reason=${env.stop_reason})`,
          );
        }

        const latencyMs = Date.now() - start;
        const result: ClaudeSubprocessResult = {
          content,
          costUsd: env.total_cost_usd ?? 0,
          usage: {
            input: env.usage?.input_tokens ?? 0,
            output: env.usage?.output_tokens ?? 0,
            cacheRead: env.usage?.cache_read_input_tokens ?? 0,
            cacheCreate: env.usage?.cache_creation_input_tokens ?? 0,
          },
          latencyMs,
          model: opts.model ?? DEFAULT_MODEL,
          retried: attempt > 1,
          attempts,
        };

        if (opts.db) {
          emitTelemetry(
            opts.db,
            opts.subsystem ?? 'unspecified',
            {
              model: result.model,
              cost_usd: result.costUsd,
              latency_ms: result.latencyMs,
              input_tokens: result.usage.input,
              output_tokens: result.usage.output,
              cache_read: result.usage.cacheRead,
              attempts: result.attempts,
              retried: result.retried,
            },
            false,
          );
        }

        return result;
      }

      // Failure path — decide retry vs throw.
      const transient = isTransientError(outcome.envelope, outcome.stderr);
      const errMsg =
        outcome.parseError
        ?? (outcome.timedOut ? `timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : outcome.envelope?.is_error
          ? `api_error_status=${outcome.envelope.api_error_status} stop_reason=${outcome.envelope.stop_reason}`
          : outcome.stderr.slice(0, 300) || `exit ${outcome.exitCode}`);
      lastErr = new Error(`Claude subprocess attempt ${attempt} failed: ${errMsg}`);

      if (!transient || attempt === MAX_RETRIES) {
        if (opts.db) {
          emitTelemetry(
            opts.db,
            opts.subsystem ?? 'unspecified',
            {
              model: opts.model ?? DEFAULT_MODEL,
              latency_ms: Date.now() - start,
              attempts,
              error: errMsg.slice(0, 300),
              transient,
            },
            true,
          );
        }
        throw lastErr;
      }

      // Backoff before retry.
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }

    // Unreachable — loop above always returns or throws.
    throw lastErr ?? new Error('Claude subprocess exhausted retries');
  } finally {
    releaseSlot();
  }
}

/**
 * Drop-in replacement for `callLocalLLM` — text-only return for call sites
 * that haven't been migrated to the richer ClaudeSubprocessResult shape.
 */
export async function callClaudeSubprocessText(
  opts: { system?: string; prompt: string; model?: string; timeoutMs?: number; db?: Database; subsystem?: string },
): Promise<string> {
  const result = await callClaudeSubprocess({
    prompt: opts.prompt,
    system: opts.system,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    db: opts.db,
    subsystem: opts.subsystem,
  });
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

/** Test hook — reset semaphore state between tests. */
export function __resetConcurrencyForTest(): void {
  _inflight = 0;
  _waiters.length = 0;
}
