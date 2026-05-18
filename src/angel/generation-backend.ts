/**
 * Generation backend front door.
 *
 * Single entry point for every LLM generation call across Angel + hooks.
 * Routes between two implementations:
 *
 *   - Claude subprocess (default): spawns `claude --print` using MAX OAuth.
 *     High quality, schema-enforced output, no Ollama dependency.
 *   - Ollama OpenAI-compat (revert): the legacy callLocalLLM path against
 *     the local Ollama daemon. Kept behind CLAUDEX_GENERATION_BACKEND=ollama
 *     so any environment without Claude CLI (or any future regression) can
 *     fall back to the prior implementation.
 *
 * Backend selection:
 *   - CLAUDEX_GENERATION_BACKEND=claude  → Claude subprocess (default)
 *   - CLAUDEX_GENERATION_BACKEND=ollama  → Ollama daemon
 *
 * Model conventions:
 *   - 'haiku'  (default): classification + high-throughput workloads
 *                         (CHR, directive extraction, domain classification)
 *   - 'sonnet'           : synthesis workloads (LSS, highlights extraction)
 *   - 'opus'             : reserved for rare deep-reasoning cases
 *
 * Each call site picks its own model. Defaults to haiku.
 */

import type { Database } from 'better-sqlite3';
import { callLocalLLM, type LocalLLMCallOptions } from './llama-client.js';
import {
  callClaudeSubprocess,
  callClaudeSubprocessText,
  type ClaudeSubprocessCallOptions,
  type ClaudeSubprocessResult,
} from './claude-subprocess.js';

export type GenerationBackend = 'claude' | 'ollama';

/**
 * Resolve the active generation backend from env.
 *
 *   - Production default: 'claude' (subprocess via MAX OAuth).
 *   - Vitest default: 'ollama' (so existing vi.mock('llama-client') intercepts
 *     work without per-test backend overrides). Production behavior is
 *     exercised directly via the claude-subprocess.test.ts suite.
 *   - Explicit override always wins: CLAUDEX_GENERATION_BACKEND=ollama|claude.
 */
export function resolveBackend(): GenerationBackend {
  const v = process.env['CLAUDEX_GENERATION_BACKEND'];
  if (v === 'ollama') return 'ollama';
  if (v === 'claude') return 'claude';
  // Vitest sets process.env.VITEST='true' automatically. In that context,
  // route through Ollama by default so the mock-callLocalLLM pattern works.
  if (process.env['VITEST'] === 'true') return 'ollama';
  return 'claude';
}

/**
 * Phase 14-09 (codex review fix): callers pass a model string that's meaningful
 * for the DEFAULT backend (Claude — `haiku`, `sonnet`, `opus`). When the active
 * backend is Ollama, that string is meaningless — Ollama doesn't know `haiku`.
 * Symmetrically, the legacy Ollama tag `glm-5.1:cloud` is meaningless to Claude.
 *
 * Normalize the model to a value valid on the active backend.
 * Returns undefined when the input model isn't recognized for the target
 * backend — caller's downstream client uses its own default.
 */
const CLAUDE_ALIASES = new Set(['haiku', 'sonnet', 'opus']);
const OLLAMA_TAG_RE = /^[a-z0-9._-]+:[a-z0-9._-]+$/i; // e.g. "glm-5.1:cloud", "llama3.1:8b"

function normalizeModelForBackend(
  model: string | undefined,
  backend: GenerationBackend,
): string | undefined {
  if (!model) return undefined;
  if (backend === 'claude') {
    // Pass Claude aliases (haiku/sonnet/opus) and full Anthropic model IDs through.
    // Ollama tags (contain ':') → not valid for Claude, return undefined so the
    // subprocess wrapper uses its DEFAULT_MODEL (haiku).
    if (CLAUDE_ALIASES.has(model)) return model;
    if (model.startsWith('claude-')) return model;
    if (OLLAMA_TAG_RE.test(model)) return undefined; // wrong backend's model
    return model; // unknown shape — let CLI decide
  }
  // backend === 'ollama'
  // Pass Ollama tags (foo:bar) and known local model names through.
  // Claude aliases (haiku/sonnet/opus) → not valid for Ollama, return undefined
  // so callLocalLLM uses its DEFAULT_MODEL (glm-5.1:cloud).
  if (CLAUDE_ALIASES.has(model)) return undefined; // wrong backend's model
  if (model.startsWith('claude-')) return undefined;
  return model;
}

/**
 * Unified generation call — text return.
 *
 * Most existing call sites use the text shape (parse JSON from response
 * themselves via regex/extractFirstJsonObject). Drop-in replacement for
 * callLocalLLM with backend routing under the hood.
 *
 * `model` accepts both Anthropic aliases (haiku/sonnet/opus) and Ollama
 * model tags (glm-5.1:cloud, etc.). The active backend interprets it.
 *
 * Throws on backend failure. Caller catches and treats as transient (the
 * heartbeat skip-this-tick-retry-next pattern).
 */
export async function generate(opts: {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  db?: Database;
  subsystem?: string;
}): Promise<string> {
  const backend = resolveBackend();

  if (backend === 'claude') {
    return callClaudeSubprocessText({
      prompt: opts.prompt,
      system: opts.system,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      db: opts.db,
      subsystem: opts.subsystem,
    });
  }

  // Ollama path: existing OpenAI-compat call.
  const ollamaOpts: LocalLLMCallOptions = {
    prompt: opts.prompt,
    system: opts.system,
    model: opts.model,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
    temperature: opts.temperature,
  };
  return callLocalLLM(ollamaOpts);
}

/**
 * Unified generation call — rich return with cost + usage + structured output.
 *
 * For call sites that need schema-validated JSON, cost tracking, or detailed
 * telemetry. Falls back to wrapping the text-mode Ollama call in a synthetic
 * result if backend=ollama (cost=0, usage=zeros).
 */
export async function generateRich(
  opts: ClaudeSubprocessCallOptions,
): Promise<ClaudeSubprocessResult> {
  const backend = resolveBackend();

  if (backend === 'claude') {
    return callClaudeSubprocess(opts);
  }

  // Ollama fallback — synthesize a minimal rich result. No cost, no usage
  // breakdown, just the text. Schema validation is caller's responsibility
  // because Ollama doesn't enforce JSON schemas server-side.
  const start = Date.now();
  const text = await callLocalLLM({
    prompt: opts.prompt,
    system: opts.system,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    temperature: opts.temperature,
  });

  let content: string | Record<string, unknown> = text;
  if (opts.schema) {
    // Attempt to parse — caller relies on the schema-validated shape.
    try {
      content = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Caller will see the raw text and decide how to handle it.
      content = text;
    }
  }

  return {
    content,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    latencyMs: Date.now() - start,
    model: opts.model ?? 'ollama',
    retried: false,
    attempts: 1,
  };
}
