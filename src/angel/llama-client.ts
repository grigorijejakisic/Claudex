/**
 * LLM client — single source of truth for Angel's generation calls.
 *
 * All Angel subsystems that need LLM completions (pattern extraction,
 * curated-context extraction, entity summarization, observation
 * consolidation, health reports) go through this module.
 *
 * Default backend: the local Ollama daemon at 127.0.0.1:11434, which
 * transparently proxies `:cloud` model tags (e.g. `glm-5.1:cloud`) to
 * ollama.com using the SSH key registered via `ollama signin`. Angel sees
 * a plain OpenAI-compat endpoint; the daemon handles auth and cloud
 * forwarding. No API key env var is required.
 *
 * Overridable via env:
 *   - OLLAMA_BASE_URL   — default http://127.0.0.1:11434
 *   - OLLAMA_GEN_MODEL  — default glm-5.1:cloud
 *
 * Non-throwing at the call site is the caller's responsibility — this
 * module throws on network/HTTP error so callers can distinguish transient
 * failures (retry next tick) from malformed output (skip, mark processed).
 */

// ---------------------------------------------------------------------------
// Usage tracking — allows the supervisor to know when the last LLM call
// happened. In cloud mode the supervisor is a no-op, but the callback is
// kept so local-llama-server setups still work for offline dev.
// ---------------------------------------------------------------------------

let _onUsed: (() => void) | null = null;

/**
 * Register a callback that fires after every successful callLocalLLM().
 * Pass null to unregister.
 */
export function registerLlamaUsageCallback(cb: (() => void) | null): void {
  _onUsed = cb;
}

/** Base URL of the backing OpenAI-compat endpoint. */
const BASE_URL = (process.env['OLLAMA_BASE_URL'] ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');

/** Default endpoint — Ollama daemon's OpenAI-compat chat path. */
export const LLAMA_SERVER_URL = `${BASE_URL}/v1/chat/completions`;

/** Default model tag. A `:cloud` suffix routes via the local daemon to Ollama Cloud. */
export const LLAMA_MODEL_ALIAS = process.env['OLLAMA_GEN_MODEL'] ?? 'glm-5.1:cloud';

/** Health-check endpoint — Ollama daemon version probe (cheap, no model load). */
export const LLAMA_HEALTH_URL = `${BASE_URL}/api/version`;

/** True when the resolved model tag routes to Ollama Cloud. */
export function isCloudModel(model?: string): boolean {
  return (model ?? LLAMA_MODEL_ALIAS).endsWith(':cloud');
}

export interface LocalLLMCallOptions {
  /** System prompt (OpenAI "system" role). */
  system?: string;
  /** User prompt (OpenAI "user" role). */
  prompt: string;
  /** Model tag. Default: glm-5.1:cloud (or OLLAMA_GEN_MODEL). */
  model?: string;
  /** Sampling temperature. Default: 0 (deterministic for extraction tasks). */
  temperature?: number;
  /**
   * Max completion tokens. Default: 1024.
   *
   * GLM 5.1 and similar reasoning models have a thinking mode that counts
   * against max_tokens. We disable it by default via reasoning_effort=none
   * (see the request body below) so 1024 tokens is plenty for Angel's
   * structured extraction prompts. Callers that need thinking on can set
   * `enableThinking: true` and bump this accordingly.
   */
  maxTokens?: number;
  /**
   * Request timeout in ms. Default: 120_000 (2 min).
   *
   * Cloud latency is typically 2-10s for short completions; 2 minutes is a
   * comfortable upper bound that still fails fast on stalls.
   */
  timeoutMs?: number;
  /**
   * Enable the model's thinking/reasoning mode. Default: false.
   * When false, we pass reasoning_effort=none so the model emits clean
   * `content` without burning max_tokens on reasoning traces.
   */
  enableThinking?: boolean;
  /** Override endpoint URL (used by tests). */
  url?: string;
  /** Injected fetch (used by tests). */
  fetchFn?: typeof fetch;
}

/**
 * Call the generation backend via OpenAI-compatible /v1/chat/completions.
 *
 * Returns the assistant message content (trimmed). Throws on:
 *   - Network failure (fetch rejects)
 *   - Non-2xx HTTP status
 *   - Timeout (AbortSignal.timeout)
 *   - Malformed response shape
 *
 * Callers should catch and treat errors as transient — the typical response
 * is to skip this tick and retry next heartbeat (the extractor pattern).
 */
export async function callLocalLLM(opts: LocalLLMCallOptions): Promise<string> {
  const url = opts.url ?? LLAMA_SERVER_URL;
  const fetchFn = opts.fetchFn ?? fetch;
  const model = opts.model ?? LLAMA_MODEL_ALIAS;
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const enableThinking = opts.enableThinking ?? false;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (!enableThinking) {
    // Ollama's OpenAI-compat layer honors reasoning_effort=none to suppress
    // the thinking trace for GLM 5.1, DeepSeek V3.2, Kimi K2.5, etc.
    body['reasoning_effort'] = 'none';
  }

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`generation backend ${resp.status}: ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
  };

  const msg = data.choices?.[0]?.message;
  // Some models return thinking in `reasoning` and final in `content`. We
  // only care about `content` — reasoning traces are discarded.
  const content = msg?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('generation backend response missing choices[0].message.content');
  }

  _onUsed?.();
  return content.trim();
}

/**
 * Probe the Ollama daemon `/api/version` endpoint. Returns true if the daemon
 * is reachable. Used by the supervisor's health check and by the heartbeat's
 * service-status reporter.
 *
 * Non-throwing — returns false on any error.
 */
export async function checkLlamaServerHealth(opts?: {
  url?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const url = opts?.url ?? LLAMA_HEALTH_URL;
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const fetchFn = opts?.fetchFn ?? fetch;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return false;
    const data = (await resp.json()) as { version?: string; data?: unknown[] };
    // /api/version returns { "version": "0.x.y" }.
    // Legacy llama-server /v1/models returns { data: [...] }. Accept both.
    return typeof data.version === 'string' || (Array.isArray(data.data) && data.data.length > 0);
  } catch {
    return false;
  }
}
