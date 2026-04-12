/**
 * Local LLM client — single source of truth for Angel's generation calls.
 *
 * All Angel subsystems that need LLM completions (pattern extraction,
 * curated-context extraction, entity summarization, observation
 * consolidation, health reports) go through this module.
 *
 * Target: llama-server.exe (llama.cpp's OpenAI-compatible server) running
 * Gemma 4 31B IT Q6_K on GPU at 127.0.0.1:8081. Supervised by
 * LlamaServerSupervisor — Angel auto-launches the server at startup.
 *
 * Replaces the prior CliProxy → Ollama cloud → Ollama local cascade. One
 * local model, one endpoint, no cloud dependency, no MAX subscription
 * coupling for Angel's background work.
 *
 * Non-throwing at the call site is the caller's responsibility — this
 * module throws on network/HTTP error so callers can distinguish transient
 * failures (retry next tick) from malformed output (skip, mark processed).
 */

// ---------------------------------------------------------------------------
// Usage tracking — allows the supervisor to know when the last LLM call
// happened so it can idle-shutdown the server when nothing needs it.
// ---------------------------------------------------------------------------

let _onUsed: (() => void) | null = null;

/**
 * Register a callback that fires after every successful callLocalLLM().
 * The LlamaServerSupervisor calls this at boot to wire its markUsed().
 * Pass null to unregister.
 */
export function registerLlamaUsageCallback(cb: (() => void) | null): void {
  _onUsed = cb;
}

/** Default endpoint — matches run-gemma.sh. */
export const LLAMA_SERVER_URL = 'http://127.0.0.1:8081/v1/chat/completions';

/** Default model alias used by run-gemma.sh (--alias gemma4). */
export const LLAMA_MODEL_ALIAS = 'gemma4';

/**
 * Health-check endpoint. llama-server exposes OpenAI-compat /v1/models
 * which returns 200 OK with a JSON body listing loaded models once the
 * model is fully loaded into VRAM.
 */
export const LLAMA_HEALTH_URL = 'http://127.0.0.1:8081/v1/models';

export interface LocalLLMCallOptions {
  /** System prompt (OpenAI "system" role). */
  system?: string;
  /** User prompt (OpenAI "user" role). */
  prompt: string;
  /** Model alias. Default: "gemma4" (from run-gemma.sh). */
  model?: string;
  /** Sampling temperature. Default: 0 (deterministic for extraction tasks). */
  temperature?: number;
  /**
   * Max completion tokens. Default: 4096.
   *
   * Gemma 4 has a reasoning mode — `reasoning_content` is emitted alongside
   * `content` but STILL COUNTS against max_tokens. Empirically, Gemma spends
   * 60-80% of budget on reasoning tokens before producing content. A 2048
   * budget truncates realistic extraction responses mid-JSON. 4096 gives a
   * comfortable margin. Callers needing very short outputs (<256 tokens of
   * actual content) should still request at least 512 to leave room for
   * reasoning overhead.
   */
  maxTokens?: number;
  /**
   * Request timeout in ms. Default: 600_000 (10 min).
   *
   * Gemma 4 31B Q6_K runs at ~6-9 tok/s on RTX 5090. A 4096-token response
   * worst-case is ~11 minutes. 600s matches this realistic ceiling. Shorter
   * timeouts caused false-positive failures during Path B verification.
   */
  timeoutMs?: number;
  /** Override endpoint URL (used by tests). */
  url?: string;
  /** Injected fetch (used by tests). */
  fetchFn?: typeof fetch;
}

/**
 * Call the local Gemma server via OpenAI-compatible /v1/chat/completions.
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
  const maxTokens = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`llama-server ${resp.status}: ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('llama-server response missing choices[0].message.content');
  }

  _onUsed?.();
  return content.trim();
}

/**
 * Probe the llama-server /v1/models endpoint. Returns true if the server is
 * reachable and has at least one model loaded. Used by the supervisor's
 * health check and by the heartbeat's service-status reporter.
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
    // llama-server returns { object: "list", data: [{...}] } when ready.
    const data = (await resp.json()) as { data?: unknown[] };
    return Array.isArray(data.data) && data.data.length > 0;
  } catch {
    return false;
  }
}
