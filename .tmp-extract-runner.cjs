"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/sqlite-vec/index.cjs
var require_sqlite_vec = __commonJS({
  "node_modules/sqlite-vec/index.cjs"(exports2, module2) {
    var { arch, platform } = require("node:process");
    var BASE_PACKAGE_NAME = "sqlite-vec";
    var ENTRYPOINT_BASE_NAME = "vec0";
    var supportedPlatforms = [["darwin", "x64"], ["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"], ["linux", "arm64"]];
    var invalidPlatformErrorMessage = `Unsupported platform for ${BASE_PACKAGE_NAME}, on a ${platform}-${arch} machine. Supported platforms are (${supportedPlatforms.map(([p, a]) => `${p}-${a}`).join(",")}). Consult the ${BASE_PACKAGE_NAME} NPM package README for details.`;
    function validPlatform(platform2, arch2) {
      return supportedPlatforms.find(([p, a]) => platform2 === p && arch2 === a) !== void 0;
    }
    function extensionSuffix(platform2) {
      if (platform2 === "win32") return "dll";
      if (platform2 === "darwin") return "dylib";
      return "so";
    }
    function platformPackageName(platform2, arch2) {
      const os = platform2 === "win32" ? "windows" : platform2;
      return `${BASE_PACKAGE_NAME}-${os}-${arch2}`;
    }
    function getLoadablePath() {
      if (!validPlatform(platform, arch)) {
        throw new Error(
          invalidPlatformErrorMessage
        );
      }
      const packageName = platformPackageName(platform, arch);
      const loadablePath = require.resolve(packageName + "/" + ENTRYPOINT_BASE_NAME + "." + extensionSuffix(platform));
      return loadablePath;
    }
    function load(db) {
      db.loadExtension(getLoadablePath());
    }
    module2.exports = { getLoadablePath, load };
  }
});

// src/core/sqlite-vec-loader.ts
function loadSqliteVec(db) {
  try {
    const sqliteVec = require_sqlite_vec();
    sqliteVec.load(db);
    const row = db.prepare("SELECT vec_version() AS v").get();
    if (!row?.v) {
      if (!loadAttempted) {
        loadErrorMessage = "vec_version() returned null after load";
        loadAttempted = true;
      }
      return false;
    }
    loadAttempted = true;
    loadSucceeded = true;
    loadErrorMessage = null;
    return true;
  } catch (err) {
    if (!loadAttempted) {
      loadErrorMessage = err instanceof Error ? err.message : String(err);
      loadAttempted = true;
      loadSucceeded = false;
      process.stderr.write(
        `[sqlite-vec] failed to load: ${loadErrorMessage} \u2014 vec0 tables unavailable, falling back to Qdrant
`
      );
    }
    return false;
  }
}
function encodeVector(embedding) {
  const f32 = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
var loadAttempted, loadSucceeded, loadErrorMessage;
var init_sqlite_vec_loader = __esm({
  "src/core/sqlite-vec-loader.ts"() {
    "use strict";
    loadAttempted = false;
    loadSucceeded = false;
    loadErrorMessage = null;
  }
});

// src/embeddings/sqlite-vec-backend.ts
var init_sqlite_vec_backend = __esm({
  "src/embeddings/sqlite-vec-backend.ts"() {
    "use strict";
    init_sqlite_vec_loader();
  }
});

// src/embeddings/qdrant-client.ts
var init_qdrant_client = __esm({
  "src/embeddings/qdrant-client.ts"() {
    "use strict";
    init_sqlite_vec_backend();
    init_sqlite_vec_backend();
  }
});

// .tmp-extract-entry.mjs
var tmp_extract_entry_exports = {};
__export(tmp_extract_entry_exports, {
  extractDirectivesFromSession: () => extractDirectivesFromSession,
  runMigrations: () => runMigrations
});
module.exports = __toCommonJS(tmp_extract_entry_exports);

// src/intelligence/directive-detector.ts
var fs = __toESM(require("node:fs"), 1);
var path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");

// src/angel/llama-client.ts
var _onUsed = null;
var BASE_URL = (process.env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
var LLAMA_SERVER_URL = `${BASE_URL}/v1/chat/completions`;
var LLAMA_MODEL_ALIAS = process.env["OLLAMA_GEN_MODEL"] ?? "glm-5.1:cloud";
var LLAMA_HEALTH_URL = `${BASE_URL}/api/version`;
async function callLocalLLM(opts) {
  const url = opts.url ?? LLAMA_SERVER_URL;
  const fetchFn = opts.fetchFn ?? fetch;
  const model = opts.model ?? LLAMA_MODEL_ALIAS;
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 12e4;
  const enableThinking = opts.enableThinking ?? false;
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens
  };
  if (!enableThinking) {
    body["reasoning_effort"] = "none";
  }
  const resp = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) {
    throw new Error(`generation backend ${resp.status}: ${resp.statusText}`);
  }
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("generation backend response missing choices[0].message.content");
  }
  _onUsed?.();
  return content.trim();
}

// src/angel/claude-subprocess.ts
var import_node_child_process = require("node:child_process");

// src/core/stmt-cache.ts
var MAX_CACHE_SIZE = 256;
var stmtCache = /* @__PURE__ */ new WeakMap();
function cachedPrepare(db, sql) {
  let map = stmtCache.get(db);
  if (!map) {
    map = /* @__PURE__ */ new Map();
    stmtCache.set(db, map);
  }
  let stmt = map.get(sql);
  if (stmt) {
    map.delete(sql);
    map.set(sql, stmt);
    return stmt;
  }
  if (map.size >= MAX_CACHE_SIZE) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  stmt = db.prepare(sql);
  map.set(sql, stmt);
  return stmt;
}

// src/angel/claude-subprocess.ts
var MAX_CONCURRENT_CALLS = 4;
var DEFAULT_TIMEOUT_MS = 9e4;
var DEFAULT_MODEL = "haiku";
var MAX_RETRIES = 3;
var BASE_BACKOFF_MS = 1500;
var CLAUDE_CLI = process.env["CLAUDE_CLI_PATH"] ?? "claude";
var _inflight = 0;
var _waiters = [];
async function acquireSlot() {
  if (_inflight < MAX_CONCURRENT_CALLS) {
    _inflight++;
    return;
  }
  await new Promise((resolve) => _waiters.push(resolve));
  _inflight++;
}
function releaseSlot() {
  _inflight--;
  const next = _waiters.shift();
  if (next) next();
}
function isTransientError(envelope, stderr) {
  if (envelope && envelope.is_error) {
    const status = envelope.api_error_status ?? 0;
    if (status === 429 || status === 529 || status === 503) return true;
  }
  const lower = stderr.toLowerCase();
  return lower.includes("rate limit") || lower.includes("overloaded") || lower.includes("please try again") || lower.includes("econnreset") || lower.includes("etimedout");
}
function emitTelemetry(db, subsystem, detail, isError) {
  try {
    const kind = isError ? "error" : "enrichment";
    cachedPrepare(
      db,
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms)
       VALUES (?, ?, ?, ?)`
    ).run(
      "angel-claude-subprocess",
      kind,
      JSON.stringify({ subsystem: `claude_subprocess/${subsystem}`, ...detail }),
      detail["latency_ms"] ?? null
    );
  } catch {
  }
}
async function invokeClaudeOnce(opts) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? DEFAULT_MODEL;
  const spawnFn = opts.spawnFn ?? import_node_child_process.spawn;
  const args = [
    "--print",
    "--model",
    model,
    "--output-format",
    "json",
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence"
  ];
  if (opts.system) {
    args.push("--system-prompt", opts.system);
  }
  if (opts.appendSystem) {
    args.push("--append-system-prompt", opts.appendSystem);
  }
  if (opts.schema) {
    args.push("--json-schema", JSON.stringify(opts.schema));
  }
  const child = spawnFn(CLAUDE_CLI, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Critical: child claude must not run claudex hooks. Every claudex
      // hook checks this env var at entry and short-circuits.
      CLAUDEX_GENERATION_CHILD: "1",
      // Disable any color/TTY-shaped output that could break JSON parsing.
      NO_COLOR: "1",
      FORCE_COLOR: "0"
    }
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  child.stdin?.write(opts.prompt);
  child.stdin?.end();
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, 2e3);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (timedOut || exitCode === null) {
    return { envelope: null, stderr: stderr || "timeout", exitCode, timedOut, parseError: null };
  }
  if (exitCode !== 0) {
    return { envelope: null, stderr: stderr || `exit ${exitCode}`, exitCode, timedOut: false, parseError: null };
  }
  try {
    const envelope = JSON.parse(stdout.trim());
    return { envelope, stderr, exitCode, timedOut: false, parseError: null };
  } catch (e) {
    return {
      envelope: null,
      stderr,
      exitCode,
      timedOut: false,
      parseError: `JSON parse failed: ${e.message}. First 200 chars: ${stdout.slice(0, 200)}`
    };
  }
}
async function callClaudeSubprocess(opts) {
  await acquireSlot();
  const start = Date.now();
  let lastErr = null;
  let attempts = 0;
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      attempts = attempt;
      const outcome = await invokeClaudeOnce(opts);
      if (outcome.envelope && !outcome.envelope.is_error) {
        const env = outcome.envelope;
        const content = opts.schema && env.structured_output ? env.structured_output : env.result;
        if (content === void 0 || content === null || content === "") {
          throw new Error(
            `Claude subprocess returned empty content (schema=${!!opts.schema}, stop_reason=${env.stop_reason})`
          );
        }
        const latencyMs = Date.now() - start;
        const result = {
          content,
          costUsd: env.total_cost_usd ?? 0,
          usage: {
            input: env.usage?.input_tokens ?? 0,
            output: env.usage?.output_tokens ?? 0,
            cacheRead: env.usage?.cache_read_input_tokens ?? 0,
            cacheCreate: env.usage?.cache_creation_input_tokens ?? 0
          },
          latencyMs,
          model: opts.model ?? DEFAULT_MODEL,
          retried: attempt > 1,
          attempts
        };
        if (opts.db) {
          emitTelemetry(
            opts.db,
            opts.subsystem ?? "unspecified",
            {
              model: result.model,
              cost_usd: result.costUsd,
              latency_ms: result.latencyMs,
              input_tokens: result.usage.input,
              output_tokens: result.usage.output,
              cache_read: result.usage.cacheRead,
              attempts: result.attempts,
              retried: result.retried
            },
            false
          );
        }
        return result;
      }
      const transient = isTransientError(outcome.envelope, outcome.stderr);
      const errMsg = outcome.parseError ?? (outcome.timedOut ? `timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : outcome.envelope?.is_error ? `api_error_status=${outcome.envelope.api_error_status} stop_reason=${outcome.envelope.stop_reason}` : outcome.stderr.slice(0, 300) || `exit ${outcome.exitCode}`);
      lastErr = new Error(`Claude subprocess attempt ${attempt} failed: ${errMsg}`);
      if (!transient || attempt === MAX_RETRIES) {
        if (opts.db) {
          emitTelemetry(
            opts.db,
            opts.subsystem ?? "unspecified",
            {
              model: opts.model ?? DEFAULT_MODEL,
              latency_ms: Date.now() - start,
              attempts,
              error: errMsg.slice(0, 300),
              transient
            },
            true
          );
        }
        throw lastErr;
      }
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastErr ?? new Error("Claude subprocess exhausted retries");
  } finally {
    releaseSlot();
  }
}
async function callClaudeSubprocessText(opts) {
  const result = await callClaudeSubprocess({
    prompt: opts.prompt,
    system: opts.system,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    db: opts.db,
    subsystem: opts.subsystem
  });
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

// src/angel/generation-backend.ts
function resolveBackend() {
  const v = process.env["CLAUDEX_GENERATION_BACKEND"];
  if (v === "ollama") return "ollama";
  if (v === "claude") return "claude";
  if (process.env["VITEST"] === "true") return "ollama";
  return "claude";
}
var CLAUDE_ALIASES = /* @__PURE__ */ new Set(["haiku", "sonnet", "opus"]);
var OLLAMA_TAG_RE = /^[a-z0-9._-]+:[a-z0-9._-]+$/i;
function normalizeModelForBackend(model, backend) {
  if (!model) return void 0;
  if (backend === "claude") {
    if (CLAUDE_ALIASES.has(model)) return model;
    if (model.startsWith("claude-")) return model;
    if (OLLAMA_TAG_RE.test(model)) return void 0;
    return model;
  }
  if (CLAUDE_ALIASES.has(model)) return void 0;
  if (model.startsWith("claude-")) return void 0;
  return model;
}
async function generate(opts) {
  const backend = resolveBackend();
  const normalizedModel = normalizeModelForBackend(opts.model, backend);
  if (backend === "claude") {
    return callClaudeSubprocessText({
      prompt: opts.prompt,
      system: opts.system,
      model: normalizedModel,
      timeoutMs: opts.timeoutMs,
      db: opts.db,
      subsystem: opts.subsystem
    });
  }
  const ollamaOpts = {
    prompt: opts.prompt,
    system: opts.system,
    model: normalizedModel,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
    temperature: opts.temperature
  };
  return callLocalLLM(ollamaOpts);
}

// src/shared/fetch-utils.ts
var MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
async function fetchJsonWithTimeout(url, options = {}) {
  const { timeoutMs = 5e3, maxResponseBytes = MAX_RESPONSE_BYTES, ...fetchOpts } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const callerSignal = fetchOpts.signal;
  let composedSignal;
  if (callerSignal) {
    if (typeof AbortSignal.any === "function") {
      composedSignal = AbortSignal.any([callerSignal, controller.signal]);
    } else {
      composedSignal = controller.signal;
      if (!callerSignal.aborted) {
        callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
      } else {
        controller.abort();
      }
    }
  } else {
    composedSignal = controller.signal;
  }
  try {
    const resp = await fetch(url, { ...fetchOpts, signal: composedSignal });
    if (!resp.ok) {
      clearTimeout(timeout);
      return null;
    }
    const contentLength = resp.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
      clearTimeout(timeout);
      return null;
    }
    const text = await resp.text();
    clearTimeout(timeout);
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
      return null;
    }
    return JSON.parse(text);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// src/shared/network-safety.ts
function isPrivateIPv4(a, b) {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}

// src/embeddings/embedding-provider.ts
function isLocalOrPrivateUrl(urlStr, opts) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;
    if (hostname === "localhost") return true;
    if (hostname === "127.0.0.1") return true;
    if (hostname === "::1") return true;
    if (hostname === "0.0.0.0") return true;
    if (hostname === "[::1]") return true;
    if (opts?.allowPrivateLan) {
      const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipv4Match) {
        const [, a, b] = ipv4Match.map(Number);
        if (isPrivateIPv4(a, b)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
var EmbeddingProvider = class {
  baseUrl;
  model;
  available;
  // null = not yet checked
  urlBlocked;
  // immutable after construction
  constructor(config) {
    this.baseUrl = config?.baseUrl ?? "http://localhost:11434";
    this.model = config?.model ?? "snowflake-arctic-embed2";
    this.available = null;
    this.urlBlocked = false;
    if (!isLocalOrPrivateUrl(this.baseUrl)) {
      console.warn(`[claudex] EmbeddingProvider: baseUrl "${this.baseUrl}" is not a local/private address. Network calls will be skipped.`);
      this.available = false;
      this.urlBlocked = true;
    }
  }
  /**
   * Health check: verifies Ollama is running and has the target model.
   * Caches result (avoids re-checking every call).
   * Returns false on any error. Non-throwing.
   */
  async isAvailable() {
    try {
      if (this.available !== null) return this.available;
      const data = await fetchJsonWithTimeout(`${this.baseUrl}/api/tags`, {
        timeoutMs: 3e3
      });
      if (!data) {
        this.available = false;
        return false;
      }
      const models = data.models ?? [];
      this.available = models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`)
      );
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }
  /**
   * Compute embedding for text via Ollama /api/embed.
   * Returns null when unavailable or on any error. Non-throwing.
   */
  async embed(text) {
    try {
      if (this.available === false) return null;
      if (this.available === null) {
        const ok = await this.isAvailable();
        if (!ok) return null;
      }
      const data = await fetchJsonWithTimeout(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
        timeoutMs: 5e3
      });
      if (!data) return null;
      const embeddings = data.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length === 0) return null;
      const first = embeddings[0];
      if (!Array.isArray(first) || !first.every((v) => typeof v === "number")) return null;
      return first;
    } catch {
      return null;
    }
  }
  /**
   * Compute embeddings for multiple texts in a single Ollama /api/embed call.
   * Ollama supports `input: string[]` returning `embeddings: number[][]`.
   * Returns array of same length as input — null for any position that fails.
   * Returns all-null array when unavailable or on error. Non-throwing.
   */
  async embedBatch(texts) {
    try {
      if (texts.length === 0) return [];
      if (texts.length === 1) {
        const result = await this.embed(texts[0]);
        return [result];
      }
      if (this.available === false) return texts.map(() => null);
      if (this.available === null) {
        const ok = await this.isAvailable();
        if (!ok) return texts.map(() => null);
      }
      const timeoutMs = Math.min(5e3 + (texts.length - 1) * 1e3, 3e4);
      const data = await fetchJsonWithTimeout(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        timeoutMs
      });
      if (!data) return texts.map(() => null);
      const embeddings = data.embeddings;
      if (!Array.isArray(embeddings)) return texts.map(() => null);
      return texts.map((_, i) => {
        const emb = embeddings[i];
        if (!Array.isArray(emb) || emb.length === 0) return null;
        if (!emb.every((v) => typeof v === "number")) return null;
        return emb;
      });
    } catch {
      return texts.map(() => null);
    }
  }
  /**
   * Clear cached availability for re-check (testing or reconnect).
   * Does not reset URL-blocked providers — external URLs remain blocked.
   */
  resetAvailability() {
    if (!this.urlBlocked) {
      this.available = null;
    }
  }
};

// src/embeddings/embed-pipeline.ts
init_qdrant_client();
var _provider = null;
var _providerChecked = false;
var _providerCheckTime = 0;
var PROVIDER_RECHECK_MS = 6e4;
async function getEmbeddingProvider(config) {
  try {
    if (_providerChecked && _provider === null) {
      if (Date.now() - _providerCheckTime < PROVIDER_RECHECK_MS) return null;
      _providerChecked = false;
    }
    if (!_provider) {
      _provider = new EmbeddingProvider({
        baseUrl: config?.baseUrl ?? "http://localhost:11434",
        model: config?.model ?? "snowflake-arctic-embed2"
      });
    }
    if (!_providerChecked) {
      const ok = await _provider.isAvailable();
      _providerChecked = true;
      _providerCheckTime = Date.now();
      if (!ok) {
        _provider = null;
        return null;
      }
    }
    return _provider;
  } catch {
    _providerChecked = true;
    _providerCheckTime = Date.now();
    _provider = null;
    return null;
  }
}
var MAX_INPUT_CHARS = 8e3;
async function embedText(text, config) {
  try {
    const provider = await getEmbeddingProvider(config);
    if (!provider) return null;
    const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
    const raw = await provider.embed(truncated);
    if (!raw) return null;
    return raw;
  } catch {
    return null;
  }
}

// src/intelligence/directive-detector.ts
init_sqlite_vec_loader();

// src/intelligence/directive-detector-regex.ts
var DIRECTIVE_REGEX_FAMILIES = [
  { name: "remember_this_that_to", re: /\bremember\s+(this|that|to)\b/i },
  { name: "remember_colon", re: /\bremember:/i },
  { name: "always_emphasis", re: /\balways\b/i },
  { name: "never_emphasis", re: /\bnever\b/i },
  { name: "from_now_on", re: /\bfrom now on\b/i },
  { name: "next_time", re: /\bnext time\b/i },
  { name: "in_the_future", re: /\bin the future\b/i },
  { name: "polite_imperative", re: /\bplease\s+(do|don't|stop|always|never)\b/i },
  { name: "stop_doing_using", re: /\bstop\s+(doing|using)\b/i },
  { name: "negation_dont", re: /\b(don't|do not)\b/i },
  { name: "do_x_instead", re: /\bdo\s+[^.!?\n]+?\s+instead\b/i },
  { name: "use_x_instead", re: /\buse\s+[^.!?\n]+?\s+instead\b/i }
];
var FENCED_BLOCK_RE = /```[\s\S]*?```/g;
var INLINE_BACKTICK_RE = /`[^`\n]*`/g;
var SYSTEM_TAG_NAMES = [
  "system-reminder",
  "task-notification",
  "teammate-message",
  "command-name",
  "command-args",
  "command-message"
];
var SYSTEM_TAG_RE = new RegExp(
  `<(${SYSTEM_TAG_NAMES.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,
  "gi"
);
function stripCodeBlocks(text) {
  if (!text) return "";
  return text.replace(FENCED_BLOCK_RE, "").replace(INLINE_BACKTICK_RE, "").replace(SYSTEM_TAG_RE, "");
}
function matchFamilies(stripped) {
  if (!stripped) return [];
  const hits = [];
  for (const fam of DIRECTIVE_REGEX_FAMILIES) {
    if (fam.re.test(stripped)) hits.push(fam.name);
  }
  return hits;
}

// src/intelligence/directive-detector-config.ts
var DEFAULT_CONFIG = {
  thresholdGeneral: 0.7,
  thresholdUniversal: 0.85,
  dedupCosineThreshold: 0.8,
  reinforcementCap: 50,
  // Default model for directive detection. Routes through generation-backend:
  // - Claude subprocess default (haiku — fast classification at production quality)
  // - Ollama revert via CLAUDEX_GENERATION_BACKEND=ollama uses this string literally
  model: "haiku",
  dryRun: false
};
function loadConfig(overrides) {
  return { ...DEFAULT_CONFIG, ...overrides ?? {} };
}

// src/intelligence/directive-detector.ts
var import_meta = {};
var DEDUP_RELATION_SYSTEM_PROMPT_INLINE = `You classify the relation between a candidate directive and an existing directive_rule.

Given CANDIDATE and CANDIDATES_EXISTING[] (ordered by cosine desc), pick ONE relation for the FIRST existing item:
- "restatement": same rule, same polarity, same scope \u2014 just reworded.
- "opposite_polarity": same rule target, FLIPPED polarity (one prescribes, the other prohibits).
- "related_but_distinct": talks about the same topic but states a different rule.
- "unrelated": different topic; cosine was a false positive.

Output JSON only: { "relation": "restatement"|"opposite_polarity"|"related_but_distinct"|"unrelated", "reasoning": string }.`;
var _cachedPromptAssets = null;
function resolvePromptsDir() {
  try {
    const here = path.dirname((0, import_node_url.fileURLToPath)(import_meta.url));
    const candidate = path.join(here, "directive-detector-prompts");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
  }
  try {
    const dn = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    let cur = dn;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(cur, "src", "intelligence", "directive-detector-prompts");
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
  }
  return path.join(process.cwd(), "src", "intelligence", "directive-detector-prompts");
}
function loadPromptAssets(reload = false) {
  if (_cachedPromptAssets && !reload && !process.env["DIRECTIVE_DETECTOR_RELOAD_PROMPTS"]) {
    return _cachedPromptAssets;
  }
  try {
    const dir = resolvePromptsDir();
    const confirmSysRaw = fs.readFileSync(path.join(dir, "confirmation-system-prompt.md"), "utf8");
    const scopeSysRaw = fs.readFileSync(path.join(dir, "scope-rubric-system-prompt.md"), "utf8");
    const confirmFew = JSON.parse(fs.readFileSync(path.join(dir, "confirmation-few-shot.json"), "utf8"));
    const scopeFew = JSON.parse(fs.readFileSync(path.join(dir, "scope-rubric-few-shot.json"), "utf8"));
    _cachedPromptAssets = {
      confirmationSystem: confirmSysRaw.replace("{{FEW_SHOT}}", JSON.stringify(confirmFew.examples ?? [], null, 2)),
      dedupRelationSystem: DEDUP_RELATION_SYSTEM_PROMPT_INLINE,
      scopeRubricSystem: scopeSysRaw.replace("{{FEW_SHOT}}", JSON.stringify(scopeFew.examples ?? [], null, 2))
    };
    return _cachedPromptAssets;
  } catch {
    _cachedPromptAssets = {
      confirmationSystem: FALLBACK_CONFIRMATION_PROMPT,
      dedupRelationSystem: DEDUP_RELATION_SYSTEM_PROMPT_INLINE,
      scopeRubricSystem: FALLBACK_SCOPE_RUBRIC_PROMPT
    };
    return _cachedPromptAssets;
  }
}
var FALLBACK_CONFIRMATION_PROMPT = `You detect user directives. A directive is a standing rule. Output JSON only: { "is_directive": bool, "confidence": number, "polarity": "prescriptive"|"prohibitive"|null, "scope": "session"|"project"|"universal"|null, "suggested_title": string|null, "normalized_text": string|null, "reasoning": string }.`;
var FALLBACK_SCOPE_RUBRIC_PROMPT = `Classify the scope. Output JSON: { "scope": "session"|"project"|"universal", "rationale": string }.`;
function l2DistanceToCosine(d) {
  return 1 - d * d / 2;
}
function shouldReject(c, cfg) {
  if (!c.is_directive) return "reject_is_directive";
  if (c.confidence < cfg.thresholdGeneral) return "reject_threshold";
  if (c.scope === "universal" && c.confidence < cfg.thresholdUniversal) {
    return "reject_threshold";
  }
  return "accept";
}
function extractFirstJsonObject(raw) {
  if (!raw) return null;
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(raw.substring(start, end + 1));
  } catch {
    return null;
  }
}
function parseConfirmation(raw) {
  const obj = extractFirstJsonObject(raw);
  if (!obj) return null;
  if (typeof obj.is_directive !== "boolean") return null;
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) return null;
  const polarity = obj.polarity;
  const scope = obj.scope;
  const confirm = {
    is_directive: obj.is_directive,
    confidence: Math.max(0, Math.min(1, obj.confidence)),
    polarity: polarity === "prescriptive" || polarity === "prohibitive" ? polarity : null,
    scope: scope === "session" || scope === "project" || scope === "universal" ? scope : null,
    suggested_title: typeof obj.suggested_title === "string" ? obj.suggested_title : null,
    normalized_text: typeof obj.normalized_text === "string" ? obj.normalized_text : null,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : null
  };
  return confirm;
}
function parseDedupRelation(raw) {
  const obj = extractFirstJsonObject(raw);
  const rel = obj?.relation;
  const reasoning = typeof obj?.reasoning === "string" ? obj.reasoning : "";
  if (rel === "restatement" || rel === "opposite_polarity" || rel === "related_but_distinct" || rel === "unrelated") {
    return { relation: rel, reasoning };
  }
  return { relation: "unrelated", reasoning };
}
function formatContextForLLM(window, targetTurnNumber) {
  const parts = [];
  for (const t of window) {
    const marker = t.turn_number === targetTurnNumber ? " [CANDIDATE]" : "";
    if (t.user_text) {
      parts.push(`[Turn ${t.turn_number}${marker}] USER: ${t.user_text}`);
    }
    if (t.assistant_text) {
      parts.push(`[Turn ${t.turn_number}${marker}] ASSISTANT: ${t.assistant_text}`);
    }
  }
  return parts.join("\n\n");
}
function fetchUserTurns(db, sessionId) {
  try {
    return cachedPrepare(
      db,
      `SELECT id, turn_number, user_text, assistant_text
       FROM conversation_turns
       WHERE session_id = ? AND user_text IS NOT NULL
       ORDER BY turn_number ASC`
    ).all(sessionId);
  } catch {
    return [];
  }
}
function fetchContextWindow(db, sessionId, centerTurn, span = 2) {
  try {
    return cachedPrepare(
      db,
      `SELECT id, turn_number, user_text, assistant_text
       FROM conversation_turns
       WHERE session_id = ?
         AND turn_number BETWEEN ? AND ?
       ORDER BY turn_number ASC`
    ).all(sessionId, centerTurn - span, centerTurn + span);
  } catch {
    return [];
  }
}
async function dedupLookup(db, embedding, scope, projectId, limit = 3) {
  try {
    loadSqliteVec(db);
    const queryVec = encodeVector(embedding);
    const knnLimit = 50;
    const knn = db.prepare(
      `SELECT rowid, distance
           FROM artifact_embeddings
          WHERE embedding MATCH ? AND k = ?
          ORDER BY distance`
    ).all(queryVec, knnLimit);
    if (knn.length === 0) return [];
    const distByRowid = /* @__PURE__ */ new Map();
    for (const row of knn) {
      const rid = typeof row.rowid === "bigint" ? Number(row.rowid) : row.rowid;
      distByRowid.set(rid, row.distance);
    }
    const placeholders = Array.from(distByRowid.keys()).map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT a.id AS id, a.title AS title, a.body AS body, a.data AS data, a.embedding_ref AS embedding_ref
           FROM artifact a
          WHERE a.kind = 'directive_rule'
            AND a.scope = ?
            AND a.project = ?
            AND a.status = 'active'
            AND a.embedding_ref IN (${placeholders})`
    ).all(scope, projectId, ...Array.from(distByRowid.keys()));
    const enriched = rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      data: r.data,
      distance: distByRowid.get(r.embedding_ref) ?? Number.POSITIVE_INFINITY
    })).sort((a, b) => a.distance - b.distance).slice(0, limit);
    return enriched;
  } catch {
    return [];
  }
}
async function confirmCandidate(cfg, candidateText, contextBlock) {
  try {
    const assets = loadPromptAssets();
    const userPrompt = `CONTEXT (\xB12 surrounding turns):

${contextBlock}

The CANDIDATE turn is marked [CANDIDATE]. Analyze it for a standing directive. Reply with JSON only.`;
    const raw = await generate({
      system: assets.confirmationSystem,
      prompt: userPrompt,
      model: cfg.model,
      temperature: 0,
      maxTokens: 512,
      subsystem: "directive_confirm"
    });
    return parseConfirmation(raw);
  } catch {
    return null;
  }
}
async function classifyRelation(cfg, candidateBody, shortlist) {
  try {
    const assets = loadPromptAssets();
    const listed = shortlist.map((row, i) => `#${i + 1} (cosine\u2248${l2DistanceToCosine(row.distance).toFixed(3)}): ${row.title ?? ""} \u2014 ${row.body}`).join("\n");
    const userPrompt = `CANDIDATE:
${candidateBody}

CANDIDATES_EXISTING (ordered by cosine desc):
${listed}

Classify the relation between CANDIDATE and item #1. JSON only.`;
    const raw = await generate({
      system: assets.dedupRelationSystem,
      prompt: userPrompt,
      model: cfg.model,
      temperature: 0,
      maxTokens: 256,
      subsystem: "directive_dedup"
    });
    return parseDedupRelation(raw);
  } catch {
    return { relation: "unrelated", reasoning: "" };
  }
}
function randomUuid() {
  const bytes = new Uint8Array(16);
  try {
    const crypto = require("node:crypto");
    crypto.randomFillSync(bytes);
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
function trimReinforcements(db, artifactId, cap) {
  try {
    const row = db.prepare(`SELECT json_array_length(json_extract(data, '$.reinforcements')) AS n FROM artifact WHERE id = ?`).get(artifactId);
    const n = row?.n ?? 0;
    if (n <= cap) return;
    const drop = n - cap;
    const removals = Array.from({ length: drop }, () => `'$.reinforcements[0]'`).join(", ");
    db.prepare(
      `UPDATE artifact SET data = json_remove(data, ${removals}) WHERE id = ?`
    ).run(artifactId);
  } catch {
  }
}
function writeArtifact(db, input, cfg) {
  const { confirmation, dedupHit, dedupRow } = input;
  const now = Date.now();
  if (dedupHit && dedupHit.relation === "restatement" && dedupRow) {
    const newReinforcement = {
      session_id: input.sessionId,
      turn_idx: input.turnIdx,
      seen_at_epoch: now,
      regex_family: input.matchedFamilies[0] ?? null
    };
    const existing = JSON.parse(dedupRow.data);
    const existingReinforcements = Array.isArray(existing.reinforcements) ? existing.reinforcements : [];
    const extended = [...existingReinforcements, newReinforcement];
    const newCount = (typeof existing.reinforcement_count === "number" ? existing.reinforcement_count : 1) + 1;
    db.prepare(
      `UPDATE artifact
          SET updated_at_epoch_ms = ?,
              data = json_set(
                       json_set(data, '$.reinforcement_count', ?),
                       '$.reinforcements',
                       json(?)
                     )
        WHERE id = ?`
    ).run(now, newCount, JSON.stringify(extended), dedupRow.id);
    trimReinforcements(db, dedupRow.id, cfg.reinforcementCap);
    return { decision: "updated", artifactId: dedupRow.id };
  }
  const id = randomUuid();
  const regexFamily = input.matchedFamilies[0] ?? null;
  const baseData = {
    polarity: confirmation.polarity,
    reasoning: confirmation.reasoning,
    source_session_id: input.sessionId,
    source_turn_idx: input.turnIdx,
    regex_family: regexFamily,
    reinforcement_count: 1,
    reinforcements: [
      {
        session_id: input.sessionId,
        turn_idx: input.turnIdx,
        seen_at_epoch: now,
        regex_family: regexFamily
      }
    ]
  };
  let decision = "inserted";
  if (dedupHit && dedupRow) {
    if (dedupHit.relation === "opposite_polarity") {
      baseData.possible_contradicts = dedupRow.id;
      baseData.contradict_reason = dedupHit.reasoning ?? "";
      decision = "annotated_opposite";
    } else if (dedupHit.relation === "related_but_distinct") {
      baseData.related_to = dedupRow.id;
      baseData.related_cosine = dedupHit.cosine;
      baseData.related_relation = "related_but_distinct";
      decision = "annotated_related";
    }
  }
  db.prepare(
    `INSERT INTO artifact(
       id, kind, title, body, scope, status, confidence,
       created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
     ) VALUES (?, 'directive_rule', ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    confirmation.suggested_title ?? null,
    confirmation.normalized_text ?? "",
    confirmation.scope ?? null,
    confirmation.confidence,
    now,
    now,
    input.sessionId,
    input.projectId,
    JSON.stringify(baseData)
  );
  try {
    loadSqliteVec(db);
    const vec = encodeVector(input.embedding);
    const maxRow = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM artifact_embeddings`).get();
    const prev = typeof maxRow.m === "bigint" ? maxRow.m : BigInt(maxRow.m);
    const nextId = prev + 1n;
    db.prepare(`INSERT INTO artifact_embeddings(rowid, embedding) VALUES (?, ?)`).run(nextId, vec);
    db.prepare(`UPDATE artifact SET embedding_ref = ? WHERE id = ?`).run(Number(nextId), id);
  } catch {
  }
  return { decision, artifactId: id };
}
async function extractDirectivesFromSession(db, sessionId, projectId, opts) {
  const cfg = loadConfig(opts);
  const result = {
    candidates: 0,
    confirmed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    decisions: []
  };
  const turns = fetchUserTurns(db, sessionId);
  if (turns.length === 0) return result;
  const candidates = [];
  for (const t of turns) {
    if (!t.user_text) continue;
    const stripped = stripCodeBlocks(t.user_text);
    const fams = matchFamilies(stripped);
    if (fams.length > 0) candidates.push({ turn: t, families: fams });
  }
  result.candidates = candidates.length;
  for (const { turn, families } of candidates) {
    const record = {
      session_id: sessionId,
      turn_idx: turn.turn_number,
      raw_text: turn.user_text ?? "",
      matched_families: families,
      decision: "rejected_regex"
    };
    try {
      const window = fetchContextWindow(db, sessionId, turn.turn_number, 2);
      const contextBlock = formatContextForLLM(window, turn.turn_number);
      const confirmation = await confirmCandidate(cfg, turn.user_text ?? "", contextBlock);
      if (!confirmation) {
        record.decision = "rejected_confirm";
        result.skipped++;
        result.decisions.push(record);
        continue;
      }
      record.confirmation = confirmation;
      const verdict = shouldReject(confirmation, cfg);
      if (verdict !== "accept") {
        record.decision = "rejected_confirm";
        result.skipped++;
        result.decisions.push(record);
        continue;
      }
      result.confirmed++;
      const scope = confirmation.scope;
      if (!scope) {
        record.decision = "rejected_confirm";
        result.skipped++;
        result.decisions.push(record);
        continue;
      }
      const toEmbed = `${confirmation.suggested_title ?? ""}
${confirmation.normalized_text ?? ""}`.trim();
      const embedding = await embedText(toEmbed);
      let dedupHit = null;
      let dedupRow = null;
      if (embedding) {
        const shortlist = await dedupLookup(db, embedding, scope, projectId, 3);
        if (shortlist.length > 0) {
          const topCosine = l2DistanceToCosine(shortlist[0].distance);
          if (topCosine >= cfg.dedupCosineThreshold) {
            const relationOut = await classifyRelation(cfg, toEmbed, shortlist);
            dedupHit = {
              top1_id: shortlist[0].id,
              cosine: topCosine,
              relation: relationOut.relation,
              reasoning: relationOut.reasoning
            };
            dedupRow = shortlist[0];
          }
        }
      }
      record.dedup = dedupHit ?? void 0;
      if (cfg.dryRun) {
        if (dedupHit) {
          if (dedupHit.relation === "restatement") record.decision = "updated";
          else if (dedupHit.relation === "opposite_polarity") record.decision = "annotated_opposite";
          else if (dedupHit.relation === "related_but_distinct") record.decision = "annotated_related";
          else record.decision = "inserted";
        } else {
          record.decision = "inserted";
        }
        if (record.decision === "updated") result.updated++;
        else result.inserted++;
        result.decisions.push(record);
        continue;
      }
      if (!embedding) {
      }
      const out = writeArtifact(
        db,
        {
          sessionId,
          projectId,
          turnIdx: turn.turn_number,
          matchedFamilies: families,
          confirmation,
          embedding: embedding ?? new Array(1024).fill(0),
          dedupHit,
          dedupRow
        },
        cfg
      );
      record.decision = out.decision;
      record.artifact_id = out.artifactId;
      if (out.decision === "updated") result.updated++;
      else result.inserted++;
    } catch (e) {
      record.decision = "error";
      record.error = e instanceof Error ? e.message : String(e);
      result.errors++;
    }
    result.decisions.push(record);
  }
  return result;
}
var BOUNDARY_CLASSIFIER_DEFAULT_MODEL = process.env["CLAUDEX_CHR_MODEL"] ?? "haiku";

// src/core/migrations.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);

// src/shared/constants.ts
var DEFAULT_COMPACTION_INSTRUCTIONS = [
  "Preserve all file paths verbatim \u2014 do not abbreviate, shorten, or summarize paths.",
  "Preserve error messages and stack traces verbatim.",
  "Preserve architectural decisions and their rationale.",
  "Do NOT reproduce code blocks verbatim \u2014 reference the file path and function name instead.",
  "Strip old tool outputs (older than 10 turns) \u2014 they are stored in the observation database.",
  "The checkpoint (## Checkpoint section) is the authoritative state source. Preserve its content.",
  "Keep the most recent context gauge line verbatim."
].join("\n");
var DEFAULT_CONFIG2 = {
  schema: "claudex/config",
  version: 3,
  injection: {
    budget_tokens: 8e3,
    topic_shift_budget: 800
  },
  observations: {
    retention_days: 90,
    prune_threshold: 1e3,
    prune_count: 50
  },
  checkpoint: {
    debounce_seconds: 60,
    compaction_instructions: DEFAULT_COMPACTION_INSTRUCTIONS
  },
  learnings: {
    max_per_project: 50
  },
  enrichment: {
    enabled: true,
    provider: "auto",
    ollama_base_url: "http://localhost:11434",
    ollama_model: "auto",
    timeout_ms: 1e4
  },
  embeddings: {
    enabled: true,
    provider: "ollama",
    model: "snowflake-arctic-embed2",
    ollama_base_url: "http://localhost:11434",
    topic_shift_threshold: 0.35,
    topic_shift_window: 3,
    decision_confidence_threshold: 0.15,
    jaccard_shift_threshold: 0.15
  },
  observability: {
    enabled: true,
    retention_days: 7,
    retain_error_count: 1e3
  },
  context: {
    advisory_threshold: 0.5,
    warning_threshold: 0.65,
    critical_threshold: 0.8,
    checkpoint_cooldown_seconds: 300
  },
  features: {
    fts5_search: true,
    error_fingerprint: false
  },
  // v6 routing surface (Phase 10) — defaults locked from .planning/phases/10-conditional-ship/10-CONTEXT.md decisions 1-3
  v6: {
    routing: {
      top_k_per_artifact: 3,
      max_k_per_query: 12,
      token_pct_cap: 15,
      bi_encoder_budget_pct: 50,
      reranker_mode: "bi_encoder_primary"
    }
  }
};
var PRESSURE_ZONES = {
  normal: { max: DEFAULT_CONFIG2.context.advisory_threshold },
  advisory: { min: DEFAULT_CONFIG2.context.advisory_threshold, max: DEFAULT_CONFIG2.context.warning_threshold },
  warning: { min: DEFAULT_CONFIG2.context.warning_threshold, max: DEFAULT_CONFIG2.context.critical_threshold },
  critical: { min: DEFAULT_CONFIG2.context.critical_threshold }
};

// src/core/schema.ts
var SHAPE_VOCABULARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS shape_vocabulary (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  promoted_at_epoch INTEGER NOT NULL,
  promoted_session_count INTEGER NOT NULL,
  PRIMARY KEY (field, value)
);

CREATE TABLE IF NOT EXISTS shape_candidates (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  proposed_at_epoch INTEGER NOT NULL,
  PRIMARY KEY (field, value, session_id)
);

CREATE INDEX IF NOT EXISTS idx_shape_candidates_field_value
  ON shape_candidates(field, value);

CREATE TABLE IF NOT EXISTS critical_rules_multi_project (
  project TEXT NOT NULL,
  normalized_rule_text TEXT NOT NULL,
  multi_project_count INTEGER NOT NULL,
  updated_at_epoch INTEGER NOT NULL,
  PRIMARY KEY (project, normalized_rule_text)
);

CREATE INDEX IF NOT EXISTS idx_crmp_norm_text
  ON critical_rules_multi_project(normalized_rule_text);
`;
var ARTIFACT_TASK_PATTERN_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_task_pattern (
  artifact_id INTEGER NOT NULL,
  task_pattern TEXT NOT NULL,
  classified_at_epoch_ms INTEGER NOT NULL,
  classifier_confidence REAL NOT NULL DEFAULT 1.0,
  classifier_source TEXT NOT NULL CHECK (classifier_source IN ('write_time', 'heartbeat_backfill')),
  PRIMARY KEY (artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_task_pattern_pattern
  ON artifact_task_pattern(task_pattern);
`;
var TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
    'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
    'reranker_fallback',
    'cross_project_ambiguous', 'cross_project_query_expansion',
    'episodic_write_failure',
    'signal_reread_after_surface', 'signal_retrieval_fallback',
    'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
    'handoff_parse_failed',
    'session_end_action',
    're_vectorize_failed',
    'soft_link_skipped', 'soft_link_write_failed',
    'chr_boundary_detected', 'chr_no_boundary', 'chr_classify_failed', 'chr_throttled'
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  latency_ms REAL,
  timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  adapter TEXT DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch_ms DESC);
`;
var POINTER_RECALL_SCHEMA = `
CREATE TABLE IF NOT EXISTS lesson_pointer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  filename TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('lesson','user_note')),
  first_seen_epoch_ms INTEGER NOT NULL,
  UNIQUE(project, filename, source)
);
CREATE INDEX IF NOT EXISTS idx_lesson_pointer_project ON lesson_pointer(project);

CREATE TABLE IF NOT EXISTS pointer_recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pointer_id INTEGER NOT NULL REFERENCES lesson_pointer(id),
  session_id TEXT NOT NULL,
  retrieved_at_epoch_ms INTEGER NOT NULL,
  helpful_yn INTEGER NULL,
  query TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_pointer_recall_pointer
  ON pointer_recall_log(pointer_id, retrieved_at_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_pointer_recall_session
  ON pointer_recall_log(session_id);
CREATE INDEX IF NOT EXISTS idx_pointer_recall_helpful
  ON pointer_recall_log(pointer_id, helpful_yn) WHERE helpful_yn = 1;
`;
var SCHEMA_V22 = `
CREATE TABLE IF NOT EXISTS retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  invoked_at_epoch_ms INTEGER NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN (
    'claudex_search', 'claudex_recall', 'pointer_surface', 'mcp_other'
  )),
  query TEXT,
  top_k_results TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(top_k_results)),
  used_in_output INTEGER NOT NULL DEFAULT 0
    CHECK (used_in_output IN (0, 1)),
  token_cost INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_retrieval_log_session
  ON retrieval_log(session_id, invoked_at_epoch_ms DESC);

CREATE TABLE IF NOT EXISTS session_flag (
  session_id TEXT NOT NULL,
  flag_key TEXT NOT NULL,
  flag_value TEXT NOT NULL DEFAULT '1',
  set_at_epoch_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, flag_key)
);
`;

// src/core/migration-steps.ts
init_sqlite_vec_loader();

// src/core/migration/v17-ddl.ts
init_sqlite_vec_loader();
function applyV17DDL(db) {
  db.exec(ARTIFACT_KERNEL_DDL);
  db.exec(KIND_REGISTRY_DDL);
  db.exec(LEGACY_ID_MAP_DDL);
  db.exec(KERNEL_TRIGGERS_DDL);
  db.exec(EXPRESSION_INDEXES_DDL);
  const loaded = loadSqliteVec(db);
  if (!loaded) {
    throw new Error(
      "applyV17DDL: sqlite-vec extension failed to load \u2014 cannot create artifact_embeddings"
    );
  }
  db.exec(ARTIFACT_EMBEDDINGS_DDL);
  db.exec(ARTIFACT_FTS_DDL);
}
var ARTIFACT_KERNEL_DDL = `
CREATE TABLE IF NOT EXISTS artifact (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  title             TEXT,
  body              TEXT NOT NULL,
  scope             TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  confidence        REAL,
  created_at_epoch_ms  INTEGER NOT NULL,
  updated_at_epoch_ms  INTEGER NOT NULL,
  session_id        TEXT,
  project           TEXT,
  embedding_ref     INTEGER,
  supersedes_id     TEXT REFERENCES artifact(id),
  data              TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data))
);

CREATE INDEX IF NOT EXISTS idx_artifact_kind
  ON artifact(kind, created_at_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_project
  ON artifact(project, kind, created_at_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_status
  ON artifact(status, kind);
`;
var KIND_REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS kind_registry (
  kind                TEXT PRIMARY KEY,
  first_seen_epoch_ms INTEGER NOT NULL,
  last_seen_epoch_ms  INTEGER NOT NULL
);
`;
var LEGACY_ID_MAP_DDL = `
CREATE TABLE IF NOT EXISTS legacy_id_map (
  legacy_table TEXT NOT NULL,
  legacy_id    INTEGER NOT NULL,
  new_uuid     TEXT NOT NULL REFERENCES artifact(id),
  PRIMARY KEY (legacy_table, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_legacy_id_map_uuid ON legacy_id_map(new_uuid);
`;
var KERNEL_TRIGGERS_DDL = `
CREATE TRIGGER IF NOT EXISTS artifact_register_kind
AFTER INSERT ON artifact
BEGIN
  INSERT INTO kind_registry(kind, first_seen_epoch_ms, last_seen_epoch_ms)
    VALUES (NEW.kind, NEW.created_at_epoch_ms, NEW.created_at_epoch_ms)
  ON CONFLICT(kind) DO UPDATE SET last_seen_epoch_ms = excluded.last_seen_epoch_ms;
END;
`;
var EXPRESSION_INDEXES_DDL = `
-- learnings (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_learning_agent
  ON artifact(project, json_extract(data, '$.agent_id'), json_extract(data, '$.promotion_count') DESC)
  WHERE kind = 'learning';
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_learning
  ON artifact(project, json_extract(data, '$.agent_id'), json_extract(data, '$.fingerprint'))
  WHERE kind = 'learning';

-- decisions (3 indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_decision
  ON artifact(session_id, json_extract(data, '$.fingerprint'))
  WHERE kind = 'decision';
CREATE INDEX IF NOT EXISTS idx_artifact_decision_session
  ON artifact(session_id, created_at_epoch_ms DESC)
  WHERE kind = 'decision';
CREATE INDEX IF NOT EXISTS idx_artifact_decision_project
  ON artifact(project, created_at_epoch_ms DESC)
  WHERE kind = 'decision';

-- experience_patterns (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_expat_score
  ON artifact(json_extract(data, '$.score') DESC, json_extract(data, '$.times_triggered') DESC)
  WHERE kind = 'experience_pattern';
CREATE INDEX IF NOT EXISTS idx_artifact_expat_project_score
  ON artifact(project, json_extract(data, '$.score') DESC)
  WHERE kind = 'experience_pattern';

-- angel_opinions (2 indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_opinion
  ON artifact(project, json_extract(data, '$.subject'))
  WHERE kind = 'angel_opinion';
CREATE INDEX IF NOT EXISTS idx_artifact_opinion_confidence
  ON artifact(project, confidence DESC)
  WHERE kind = 'angel_opinion';

-- critical_rules (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_critrule_source
  ON artifact(project, json_extract(data, '$.source'))
  WHERE kind = 'critical_rule';
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_critrule_dedup
  ON artifact(project, body)
  WHERE kind = 'critical_rule';

-- mental_model / project_curated_context (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_mentalmodel_status
  ON artifact(project, status)
  WHERE kind = 'mental_model';
CREATE INDEX IF NOT EXISTS idx_artifact_mentalmodel_type
  ON artifact(project, json_extract(data, '$.type'), status)
  WHERE kind = 'mental_model';
`;
var ARTIFACT_EMBEDDINGS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_embeddings
  USING vec0(embedding float[1024]);
`;
var ARTIFACT_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  title, body,
  content='artifact',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS artifact_fts_ai
AFTER INSERT ON artifact
BEGIN
  INSERT INTO artifact_fts(rowid, title, body)
    VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS artifact_fts_au
AFTER UPDATE OF title, body ON artifact
BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
  INSERT INTO artifact_fts(rowid, title, body)
    VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS artifact_fts_ad
AFTER DELETE ON artifact
BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
END;
`;

// src/core/migration-steps.ts
function hasTable(db, table) {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row.cnt > 0;
}
function hasColumn(db, table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some((c) => c.name === column);
}
function ensureAdapterColumns(db) {
  if (hasTable(db, "sessions") && !hasColumn(db, "sessions", "adapter")) {
    db.exec("ALTER TABLE sessions ADD COLUMN adapter TEXT DEFAULT 'unknown'");
  }
  const telemetryCols = db.pragma("table_info(telemetry)");
  if (telemetryCols.length > 0 && !telemetryCols.some((c) => c.name === "adapter")) {
    db.exec("ALTER TABLE telemetry ADD COLUMN adapter TEXT DEFAULT 'unknown'");
  }
}
function migrateV1toV2(db) {
  if (hasTable(db, "pressure_scores") && hasColumn(db, "pressure_scores", "last_accessed_epoch") && !hasColumn(db, "pressure_scores", "last_touched_epoch")) {
    db.exec("ALTER TABLE pressure_scores ADD COLUMN last_touched_epoch INTEGER");
    db.exec("UPDATE pressure_scores SET last_touched_epoch = last_accessed_epoch");
  }
  if (!hasColumn(db, "observations", "consumed")) {
    db.exec("ALTER TABLE observations ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "observations", "obs_type")) {
    db.exec("ALTER TABLE observations ADD COLUMN obs_type TEXT");
  }
  ensureAdapterColumns(db);
  const tsCol = hasColumn(db, "observations", "timestamp_epoch_ms") ? "timestamp_epoch_ms" : "timestamp_epoch";
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, ${tsCol} DESC)`);
}
function migrateV2toV3(db) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    if (!tables.includes("artifacts")) return true;
    try {
      db.exec(`SAVEPOINT v3_probe`);
      db.exec(`INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, state, ttl, importance)
        VALUES ('__v3_probe__', '__v3_probe__', 'memory_file', NULL, '__v3_probe__', 'packed', 0, 1)`);
      db.exec(`ROLLBACK TO v3_probe`);
      db.exec(`RELEASE v3_probe`);
      return true;
    } catch {
      try {
        db.exec("ROLLBACK TO v3_probe");
      } catch {
      }
      try {
        db.exec("RELEASE v3_probe");
      } catch {
      }
    }
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE artifacts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (
            'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
            'memory_file', 'session_log', 'handoff'
          )),
          artifact_ref TEXT,
          summary TEXT NOT NULL,
          content TEXT,
          state TEXT NOT NULL DEFAULT 'fresh'
            CHECK (state IN ('fresh', 'packed', 'materialized')),
          ttl INTEGER NOT NULL DEFAULT 3,
          importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
          timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          last_materialized_epoch INTEGER
        );
        INSERT INTO artifacts_new (id, session_id, project, artifact_type, artifact_ref,
        summary, content, state, ttl, importance, timestamp_epoch, last_materialized_epoch)
      SELECT id, session_id, project, artifact_type, artifact_ref,
        summary, content, state, ttl, importance, timestamp_epoch, last_materialized_epoch
      FROM artifacts;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_new RENAME TO artifacts;
        CREATE INDEX IF NOT EXISTS idx_artifacts_project_state ON artifacts(project, state);
        CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);
      `);
      db.exec("COMMIT");
      return true;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      return false;
    }
  } catch {
    return false;
  }
}
function migrateV3toV4(db) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((t) => t.name);
    if (!tables.includes("artifacts_fts")) {
      db.exec(`
        CREATE VIRTUAL TABLE artifacts_fts USING fts5(
          summary, content, content=artifacts, content_rowid=id,
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
          INSERT INTO artifacts_fts(rowid, summary, content)
          VALUES (new.id, new.summary, COALESCE(new.content, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_update AFTER UPDATE OF summary, content ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
          VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
          INSERT INTO artifacts_fts(rowid, summary, content)
          VALUES (new.id, new.summary, COALESCE(new.content, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
          VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
        END;
      `);
      db.exec(`INSERT INTO artifacts_fts(rowid, summary, content) SELECT id, summary, COALESCE(content, '') FROM artifacts`);
    }
    if (!tables.includes("context_triggers")) {
      db.exec(`CREATE TABLE context_triggers (id INTEGER PRIMARY KEY AUTOINCREMENT, glob_pattern TEXT, command_pattern TEXT, knowledge_domain TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 5, project TEXT NOT NULL DEFAULT '__global__');`);
    }
    if (!tables.includes("session_events")) {
      db.exec(`CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, event_type TEXT NOT NULL, entity TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(project, timestamp_epoch);`);
    }
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_file_ref ON artifacts(project, artifact_type, artifact_ref) WHERE artifact_ref IS NOT NULL AND artifact_type IN ('memory_file', 'session_log', 'handoff')`);
    } catch {
    }
    const artCols = db.pragma("table_info(artifacts)").map((c) => c.name);
    if (!artCols.includes("retrieval_score")) {
      db.exec("ALTER TABLE artifacts ADD COLUMN retrieval_score REAL NOT NULL DEFAULT 1.0");
    }
    if (tables.includes("experience_patterns")) {
      const epCols = db.pragma("table_info(experience_patterns)").map((c) => c.name);
      if (!epCols.includes("trigger_glob")) db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_glob TEXT");
      if (!epCols.includes("trigger_command")) db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_command TEXT");
    }
    const sessCols = db.pragma("table_info(sessions)").map((c) => c.name);
    if (!sessCols.includes("session_summary")) db.exec("ALTER TABLE sessions ADD COLUMN session_summary TEXT");
  } catch {
  }
}
function migrateV4toV5(db) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    if (!tables.includes("retrieval_feedback")) {
      db.exec(`CREATE TABLE retrieval_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, artifact_id INTEGER NOT NULL, query_text TEXT NOT NULL, was_useful INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_artifact ON retrieval_feedback(artifact_id);
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_session ON retrieval_feedback(session_id);`);
    }
    if (tables.includes("reasoning_chains")) {
      try {
        db.exec(`UPDATE reasoning_chains SET timestamp_epoch = timestamp_epoch / 1000 WHERE timestamp_epoch > 10000000000`);
        db.exec(`UPDATE reasoning_chains SET created_at_epoch = created_at_epoch / 1000 WHERE created_at_epoch > 10000000000`);
      } catch {
      }
    }
    try {
      db.exec(`UPDATE observations SET content = '' WHERE content IS NULL`);
      db.exec(`UPDATE observations SET access_count = 0 WHERE access_count IS NULL`);
      db.exec(`UPDATE sessions SET status = 'completed' WHERE status IS NULL`);
      db.exec(`UPDATE sessions SET observation_count = 0 WHERE observation_count IS NULL`);
      db.exec(`UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature IS NULL`);
      db.exec(`UPDATE pressure_scores SET last_touched_epoch = 0 WHERE last_touched_epoch IS NULL`);
      db.exec(`UPDATE pressure_scores SET decay_rate = 0.1 WHERE decay_rate IS NULL`);
      db.exec(`UPDATE session_journal SET timestamp_epoch = 0 WHERE timestamp_epoch IS NULL`);
    } catch {
    }
  } catch {
  }
}
function migrateV5toV6(db) {
  try {
    if (hasTable(db, "session_journal") && !hasColumn(db, "session_journal", "metadata")) {
      db.exec("ALTER TABLE session_journal ADD COLUMN metadata TEXT");
    }
    if (hasTable(db, "session_journal")) {
      try {
        db.exec("SAVEPOINT v6_sj_probe");
        db.exec("INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch) VALUES ('__probe__', '__probe__', 'flow', '__probe__', NULL)");
        db.exec("ROLLBACK TO v6_sj_probe");
        db.exec("RELEASE v6_sj_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE session_journal_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, entry_type TEXT NOT NULL CHECK (entry_type IN ('flow', 'milestone', 'summary')), content TEXT NOT NULL, metadata TEXT, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()))`);
        db.exec(`INSERT INTO session_journal_new (id, session_id, project, entry_type, content, metadata, timestamp_epoch) SELECT id, session_id, project, entry_type, content, metadata, COALESCE(timestamp_epoch, 0) FROM session_journal`);
        db.exec("DROP TABLE session_journal");
        db.exec("ALTER TABLE session_journal_new RENAME TO session_journal");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_sj_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_sj_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "sessions")) {
      try {
        db.exec("SAVEPOINT v6_sess_probe");
        db.exec("INSERT INTO sessions (session_id, status) VALUES ('__v6_probe__', NULL)");
        db.exec("ROLLBACK TO v6_sess_probe");
        db.exec("RELEASE v6_sess_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE sessions_new (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'unknown', project TEXT NOT NULL DEFAULT '__global__', cwd TEXT NOT NULL DEFAULT '.', source TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')), observation_count INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), ended_at_epoch INTEGER, adapter TEXT DEFAULT 'unknown', session_summary TEXT)`);
        db.exec(`INSERT INTO sessions_new SELECT session_id, COALESCE(scope, 'unknown'), COALESCE(project, '__global__'), COALESCE(cwd, '.'), source, COALESCE(status, 'completed'), COALESCE(observation_count, 0), created_at_epoch, ended_at_epoch, adapter, session_summary FROM sessions`);
        db.exec("DROP TABLE sessions");
        db.exec("ALTER TABLE sessions_new RENAME TO sessions");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, created_at_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, created_at_epoch DESC)");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_sess_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_sess_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "observations")) {
      try {
        db.exec("SAVEPOINT v6_obs_probe");
        db.exec("INSERT INTO observations (session_id, tool_name, category, title, content, importance) VALUES ('__v6__', 'Test', 'code', 'test', NULL, 1)");
        db.exec("ROLLBACK TO v6_obs_probe");
        db.exec("RELEASE v6_obs_probe");
        db.exec("BEGIN");
        db.exec("DROP TRIGGER IF EXISTS observations_ai");
        db.exec("DROP TRIGGER IF EXISTS observations_ad");
        db.exec("DROP TRIGGER IF EXISTS observations_au");
        db.exec(`CREATE TABLE observations_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT, tool_name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('code', 'architecture', 'decision', 'error', 'test', 'config', 'dependency', 'documentation', 'performance', 'security', 'other')), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)), timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()), access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at_epoch INTEGER, deleted_at_epoch INTEGER DEFAULT NULL, consumed INTEGER NOT NULL DEFAULT 0, obs_type TEXT)`);
        db.exec(`INSERT INTO observations_new SELECT id, session_id, project, tool_name, category, title, COALESCE(content, ''), importance, files_modified, timestamp_epoch, COALESCE(access_count, 0), last_accessed_at_epoch, deleted_at_epoch, consumed, obs_type FROM observations`);
        db.exec("DROP TABLE observations");
        db.exec("ALTER TABLE observations_new RENAME TO observations");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_composite ON observations(tool_name, category, project, session_id, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_active ON observations(project, deleted_at_epoch, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_importance ON observations(project, deleted_at_epoch, importance)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)");
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_obs_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_obs_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "pressure_scores")) {
      try {
        db.exec("SAVEPOINT v6_ps_probe");
        db.exec("INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature) VALUES ('__probe__', '__probe__', 0, NULL)");
        db.exec("ROLLBACK TO v6_ps_probe");
        db.exec("RELEASE v6_ps_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE pressure_scores_new (file_path TEXT NOT NULL, project TEXT NOT NULL, raw_pressure REAL NOT NULL DEFAULT 0, temperature TEXT NOT NULL DEFAULT 'COLD', last_touched_epoch INTEGER NOT NULL DEFAULT 0, decay_rate REAL NOT NULL DEFAULT 0.1, PRIMARY KEY (file_path, project))`);
        db.exec(`INSERT OR IGNORE INTO pressure_scores_new (file_path, project, raw_pressure, temperature, last_touched_epoch, decay_rate) SELECT file_path, project, raw_pressure, COALESCE(temperature, 'COLD'), COALESCE(last_touched_epoch, 0), COALESCE(decay_rate, 0.1) FROM pressure_scores`);
        db.exec("DROP TABLE pressure_scores");
        db.exec("ALTER TABLE pressure_scores_new RENAME TO pressure_scores");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_ps_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_ps_probe");
        } catch {
        }
      }
    }
  } catch {
  }
}
function migrateV6toV7(db) {
  try {
    if (hasTable(db, "sessions")) {
      try {
        db.exec("SAVEPOINT v7_sess_probe");
        db.exec("INSERT INTO sessions (session_id, status) VALUES ('__v7_probe__', NULL)");
        db.exec("ROLLBACK TO v7_sess_probe");
        db.exec("RELEASE v7_sess_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE sessions_new (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'unknown', project TEXT NOT NULL DEFAULT '__global__', cwd TEXT NOT NULL DEFAULT '.', source TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')), observation_count INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), ended_at_epoch INTEGER, adapter TEXT DEFAULT 'unknown', session_summary TEXT)`);
        db.exec(`INSERT INTO sessions_new SELECT session_id, COALESCE(scope, 'unknown'), COALESCE(project, '__global__'), COALESCE(cwd, '.'), source, COALESCE(status, 'completed'), COALESCE(observation_count, 0), created_at_epoch, ended_at_epoch, adapter, session_summary FROM sessions`);
        db.exec("DROP TABLE sessions");
        db.exec("ALTER TABLE sessions_new RENAME TO sessions");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, created_at_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, created_at_epoch DESC)");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v7_sess_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v7_sess_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "observations")) {
      try {
        db.exec("SAVEPOINT v7_obs_probe");
        db.exec("INSERT INTO observations (session_id, tool_name, category, title, content, importance) VALUES ('__v7__', 'Test', 'code', 'test', NULL, 1)");
        db.exec("ROLLBACK TO v7_obs_probe");
        db.exec("RELEASE v7_obs_probe");
        try {
          db.exec("UPDATE observations SET category = 'code' WHERE category NOT IN ('code','architecture','decision','error','test','config','dependency','documentation','performance','security','other')");
        } catch {
        }
        db.exec("BEGIN");
        db.exec("DROP TRIGGER IF EXISTS observations_ai");
        db.exec("DROP TRIGGER IF EXISTS observations_ad");
        db.exec("DROP TRIGGER IF EXISTS observations_au");
        db.exec(`CREATE TABLE observations_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT, tool_name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('code', 'architecture', 'decision', 'error', 'test', 'config', 'dependency', 'documentation', 'performance', 'security', 'other')), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)), timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()), access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at_epoch INTEGER, deleted_at_epoch INTEGER DEFAULT NULL, consumed INTEGER NOT NULL DEFAULT 0, obs_type TEXT)`);
        db.exec(`INSERT INTO observations_new SELECT id, session_id, project, tool_name, category, title, COALESCE(content, ''), importance, files_modified, timestamp_epoch, COALESCE(access_count, 0), last_accessed_at_epoch, deleted_at_epoch, consumed, obs_type FROM observations`);
        db.exec("DROP TABLE observations");
        db.exec("ALTER TABLE observations_new RENAME TO observations");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_composite ON observations(tool_name, category, project, session_id, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_active ON observations(project, deleted_at_epoch, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_importance ON observations(project, deleted_at_epoch, importance)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)");
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v7_obs_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v7_obs_probe");
        } catch {
        }
      }
    }
  } catch {
  }
}
function migrateV7toV8(db) {
  try {
    if (hasTable(db, "session_journal") && !hasColumn(db, "session_journal", "recall_text")) {
      db.exec("ALTER TABLE session_journal ADD COLUMN recall_text TEXT");
    }
    if (hasTable(db, "session_journal") && !hasTable(db, "session_journal_fts")) {
      db.exec(`
        CREATE VIRTUAL TABLE session_journal_fts USING fts5(
          content, recall_text, content='session_journal', content_rowid=id, tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS journal_fts_ai AFTER INSERT ON session_journal BEGIN
          INSERT INTO session_journal_fts(rowid, content, recall_text) VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS journal_fts_ad AFTER DELETE ON session_journal BEGIN
          INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text) VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS journal_fts_au AFTER UPDATE ON session_journal BEGIN
          INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text) VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
          INSERT INTO session_journal_fts(rowid, content, recall_text) VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
        END;
      `);
      try {
        db.exec("INSERT INTO session_journal_fts(session_journal_fts) VALUES('rebuild')");
      } catch {
      }
    }
  } catch {
  }
}
function migrateV8toV9(db) {
  try {
    if (hasTable(db, "artifacts")) {
      if (!hasColumn(db, "artifacts", "embedding")) db.exec("ALTER TABLE artifacts ADD COLUMN embedding BLOB");
      if (!hasColumn(db, "artifacts", "activation_score")) db.exec("ALTER TABLE artifacts ADD COLUMN activation_score REAL NOT NULL DEFAULT 1.0");
      if (!hasColumn(db, "artifacts", "superseded_by")) db.exec("ALTER TABLE artifacts ADD COLUMN superseded_by INTEGER");
      if (!hasColumn(db, "artifacts", "valid_until")) db.exec("ALTER TABLE artifacts ADD COLUMN valid_until INTEGER");
      if (!hasColumn(db, "artifacts", "confidence")) db.exec("ALTER TABLE artifacts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0");
      if (!hasColumn(db, "artifacts", "novelty_score")) db.exec("ALTER TABLE artifacts ADD COLUMN novelty_score REAL NOT NULL DEFAULT 0.5");
    }
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "embedding")) db.exec("ALTER TABLE experience_patterns ADD COLUMN embedding BLOB");
      if (!hasColumn(db, "experience_patterns", "assumption")) db.exec("ALTER TABLE experience_patterns ADD COLUMN assumption TEXT");
      if (!hasColumn(db, "experience_patterns", "reality")) db.exec("ALTER TABLE experience_patterns ADD COLUMN reality TEXT");
      if (!hasColumn(db, "experience_patterns", "root_cause")) db.exec("ALTER TABLE experience_patterns ADD COLUMN root_cause TEXT");
      if (!hasColumn(db, "experience_patterns", "generalized_rule")) db.exec("ALTER TABLE experience_patterns ADD COLUMN generalized_rule TEXT");
      if (!hasColumn(db, "experience_patterns", "abstraction_level")) db.exec("ALTER TABLE experience_patterns ADD COLUMN abstraction_level TEXT DEFAULT 'tip'");
      if (!hasColumn(db, "experience_patterns", "verified")) db.exec("ALTER TABLE experience_patterns ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "experience_patterns", "verification_count")) db.exec("ALTER TABLE experience_patterns ADD COLUMN verification_count INTEGER NOT NULL DEFAULT 0");
    }
    if (hasTable(db, "thread_state")) {
      if (!hasColumn(db, "thread_state", "summary_embedding")) db.exec("ALTER TABLE thread_state ADD COLUMN summary_embedding BLOB");
    }
    if (hasTable(db, "session_journal")) {
      if (!hasColumn(db, "session_journal", "embedding")) db.exec("ALTER TABLE session_journal ADD COLUMN embedding BLOB");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS artifact_links (source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, link_type TEXT NOT NULL CHECK (link_type IN ('related', 'supports', 'contradicts', 'supersedes', 'caused_by')), strength REAL NOT NULL DEFAULT 0.5, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (source_id, target_id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS retrieval_events (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id INTEGER NOT NULL, session_id TEXT NOT NULL, query_text TEXT, was_referenced INTEGER, correction_followed INTEGER, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE INDEX IF NOT EXISTS idx_retrieval_artifact ON retrieval_events(artifact_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_events(session_id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS capability_boundaries (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, domain TEXT NOT NULL, total_interactions INTEGER NOT NULL DEFAULT 0, corrections INTEGER NOT NULL DEFAULT 0, last_updated_epoch INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(project, domain));`);
    try {
      db.exec(`UPDATE artifacts SET activation_score = MAX(0.1, 0.0 + (importance - 3) * 0.3 + 1.0) WHERE activation_score = 1.0 AND id > 0`);
    } catch {
    }
  } catch {
  }
}
function migrateV9toV10(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        turn_number INTEGER NOT NULL DEFAULT 0,
        user_text TEXT,
        assistant_text TEXT,
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_convturns_session
        ON conversation_turns(session_id, turn_number);
      CREATE INDEX IF NOT EXISTS idx_convturns_project
        ON conversation_turns(project, timestamp_epoch DESC);
    `);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
          user_text, assistant_text,
          content=conversation_turns,
          content_rowid=id,
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS convturns_fts_ai AFTER INSERT ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(rowid, user_text, assistant_text)
          VALUES (new.id, COALESCE(new.user_text, ''), COALESCE(new.assistant_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS convturns_fts_ad AFTER DELETE ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_text, assistant_text)
          VALUES ('delete', old.id, COALESCE(old.user_text, ''), COALESCE(old.assistant_text, ''));
        END;
      `);
    } catch {
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_session TEXT NOT NULL,
        sender TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'event'
          CHECK (message_type IN ('event', 'command', 'query', 'advisory')),
        content TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('normal', 'urgent', 'advisory')),
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        delivered_at_epoch INTEGER,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessmsg_target
        ON session_messages(target_session, delivered_at_epoch, priority);
      CREATE INDEX IF NOT EXISTS idx_sessmsg_sender
        ON session_messages(sender, created_at_epoch DESC);
    `);
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "helpful_count"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "experience_patterns", "harmful_count"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN harmful_count INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "experience_patterns", "escalation_level"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN escalation_level TEXT NOT NULL DEFAULT 'pattern'");
      try {
        db.exec(`
          UPDATE experience_patterns
          SET helpful_count = times_useful,
              harmful_count = MAX(0, times_triggered - times_useful)
          WHERE helpful_count = 0 AND harmful_count = 0 AND times_triggered > 0
        `);
      } catch {
      }
    }
    const MAX_SANE_EPOCH = 4102444800;
    db.exec(`
      UPDATE sessions
      SET created_at_epoch = CAST(created_at_epoch / 1000 AS INTEGER)
      WHERE created_at_epoch > ${MAX_SANE_EPOCH}
    `);
    db.exec(`
      UPDATE sessions
      SET ended_at_epoch = CAST(ended_at_epoch / 1000 AS INTEGER)
      WHERE ended_at_epoch IS NOT NULL AND ended_at_epoch > ${MAX_SANE_EPOCH}
    `);
    try {
      db.exec(`
        DELETE FROM artifacts WHERE id IN (
          SELECT a.id FROM artifacts a
          WHERE a.summary LIKE '[Reflection]%'
          AND a.id NOT IN (
            SELECT MIN(id) FROM artifacts
            WHERE summary LIKE '[Reflection]%'
            GROUP BY project, summary
          )
        )
      `);
      db.exec("INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')");
    } catch {
    }
  } catch {
  }
}
function migrateV10toV11(db) {
  try {
    if (hasTable(db, "observations")) {
      if (!hasColumn(db, "observations", "stability_class"))
        db.exec("ALTER TABLE observations ADD COLUMN stability_class TEXT DEFAULT 'standard'");
      if (!hasColumn(db, "observations", "novelty_score"))
        db.exec("ALTER TABLE observations ADD COLUMN novelty_score REAL DEFAULT 0.5");
      if (!hasColumn(db, "observations", "consolidated_into"))
        db.exec("ALTER TABLE observations ADD COLUMN consolidated_into INTEGER");
    }
  } catch {
  }
  try {
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "maturity"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN maturity TEXT DEFAULT 'candidate'");
      if (!hasColumn(db, "experience_patterns", "confidence"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN confidence REAL DEFAULT 0.5");
    }
  } catch {
  }
  try {
    if (hasTable(db, "artifact_links")) {
      if (!hasColumn(db, "artifact_links", "valid_at_epoch"))
        db.exec("ALTER TABLE artifact_links ADD COLUMN valid_at_epoch INTEGER");
      if (!hasColumn(db, "artifact_links", "invalid_at_epoch"))
        db.exec("ALTER TABLE artifact_links ADD COLUMN invalid_at_epoch INTEGER");
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        access_type TEXT NOT NULL DEFAULT 'retrieval'
          CHECK (access_type IN ('retrieval', 'materialization', 'reference', 'spread')),
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_aal_artifact
        ON artifact_access_log(artifact_id, timestamp_epoch DESC);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT NOT NULL,
        detected_by TEXT NOT NULL,
        detected_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        priority REAL NOT NULL DEFAULT 0.5,
        resolved_at_epoch INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kg_project
        ON knowledge_gaps(project, resolved_at_epoch);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        hour_bucket INTEGER NOT NULL CHECK (hour_bucket BETWEEN 0 AND 5),
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        session_count INTEGER NOT NULL DEFAULT 0,
        avg_duration_sec REAL,
        common_first_actions TEXT DEFAULT '[]',
        updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project, hour_bucket, day_of_week)
      );
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_transitions (
        project TEXT NOT NULL,
        from_action TEXT NOT NULL,
        to_action TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        last_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (project, from_action, to_action)
      );
    `);
  } catch {
  }
  try {
    db.exec(`
      UPDATE observations SET stability_class = 'transient'
      WHERE stability_class = 'standard' AND category IN ('error', 'test')
    `);
    db.exec(`
      UPDATE observations SET stability_class = 'stable'
      WHERE stability_class = 'standard' AND category IN ('architecture', 'decision')
    `);
  } catch {
  }
  try {
    if (hasTable(db, "experience_patterns")) {
      db.exec(`
        UPDATE experience_patterns SET maturity = 'proven'
        WHERE maturity = 'candidate' AND times_triggered >= 5 AND helpful_count >= 3
      `);
      db.exec(`
        UPDATE experience_patterns SET maturity = 'established'
        WHERE maturity = 'candidate' AND times_triggered >= 2
      `);
      db.exec(`
        UPDATE experience_patterns
        SET confidence = CAST((helpful_count + 1) AS REAL) / CAST((helpful_count + harmful_count + 2) AS REAL)
        WHERE confidence = 0.5 AND (helpful_count > 0 OR harmful_count > 0)
      `);
    }
  } catch {
  }
  try {
    if (hasTable(db, "thread_state") && !hasColumn(db, "thread_state", "qdrant_synced")) {
      db.exec("ALTER TABLE thread_state ADD COLUMN qdrant_synced INTEGER NOT NULL DEFAULT 0");
    }
  } catch {
  }
  try {
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "retrieval_mode"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN retrieval_mode TEXT DEFAULT 'reactive'");
      if (!hasColumn(db, "experience_patterns", "trigger_intents"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_intents TEXT DEFAULT '[]'");
    }
  } catch {
  }
}
function migrateV11toV12(db) {
  try {
    if (hasTable(db, "sessions")) {
      if (!hasColumn(db, "sessions", "name"))
        db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
      if (!hasColumn(db, "sessions", "transferred_to"))
        db.exec("ALTER TABLE sessions ADD COLUMN transferred_to TEXT");
    }
  } catch {
  }
  try {
    if (hasTable(db, "session_messages") && !hasColumn(db, "session_messages", "sender_type")) {
      db.exec(`
        CREATE TABLE session_messages_v12 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_session TEXT NOT NULL,
          sender TEXT NOT NULL,
          sender_type TEXT NOT NULL DEFAULT 'angel'
            CHECK (sender_type IN ('angel', 'session', 'system')),
          message_type TEXT NOT NULL DEFAULT 'event'
            CHECK (message_type IN ('event', 'command', 'query', 'advisory', 'request', 'response', 'notify', 'transfer', 'acknowledge')),
          content TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal'
            CHECK (priority IN ('normal', 'urgent', 'advisory')),
          request_id TEXT,
          created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          delivered_at_epoch INTEGER,
          acknowledged INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO session_messages_v12 (id, target_session, sender, message_type, content, priority, created_at_epoch, delivered_at_epoch, acknowledged)
          SELECT id, target_session, sender, message_type, content, priority, created_at_epoch, delivered_at_epoch, acknowledged
          FROM session_messages;
        DROP TABLE session_messages;
        ALTER TABLE session_messages_v12 RENAME TO session_messages;
        CREATE INDEX IF NOT EXISTS idx_sessmsg_target
          ON session_messages(target_session, delivered_at_epoch, priority);
        CREATE INDEX IF NOT EXISTS idx_sessmsg_sender
          ON session_messages(sender, created_at_epoch DESC);
      `);
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        signal_type TEXT NOT NULL
          CHECK (signal_type IN ('wip', 'failure', 'danger', 'claim', 'discovery')),
        target TEXT NOT NULL,
        detail TEXT,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at_epoch INTEGER,
        cleared_at_epoch INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_signals_project_type
        ON session_signals(project, signal_type, cleared_at_epoch);
      CREATE INDEX IF NOT EXISTS idx_signals_session
        ON session_signals(session_id, cleared_at_epoch);
    `);
  } catch {
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name)");
  } catch {
  }
  try {
    if (hasTable(db, "artifacts")) {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
      if (schema?.sql && !schema.sql.includes("entity_summary")) {
        db.exec(`
          CREATE TABLE artifacts_v12 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project TEXT,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN (
              'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
              'memory_file', 'session_log', 'handoff', 'entity_summary'
            )),
            artifact_ref TEXT,
            summary TEXT,
            content TEXT,
            state TEXT DEFAULT 'active',
            ttl INTEGER,
            importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
            timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
            last_materialized_epoch INTEGER,
            retrieval_score REAL DEFAULT 0.0,
            embedding BLOB,
            activation_score REAL DEFAULT 0.0,
            superseded_by INTEGER,
            valid_until INTEGER,
            confidence REAL DEFAULT 1.0,
            novelty_score REAL DEFAULT 0.5
          );
          INSERT INTO artifacts_v12 SELECT * FROM artifacts;
          DROP TABLE artifacts;
          ALTER TABLE artifacts_v12 RENAME TO artifacts;
          CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project, artifact_type, timestamp_epoch DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, timestamp_epoch DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type, state, importance DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_activation ON artifacts(project, activation_score DESC);
        `);
      }
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS angel_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        subject TEXT NOT NULL,
        opinion TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        reinforced_count INTEGER NOT NULL DEFAULT 0,
        weakened_count INTEGER NOT NULL DEFAULT 0,
        contradicted_count INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT 'inferred',
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project, subject)
      );
      CREATE INDEX IF NOT EXISTS idx_opinions_project
        ON angel_opinions(project, confidence DESC);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT NOT NULL,
        canonical TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (alias)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_canonical ON entity_aliases(canonical);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS solution_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        pattern_id TEXT,
        artifact_id INTEGER,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial', 'unknown')),
        impact TEXT,
        effectiveness_score REAL DEFAULT 0.5,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_pattern ON solution_outcomes(pattern_id, outcome);
      CREATE INDEX IF NOT EXISTS idx_outcomes_project ON solution_outcomes(project, created_at_epoch DESC);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        content,
        content=decisions,
        content_rowid=id,
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS decisions_fts_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_fts_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_fts_au AFTER UPDATE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
        INSERT INTO decisions_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    db.exec("INSERT OR IGNORE INTO decisions_fts(rowid, content) SELECT id, content FROM decisions");
  } catch {
  }
  try {
    if (hasTable(db, "artifacts")) {
      if (!hasColumn(db, "artifacts", "retrieval_count"))
        db.exec("ALTER TABLE artifacts ADD COLUMN retrieval_count INTEGER DEFAULT 0");
      if (!hasColumn(db, "artifacts", "success_count"))
        db.exec("ALTER TABLE artifacts ADD COLUMN success_count INTEGER DEFAULT 0");
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_index (
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        last_indexed_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        ast_hash TEXT,
        symbols TEXT,
        call_graph TEXT,
        imports TEXT,
        exports TEXT,
        embedding BLOB,
        PRIMARY KEY (project, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_code_index_project
        ON code_index(project, last_indexed_epoch DESC);
    `);
  } catch {
  }
}
function migrateV12toV13(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS critical_rules (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        variants TEXT,
        source TEXT NOT NULL CHECK (source IN ('author', 'system-promoted')),
        drift_risk TEXT NOT NULL CHECK (drift_risk IN ('safety', 'working-method', 'style')),
        domain_tags TEXT,
        base_ttl INTEGER NOT NULL,
        current_ttl INTEGER,
        last_injected_turn INTEGER,
        injection_count INTEGER DEFAULT 0,
        violation_count INTEGER DEFAULT 0,
        compliance_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_critical_rules_project_source
        ON critical_rules(project, source);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_critical_rules_dedup
        ON critical_rules(project, rule_text);
    `);
  } catch {
  }
}
function migrateV13toV14(db) {
  try {
    if (!hasColumn(db, "sessions", "extraction_cursor")) {
      db.exec("ALTER TABLE sessions ADD COLUMN extraction_cursor INTEGER");
    }
  } catch {
  }
  try {
    if (!hasColumn(db, "experience_patterns", "needs_reembed")) {
      db.exec("ALTER TABLE experience_patterns ADD COLUMN needs_reembed INTEGER NOT NULL DEFAULT 0");
    }
  } catch {
  }
}
function migrateV14toV15(db) {
  const loaded = loadSqliteVec(db);
  if (!loaded) {
    return;
  }
  const tables = [
    "vec_artifacts",
    "vec_patterns",
    "vec_threads",
    "vec_journal",
    "vec_conversations",
    "vec_transcript_chunks_v6"
  ];
  for (const table of tables) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[1024])`);
    } catch {
    }
  }
}
function migrateV15toV16(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_curated_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'mental_model', 'workspace_map', 'shipped',
        'reframe', 'constraint', 'preference'
      )),
      content TEXT NOT NULL,
      tags TEXT,
      supersedes_id INTEGER REFERENCES project_curated_context(id),
      curator TEXT NOT NULL CHECK(curator IN ('agent', 'angel')),
      trust_tier INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'superseded', 'proposed', 'archived')),
      source_session_id TEXT,
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_pcc_project_status
      ON project_curated_context(project, status);
    CREATE INDEX IF NOT EXISTS idx_pcc_project_type
      ON project_curated_context(project, type, status);
  `);
}
function migrateV16toV17(db) {
  applyV17DDL(db);
}
function migrateV17toV18(db) {
  db.exec(SHAPE_VOCABULARY_SCHEMA);
}
function migrateV18toV19(db) {
  db.exec(POINTER_RECALL_SCHEMA);
}
function migrateV19toV20(db) {
  if (!hasTable(db, "telemetry")) {
    return true;
  }
  if (!hasColumn(db, "telemetry", "event_kind")) {
    return true;
  }
  if (telemetryAcceptsRerankerFallback(db)) {
    return true;
  }
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v19;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
    db.exec(TELEMETRY_SCHEMA);
    db.exec(`
      INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
      SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
      FROM telemetry_v19;
    `);
    db.exec(`DROP TABLE telemetry_v19;`);
  });
  tx();
  return true;
}
function telemetryAcceptsRerankerFallback(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'reranker_fallback'");
}
function migrateV20toV21(db) {
  if (!hasTable(db, "telemetry")) {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    return true;
  }
  if (!hasColumn(db, "telemetry", "event_kind")) {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    return true;
  }
  if (hasTable(db, "artifact_task_pattern") && telemetryAcceptsCrossProjectEnums(db)) {
    return true;
  }
  const tx = db.transaction(() => {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    if (!telemetryAcceptsCrossProjectEnums(db)) {
      db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v20;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
      db.exec(TELEMETRY_SCHEMA);
      db.exec(`
        INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
        SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
        FROM telemetry_v20;
      `);
      db.exec(`DROP TABLE telemetry_v20;`);
    }
  });
  tx();
  return true;
}
function telemetryAcceptsCrossProjectEnums(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  if (!row?.sql) return false;
  return row.sql.includes("'cross_project_ambiguous'") && row.sql.includes("'cross_project_query_expansion'");
}
function migrateV21toV22(db) {
  if (hasTable(db, "retrieval_log") && hasTable(db, "session_flag")) {
    return true;
  }
  db.exec(SCHEMA_V22);
  return true;
}
function migrateV22toV23(db) {
  if (hasTable(db, "policy_weights")) {
    db.exec("DROP TABLE IF EXISTS policy_weights");
  }
  if (hasTable(db, "artifacts") && hasColumn(db, "artifacts", "q_value")) {
    try {
      db.exec("ALTER TABLE artifacts DROP COLUMN q_value");
    } catch {
    }
  }
  return true;
}
function migrateV23toV24(db) {
  const legacyOldTables = [
    "learnings_old",
    "decisions_old",
    "experience_patterns_old",
    "angel_opinions_old",
    "critical_rules_old",
    "project_curated_context_old"
  ];
  for (const tbl of legacyOldTables) {
    db.exec(`DROP TABLE IF EXISTS ${tbl}`);
  }
  return true;
}
function migrateV24toV25(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      ts_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      turn_number INTEGER,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
      parent_event_id INTEGER REFERENCES episodic_events(id),
      content_hash TEXT NOT NULL,
      metadata_json TEXT,
      schema_version SMALLINT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_epev_session_turn_ts ON episodic_events(session_id, turn_number, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_project_ts     ON episodic_events(project, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_provenance     ON episodic_events(provenance);
    CREATE INDEX IF NOT EXISTS idx_epev_parent         ON episodic_events(parent_event_id);
  `);
  if (hasTable(db, "telemetry") && hasColumn(db, "telemetry", "event_kind") && !telemetryAcceptsEpisodicWriteFailure(db)) {
    const tx = db.transaction(() => {
      db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v24;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
      db.exec(TELEMETRY_SCHEMA);
      db.exec(`
        INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
        SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
        FROM telemetry_v24;
      `);
      db.exec(`DROP TABLE telemetry_v24;`);
    });
    tx();
  }
  return true;
}
function telemetryAcceptsEpisodicWriteFailure(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'episodic_write_failure'");
}
function migrateV25toV26(db) {
  if (hasTable(db, "episodic_index_error_fingerprint")) {
    return false;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_index_error_fingerprint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shingle_hash TEXT NOT NULL,
      episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
      ts_epoch INTEGER NOT NULL,
      project TEXT NOT NULL,
      corpus_origin TEXT NOT NULL CHECK (corpus_origin IN ('phase1_organic','v4_backfill')),
      schema_version SMALLINT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_epev_efp_shingle      ON episodic_index_error_fingerprint(shingle_hash);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_event        ON episodic_index_error_fingerprint(episode_event_id);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_project_ts   ON episodic_index_error_fingerprint(project, ts_epoch);
  `);
  return true;
}
function migrateV26toV27(db) {
  if (!hasTable(db, "episodic_index_error_fingerprint")) return false;
  const sqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='episodic_index_error_fingerprint'"
  ).get();
  const sql = sqlRow?.sql ?? "";
  if (sql.includes("phase1_organic_pre_phase2_close")) return false;
  db.exec(`
    ALTER TABLE episodic_index_error_fingerprint RENAME TO _v26_episodic_index_error_fingerprint;

    CREATE TABLE episodic_index_error_fingerprint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shingle_hash TEXT NOT NULL,
      episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
      ts_epoch INTEGER NOT NULL,
      project TEXT NOT NULL,
      corpus_origin TEXT NOT NULL CHECK (corpus_origin IN ('v4_backfill','phase1_organic_pre_phase2_close','phase1_organic_post_phase2_close')),
      schema_version SMALLINT NOT NULL DEFAULT 1
    );

    INSERT INTO episodic_index_error_fingerprint (id, shingle_hash, episode_event_id, ts_epoch, project, corpus_origin, schema_version)
      SELECT
        id,
        shingle_hash,
        episode_event_id,
        ts_epoch,
        project,
        CASE corpus_origin
          WHEN 'phase1_organic' THEN 'phase1_organic_pre_phase2_close'
          ELSE corpus_origin
        END,
        schema_version
      FROM _v26_episodic_index_error_fingerprint;

    DROP TABLE _v26_episodic_index_error_fingerprint;

    CREATE INDEX IF NOT EXISTS idx_epev_efp_shingle    ON episodic_index_error_fingerprint(shingle_hash);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_event      ON episodic_index_error_fingerprint(episode_event_id);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_project_ts ON episodic_index_error_fingerprint(project, ts_epoch);
  `);
  return true;
}
function migrateV27toV28(_db) {
  return true;
}
function migrateV28toV29(db) {
  const hasCursor = hasTable(db, "episode_boundary_cursor");
  const sessionsColsRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get();
  const sessionsSql = sessionsColsRow?.sql ?? "";
  const hasHeartbeatCol = sessionsSql.includes("last_heartbeat_ts");
  const hasJsonlCol = sessionsSql.includes("last_jsonl_write_ts");
  if (hasCursor && hasHeartbeatCol && hasJsonlCol) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_boundary_cursor (
      project                       TEXT    NOT NULL,
      session_id                    TEXT    NOT NULL,
      last_processed_jsonl_offset   INTEGER NOT NULL DEFAULT 0,
      last_processed_event_ts_epoch INTEGER NOT NULL DEFAULT 0,
      last_close_event_id           INTEGER,
      PRIMARY KEY (project, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ebc_session
      ON episode_boundary_cursor(session_id);
    CREATE INDEX IF NOT EXISTS idx_ebc_close_event
      ON episode_boundary_cursor(last_close_event_id) WHERE last_close_event_id IS NOT NULL;
  `);
  if (!hasHeartbeatCol) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN last_heartbeat_ts INTEGER`);
    } catch {
    }
  }
  if (!hasJsonlCol) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN last_jsonl_write_ts INTEGER`);
    } catch {
    }
  }
  return true;
}
function migrateV29toV30(db) {
  const learningsMeta = db.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name='learnings' AND type IN ('table','view')"
  ).get();
  if (!learningsMeta) return false;
  if (learningsMeta.type === "view") return false;
  const learningsSql = learningsMeta.sql ?? "";
  const hasProvenanceCol = learningsSql.includes("provenance");
  if (hasProvenanceCol) return false;
  db.exec(
    `ALTER TABLE learnings
       ADD COLUMN provenance TEXT NOT NULL DEFAULT 'organic'
         CHECK (provenance IN ('organic','injected','tool_result','environmental'))`
  );
  db.exec(`UPDATE learnings SET provenance = 'organic' WHERE provenance IS NULL`);
  return true;
}
function migrateV30toV31(db) {
  const learningsMeta = db.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name='learnings' AND type IN ('table','view')"
  ).get();
  if (!learningsMeta) return false;
  if (learningsMeta.type === "table") return false;
  const viewSql = learningsMeta.sql ?? "";
  if (/\bprovenance\b/i.test(viewSql)) return false;
  db.exec(`
    DROP TRIGGER IF EXISTS learnings_instead_insert;
    DROP TRIGGER IF EXISTS learnings_instead_update;
    DROP TRIGGER IF EXISTS learnings_instead_delete;
    DROP VIEW IF EXISTS learnings;
  `);
  const artifactProjectCol = hasColumn(db, "artifact", "project") ? "project" : "project_id";
  const artifactUpdatedCol = hasColumn(db, "artifact", "updated_at_epoch_ms") ? "updated_at_epoch_ms" : "updated_at_epoch";
  const artifactCreatedCol = hasColumn(db, "artifact", "created_at_epoch_ms") ? "created_at_epoch_ms" : "created_at_epoch";
  db.exec(`
    CREATE VIEW learnings AS
    SELECT
      CAST((SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = 'learnings' AND m.new_uuid = artifact.id) AS INTEGER) AS id,
      CAST(artifact.${artifactProjectCol} AS TEXT) AS project,
      CAST(json_extract(artifact.data, '$.agent_id') AS TEXT) AS agent_id,
      CAST(json_extract(artifact.data, '$.fingerprint') AS TEXT) AS fingerprint,
      artifact.body AS content,
      CAST(json_extract(artifact.data, '$.promotion_count') AS INTEGER) AS promotion_count,
      CAST(json_extract(artifact.data, '$.first_seen_epoch') AS INTEGER) AS first_seen_epoch,
      CAST(json_extract(artifact.data, '$.first_seen_epoch') AS INTEGER) AS first_seen_epoch_ms,
      CAST(json_extract(artifact.data, '$.last_promoted_epoch') AS INTEGER) AS last_promoted_epoch,
      CAST(json_extract(artifact.data, '$.last_promoted_epoch') AS INTEGER) AS last_promoted_epoch_ms,
      CAST(artifact.${artifactUpdatedCol} / 1000 AS INTEGER) AS updated_at_epoch,
      artifact.${artifactUpdatedCol} AS updated_at_epoch_ms,
      COALESCE(CAST(json_extract(artifact.data, '$.provenance') AS TEXT), 'organic') AS provenance
    FROM artifact
    WHERE kind = 'learning'
    ORDER BY ${artifactCreatedCol}
  `);
  db.exec(`
    CREATE TRIGGER learnings_instead_insert INSTEAD OF INSERT ON learnings
    BEGIN
      SELECT CASE
        WHEN NEW.provenance IS NOT NULL
         AND NEW.provenance NOT IN ('organic','injected','tool_result','environmental')
        THEN RAISE(ABORT, 'CHECK constraint failed: learnings.provenance')
      END;
      INSERT INTO artifact(
        id, kind, title, body, scope, status, confidence,
        ${artifactCreatedCol}, ${artifactUpdatedCol}, session_id, ${artifactProjectCol}, data
      ) VALUES (
        lower(hex(randomblob(16))),
        'learning',
        substr(NEW.content, 1, 80),
        NEW.content,
        'project',
        'active',
        NULL,
        COALESCE(NEW.first_seen_epoch * 1000, unixepoch() * 1000),
        COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000),
        NULL,
        NEW.project,
        json_object(
          'agent_id', NEW.agent_id,
          'fingerprint', NEW.fingerprint,
          'promotion_count', COALESCE(NEW.promotion_count, 1),
          'first_seen_epoch', COALESCE(NEW.first_seen_epoch, unixepoch()),
          'last_promoted_epoch', COALESCE(NEW.last_promoted_epoch, unixepoch()),
          'provenance', COALESCE(NEW.provenance, 'organic')
        )
      );
      INSERT INTO legacy_id_map(legacy_table, legacy_id, new_uuid)
      VALUES (
        'learnings',
        COALESCE(
          NEW.id,
          (SELECT COALESCE(MAX(legacy_id), 0) + 1 FROM legacy_id_map WHERE legacy_table = 'learnings')
        ),
        (SELECT id FROM artifact WHERE rowid = last_insert_rowid())
      );
    END
  `);
  db.exec(`
    CREATE TRIGGER learnings_instead_update INSTEAD OF UPDATE ON learnings
    BEGIN
      SELECT CASE
        WHEN NEW.provenance IS NOT NULL
         AND NEW.provenance NOT IN ('organic','injected','tool_result','environmental')
        THEN RAISE(ABORT, 'CHECK constraint failed: learnings.provenance')
      END;
      UPDATE artifact SET
        ${artifactProjectCol} = NEW.project,
        body = NEW.content,
        data = json_set(json_set(json_set(json_set(json_set(json_set(data,
          '$.agent_id', NEW.agent_id),
          '$.fingerprint', NEW.fingerprint),
          '$.promotion_count', NEW.promotion_count),
          '$.first_seen_epoch', COALESCE(NEW.first_seen_epoch_ms, NEW.first_seen_epoch, json_extract(data, '$.first_seen_epoch'))),
          '$.last_promoted_epoch', COALESCE(NEW.last_promoted_epoch_ms, NEW.last_promoted_epoch, json_extract(data, '$.last_promoted_epoch'))),
          '$.provenance', COALESCE(NEW.provenance, json_extract(data, '$.provenance'), 'organic')
        ),
        ${artifactUpdatedCol} = COALESCE(NEW.updated_at_epoch_ms, unixepoch() * 1000)
      WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id);
    END
  `);
  db.exec(`
    CREATE TRIGGER learnings_instead_delete INSTEAD OF DELETE ON learnings
    BEGIN
      DELETE FROM artifact
        WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id)
          AND kind = 'learning';
      DELETE FROM legacy_id_map
        WHERE legacy_table = 'learnings' AND legacy_id = OLD.id;
    END
  `);
  db.exec(`
    UPDATE artifact
    SET data = json_set(data, '$.provenance', 'organic')
    WHERE kind = 'learning'
      AND json_extract(data, '$.provenance') IS NULL
  `);
  return true;
}
function migrateV32toV33(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      mental_model TEXT,
      open_questions TEXT,
      reframes TEXT,
      tools_introduced TEXT,
      decisions_not_made TEXT,
      posture_context TEXT,
      degraded INTEGER NOT NULL DEFAULT 0,
      degraded_reason TEXT,
      degraded_model TEXT,
      created_at_epoch_ms INTEGER NOT NULL,
      re_extracted_at_epoch_ms INTEGER,
      UNIQUE(session_id, project)
    );
    CREATE INDEX IF NOT EXISTS idx_session_highlights_project_created
      ON session_highlights (project, created_at_epoch_ms DESC);
  `);
  return true;
}
function migrateV31toV32(db) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_chunk_v6'"
  ).get();
  if (exists) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_chunk_v6 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      sub_index INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
      provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
      body TEXT NOT NULL,
      created_at_epoch_ms INTEGER NOT NULL,
      wrapper_redacted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_chunk_v6_session_turn
      ON transcript_chunk_v6(session_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_transcript_chunk_v6_project_created
      ON transcript_chunk_v6(project_id, created_at_epoch_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_transcript_chunk_v6_session_turn_role_sub
      ON transcript_chunk_v6(session_id, turn_index, role, sub_index);
  `);
  const loaded = loadSqliteVec(db);
  if (loaded) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_transcript_chunks_v6 USING vec0(embedding float[1024])`);
    } catch {
    }
  }
  return true;
}
function migrateV33toV34(db) {
  if (hasColumn(db, "artifact", "project_id")) {
    db.exec(`ALTER TABLE artifact RENAME COLUMN project_id TO project`);
  }
  const tcHasProjectId = db.pragma("table_info(transcript_chunk_v6)").some((c) => c.name === "project_id");
  if (tcHasProjectId) {
    db.exec(`ALTER TABLE transcript_chunk_v6 RENAME COLUMN project_id TO project`);
  }
  const idxRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='index'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all();
  for (const r of idxRows) {
    if (r.sql && /project_id/i.test(r.sql)) {
      db.exec(`DROP INDEX IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/project_id/g, "project"));
    }
  }
  const trgRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all();
  for (const r of trgRows) {
    if (r.sql && /project_id/i.test(r.sql)) {
      db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/project_id/g, "project"));
    }
  }
  const viewRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='view'`
  ).all();
  for (const v of viewRows) {
    if (v.sql && /project_id/i.test(v.sql)) {
      const vTriggers = db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`
      ).all(v.name);
      for (const t of vTriggers) {
        db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
      }
      db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
      db.exec(v.sql.replace(/\bartifact\.project_id\b/g, "artifact.project"));
      for (const t of vTriggers) {
        if (t.sql) {
          db.exec(t.sql.replace(/project_id/g, "project"));
        }
      }
    }
  }
  db.pragma("user_version = 34");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
      version        INTEGER PRIMARY KEY,
      applied_at_epoch INTEGER
    )`);
    const svCols = db.pragma("table_info(schema_versions)").map((c) => c.name);
    if (svCols.includes("applied_at_epoch")) {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (34, unixepoch())`);
    } else {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (34)`);
    }
  } catch {
  }
}
function migrateV34toV35(db) {
  const renames = [
    // sessions
    { table: "sessions", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "sessions", oldCol: "ended_at_epoch", newCol: "ended_at_epoch_ms", scale: true },
    // observations
    { table: "observations", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    { table: "observations", oldCol: "last_accessed_at_epoch", newCol: "last_accessed_at_epoch_ms", scale: true },
    { table: "observations", oldCol: "deleted_at_epoch", newCol: "deleted_at_epoch_ms", scale: true },
    // learnings
    { table: "learnings", oldCol: "first_seen_epoch", newCol: "first_seen_epoch_ms", scale: true },
    { table: "learnings", oldCol: "last_promoted_epoch", newCol: "last_promoted_epoch_ms", scale: true },
    { table: "learnings", oldCol: "updated_at_epoch", newCol: "updated_at_epoch_ms", scale: true },
    // checkpoint_meta
    { table: "checkpoint_meta", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "checkpoint_meta", oldCol: "updated_at_epoch", newCol: "updated_at_epoch_ms", scale: true },
    // artifact (V17) — values are already milliseconds (runner multiplies by 1000 at write time)
    // scale=false: WHERE guard still applied via UPDATE below as a safety net
    { table: "artifact", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: false },
    { table: "artifact", oldCol: "updated_at_epoch", newCol: "updated_at_epoch_ms", scale: false },
    // episodic_events
    { table: "episodic_events", oldCol: "ts_epoch", newCol: "ts_epoch_ms", scale: true },
    // telemetry
    { table: "telemetry", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // pressure_scores
    { table: "pressure_scores", oldCol: "last_touched_epoch", newCol: "last_touched_epoch_ms", scale: true },
    // schema_versions
    { table: "schema_versions", oldCol: "applied_at_epoch", newCol: "applied_at_epoch_ms", scale: true },
    // session_messages
    { table: "session_messages", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "session_messages", oldCol: "delivered_at_epoch", newCol: "delivered_at_epoch_ms", scale: true },
    // session_signals
    { table: "session_signals", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "session_signals", oldCol: "expires_at_epoch", newCol: "expires_at_epoch_ms", scale: true },
    { table: "session_signals", oldCol: "cleared_at_epoch", newCol: "cleared_at_epoch_ms", scale: true },
    // retrieval_events
    { table: "retrieval_events", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // kind_registry (V17 DDL table — passive kind tracking)
    { table: "kind_registry", oldCol: "first_seen_epoch", newCol: "first_seen_epoch_ms", scale: true },
    { table: "kind_registry", oldCol: "last_seen_epoch", newCol: "last_seen_epoch_ms", scale: true },
    // session_journal (SCHEMA_V3 table)
    { table: "session_journal", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // conversation_turns (V10 table)
    { table: "conversation_turns", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // artifacts (SCHEMA_V3 table — legacy pre-V17 knowledge artifact store)
    { table: "artifacts", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    { table: "artifacts", oldCol: "last_materialized_epoch", newCol: "last_materialized_epoch_ms", scale: true }
  ];
  const tx = db.transaction(() => {
    for (const r of renames) {
      if (!hasTable(db, r.table)) continue;
      if (!hasColumn(db, r.table, r.oldCol)) continue;
      if (hasColumn(db, r.table, r.newCol)) continue;
      db.exec(`ALTER TABLE "${r.table}" RENAME COLUMN "${r.oldCol}" TO "${r.newCol}"`);
      if (r.scale) {
        db.exec(
          `UPDATE "${r.table}"
           SET "${r.newCol}" = "${r.newCol}" * 1000
           WHERE "${r.newCol}" IS NOT NULL AND "${r.newCol}" < 1000000000000`
        );
      }
    }
    const affectedTables = [...new Set(renames.map((r) => r.table))];
    const oldNewMap = {};
    for (const r of renames) oldNewMap[r.oldCol] = r.newCol;
    const idxRows = db.prepare(
      `SELECT name, sql, tbl_name FROM sqlite_master
       WHERE type='index'
         AND tbl_name IN (${affectedTables.map(() => "?").join(",")})`
    ).all(...affectedTables);
    for (const idx of idxRows) {
      if (!idx.sql) continue;
      let newSql = idx.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g");
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        try {
          db.exec(newSql);
        } catch {
        }
      }
    }
    const trgRows = db.prepare(
      `SELECT name, sql, tbl_name FROM sqlite_master
       WHERE type='trigger'
         AND tbl_name IN (${affectedTables.map(() => "?").join(",")})`
    ).all(...affectedTables);
    for (const trg of trgRows) {
      if (!trg.sql) continue;
      let newSql = trg.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g");
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP TRIGGER IF EXISTS "${trg.name}"`);
        try {
          db.exec(newSql);
        } catch {
        }
      }
    }
    const viewRows = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='view'`
    ).all();
    for (const v of viewRows) {
      if (!v.sql) continue;
      let newSql = v.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g");
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
          changed = true;
        }
      }
      if (changed) {
        const vTriggers = db.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`
        ).all(v.name);
        for (const t of vTriggers) {
          db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
        }
        db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
        try {
          db.exec(newSql);
          for (const t of vTriggers) {
            if (t.sql) {
              let tSql = t.sql;
              for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
                tSql = tSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
              }
              try {
                db.exec(tSql);
              } catch {
              }
            }
          }
        } catch {
        }
      }
    }
    db.pragma("user_version = 35");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
        version          INTEGER PRIMARY KEY,
        applied_at_epoch_ms INTEGER
      )`);
      const svCols = db.pragma("table_info(schema_versions)").map((c) => c.name);
      if (svCols.includes("applied_at_epoch_ms")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch_ms) VALUES (35, unixepoch() * 1000)`);
      } else if (svCols.includes("applied_at_epoch")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (35, unixepoch())`);
      } else {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (35)`);
      }
    } catch {
    }
  });
  tx();
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function telemetryAcceptsSessionEndAction(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'session_end_action'");
}
function migrateV35toV36(db) {
  if (!hasTable(db, "telemetry")) return true;
  if (!hasColumn(db, "telemetry", "event_kind")) return true;
  if (telemetryAcceptsSessionEndAction(db)) return true;
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v35;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
    db.exec(TELEMETRY_SCHEMA);
    db.exec(`
      INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
      SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
      FROM telemetry_v35;
    `);
    db.exec(`DROP TABLE telemetry_v35;`);
    db.pragma("user_version = 36");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (36)`);
    } catch {
    }
  });
  tx();
  return true;
}
function migrateV36toV37(db) {
  if (hasTable(db, "artifact_id_map")) {
    return true;
  }
  const tx = db.transaction(() => {
    if (hasTable(db, "artifacts") && !hasColumn(db, "artifacts", "read_only")) {
      db.exec(`ALTER TABLE artifacts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_id_map (
        legacy_id          INTEGER PRIMARY KEY,
        v17_id             TEXT NOT NULL UNIQUE,
        mapped_at_epoch_ms INTEGER NOT NULL,
        project            TEXT NOT NULL,
        FOREIGN KEY (v17_id) REFERENCES artifact(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_v17
        ON artifact_id_map(v17_id);
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_project
        ON artifact_id_map(project);
    `);
    loadSqliteVec(db);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifact_v17
          USING vec0(embedding float[1024]);
      `);
    } catch {
    }
    if (hasTable(db, "kind_registry")) {
      const krCols = new Set(
        db.pragma("table_info(kind_registry)").map((c) => c.name)
      );
      if (!krCols.has("first_seen_epoch_ms")) {
        db.exec("ALTER TABLE kind_registry ADD COLUMN first_seen_epoch_ms INTEGER NOT NULL DEFAULT 0");
        if (krCols.has("first_seen_epoch")) {
          db.exec("UPDATE kind_registry SET first_seen_epoch_ms = first_seen_epoch * 1000 WHERE first_seen_epoch_ms = 0");
        }
      }
      if (!krCols.has("last_seen_epoch_ms")) {
        db.exec("ALTER TABLE kind_registry ADD COLUMN last_seen_epoch_ms INTEGER NOT NULL DEFAULT 0");
        if (krCols.has("last_seen_epoch")) {
          db.exec("UPDATE kind_registry SET last_seen_epoch_ms = last_seen_epoch * 1000 WHERE last_seen_epoch_ms = 0");
        }
      }
    }
    _populateArtifactIdMapInTransaction(db);
    _extendTelemetryForV37(db);
    db.pragma("user_version = 37");
    try {
      const svCols = db.pragma("table_info(schema_versions)").map((c) => c.name);
      if (svCols.includes("applied_at_epoch_ms")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch_ms) VALUES (37, unixepoch() * 1000)`);
      } else if (svCols.includes("applied_at_epoch")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (37, unixepoch())`);
      } else {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (37)`);
      }
    } catch {
    }
  });
  tx();
  return true;
}
function _populateArtifactIdMapInTransaction(db) {
  if (!hasTable(db, "artifacts")) return;
  if (!hasTable(db, "artifact")) return;
  const { createHash } = require("node:crypto");
  const stateToStatus = (state) => {
    switch (state) {
      case "fresh":
        return "active";
      case "packed":
        return "stale";
      case "materialized":
        return "superseded";
      default:
        return "active";
    }
  };
  const artCols = new Set(db.pragma("table_info(artifacts)").map((c) => c.name));
  const colOrNull = (col) => artCols.has(col) ? col : `NULL AS ${col}`;
  const selectSql = `
    SELECT id, session_id, project,
           ${artCols.has("artifact_type") ? "artifact_type" : "'observation' AS artifact_type"},
           ${colOrNull("artifact_ref")},
           ${artCols.has("summary") ? "summary" : "'' AS summary"},
           ${colOrNull("content")},
           ${artCols.has("state") ? "state" : "'fresh' AS state"},
           ${artCols.has("ttl") ? "ttl" : "3 AS ttl"},
           ${artCols.has("importance") ? "importance" : "3 AS importance"},
           ${artCols.has("retrieval_score") ? "retrieval_score" : "1.0 AS retrieval_score"},
           ${artCols.has("timestamp_epoch_ms") ? "timestamp_epoch_ms" : "(unixepoch() * 1000) AS timestamp_epoch_ms"},
           ${colOrNull("last_materialized_epoch_ms")},
           ${artCols.has("activation_score") ? "activation_score" : "1.0 AS activation_score"},
           ${colOrNull("superseded_by")},
           ${colOrNull("valid_until")},
           ${artCols.has("confidence") ? "confidence" : "1.0 AS confidence"},
           ${artCols.has("novelty_score") ? "novelty_score" : "0.5 AS novelty_score"}
    FROM artifacts
  `;
  const legacyRows = db.prepare(selectSql).all();
  const insertArtifactStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact(
      id, kind, title, body, scope, status, confidence,
      created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMapStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
    VALUES (?, ?, ?, ?)
  `);
  const now = Date.now();
  for (const row of legacyRows) {
    const contentHash = createHash("sha256").update(row.summary + (row.content ?? "")).digest("hex");
    const v17Id = createHash("sha256").update(`${row.id}:${row.project}:${row.timestamp_epoch_ms}:${contentHash}`).digest("hex").slice(0, 32);
    const v17Confidence = row.importance / 5;
    const v17Status = stateToStatus(row.state);
    const dataSidecar = {
      migrated_from_legacy_id: row.id,
      ttl: row.ttl,
      retrieval_score: row.retrieval_score,
      activation_score: row.activation_score,
      novelty_score: row.novelty_score
    };
    if (row.artifact_ref !== null) dataSidecar["artifact_ref"] = row.artifact_ref;
    if (row.last_materialized_epoch_ms !== null) dataSidecar["last_materialized_epoch"] = row.last_materialized_epoch_ms;
    if (row.valid_until !== null) dataSidecar["valid_until"] = row.valid_until;
    insertArtifactStmt.run(
      v17Id,
      row.artifact_type,
      // kind = artifact_type (same values)
      row.summary,
      // title = summary
      row.content ?? "",
      // body = content (COALESCE empty string)
      "project",
      // scope = 'project' (all artifacts are project-scoped)
      v17Status,
      v17Confidence,
      row.timestamp_epoch_ms,
      row.timestamp_epoch_ms,
      // updated_at_epoch_ms same as created initially
      row.session_id,
      row.project,
      JSON.stringify(dataSidecar)
    );
    insertMapStmt.run(row.id, v17Id, now, row.project);
  }
  if (artCols.has("superseded_by")) {
    db.exec(`
      UPDATE artifact
      SET supersedes_id = (
        SELECT m_superseded.v17_id
        FROM artifact_id_map m_superseding
        INNER JOIN artifacts leg_superseded ON leg_superseded.superseded_by = m_superseding.legacy_id
        INNER JOIN artifact_id_map m_superseded ON m_superseded.legacy_id = leg_superseded.id
        WHERE m_superseding.v17_id = artifact.id
        LIMIT 1
      )
      WHERE artifact.supersedes_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM artifact_id_map m_superseding
          INNER JOIN artifacts leg_superseded ON leg_superseded.superseded_by = m_superseding.legacy_id
          WHERE m_superseding.v17_id = artifact.id
        )
    `);
  }
}
var TELEMETRY_SCHEMA_V37 = `
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
    'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
    'reranker_fallback',
    'cross_project_ambiguous', 'cross_project_query_expansion',
    'episodic_write_failure',
    'signal_reread_after_surface', 'signal_retrieval_fallback',
    'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
    'handoff_parse_failed',
    'session_end_action',
    're_vectorize_failed'
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  latency_ms REAL,
  timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  adapter TEXT DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch_ms DESC);
`;
function _telemetryAcceptsReVectorizeFailed(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'re_vectorize_failed'");
}
function _extendTelemetryForV37(db) {
  if (!hasTable(db, "telemetry")) return;
  if (!hasColumn(db, "telemetry", "event_kind")) return;
  if (_telemetryAcceptsReVectorizeFailed(db)) return;
  db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v36_for_v37;`);
  db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
  db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
  db.exec(TELEMETRY_SCHEMA_V37);
  db.exec(`
    INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
    SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
    FROM telemetry_v36_for_v37;
  `);
  db.exec(`DROP TABLE telemetry_v36_for_v37;`);
}
function _installReadOnlyTriggers(db) {
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_legacy_insert_post_cutover
        BEFORE INSERT ON artifacts
        WHEN (SELECT COUNT(*) FROM artifacts WHERE read_only = 1 LIMIT 1) > 0
        BEGIN
          SELECT RAISE(ABORT,
            'legacy artifacts table is read-only post-cutover; write to V17 artifact table instead');
        END;
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_legacy_update_post_cutover
        BEFORE UPDATE ON artifacts
        WHEN OLD.read_only = 1
        BEGIN
          SELECT RAISE(ABORT,
            'legacy artifacts table is read-only post-cutover; write to V17 artifact table instead');
        END;
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_legacy_delete_post_cutover
        BEFORE DELETE ON artifacts
        WHEN OLD.read_only = 1
        BEGIN
          SELECT RAISE(ABORT,
            'legacy artifacts table is read-only post-cutover; write to V17 artifact table instead');
        END;
    `);
  } catch {
  }
}
function migrateV37toV38(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS soft_link (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        src_artifact_id     TEXT NOT NULL,
        dst_artifact_id     TEXT NOT NULL,
        type                TEXT NOT NULL CHECK (type IN ('supersedes', 'promoted_to', 'extracted_from', 'references')),
        confidence          REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
        created_by_session  TEXT NOT NULL,
        created_at_epoch_ms INTEGER NOT NULL,
        project             TEXT NOT NULL,
        data                TEXT,
        FOREIGN KEY (src_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        FOREIGN KEY (dst_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        UNIQUE (src_artifact_id, dst_artifact_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_soft_link_src     ON soft_link(src_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_soft_link_dst     ON soft_link(dst_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_soft_link_project ON soft_link(project);

      CREATE TABLE IF NOT EXISTS hard_link (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        src_artifact_id         TEXT NOT NULL,
        dst_artifact_id         TEXT NOT NULL,
        type                    TEXT NOT NULL CHECK (type IN ('triggered_by', 'evidence_for', 'contradicts')),
        proposed_confidence     REAL NOT NULL CHECK (proposed_confidence >= 0.0 AND proposed_confidence <= 1.0),
        proposed_by_session     TEXT NOT NULL,
        proposed_at_epoch_ms    INTEGER NOT NULL,
        confirmed_by_session    TEXT,
        confirmed_at_epoch_ms   INTEGER,
        rejected_by_session     TEXT,
        rejected_at_epoch_ms    INTEGER,
        decay_count             INTEGER NOT NULL DEFAULT 0 CHECK (decay_count >= 0),
        proposer_rationale      TEXT,
        project                 TEXT NOT NULL,
        FOREIGN KEY (src_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        FOREIGN KEY (dst_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        UNIQUE (src_artifact_id, dst_artifact_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_hard_link_src     ON hard_link(src_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_hard_link_dst     ON hard_link(dst_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_hard_link_project ON hard_link(project);
    `);
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_hard_link_pending
          ON hard_link(project, confirmed_by_session)
          WHERE confirmed_by_session IS NULL;
      `);
    } catch {
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS hard_link_history (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        hard_link_id        INTEGER NOT NULL,
        action              TEXT NOT NULL CHECK (action IN ('proposed', 'confirmed', 'rejected', 'decayed')),
        session_id          TEXT NOT NULL,
        action_at_epoch_ms  INTEGER NOT NULL,
        details             TEXT,
        FOREIGN KEY (hard_link_id) REFERENCES hard_link(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_hard_link_history_link ON hard_link_history(hard_link_id);
    `);
    db.pragma("user_version = 38");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (38)`);
    } catch {
    }
  });
  tx();
}
function migrateV38toV39(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS handoff_refresh_state (
        session_id            TEXT PRIMARY KEY,
        project               TEXT NOT NULL,
        last_refresh_epoch_ms INTEGER NOT NULL,
        refresh_count         INTEGER NOT NULL DEFAULT 0,
        updated_at_epoch_ms   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_handoff_refresh_session
        ON handoff_refresh_state(session_id);
    `);
    const hasTelemetry = db.prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='telemetry'"
    ).get();
    if (hasTelemetry.cnt > 0) {
      let alreadyExtended = false;
      try {
        db.prepare(`INSERT INTO telemetry(session_id, event_kind, detail, adapter) VALUES('_probe','chr_boundary_detected','{}','probe')`).run();
        db.prepare(`DELETE FROM telemetry WHERE session_id='_probe' AND event_kind='chr_boundary_detected'`).run();
        alreadyExtended = true;
      } catch {
      }
      if (!alreadyExtended) {
        db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v38;`);
        db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
        db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
        db.exec(`
          CREATE TABLE IF NOT EXISTS telemetry (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id          TEXT NOT NULL,
            event_kind          TEXT NOT NULL CHECK (event_kind IN (
              'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
              'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
              'reranker_fallback',
              'cross_project_ambiguous', 'cross_project_query_expansion',
              'episodic_write_failure',
              'signal_reread_after_surface', 'signal_retrieval_fallback',
              'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
              'handoff_parse_failed',
              'session_end_action',
              're_vectorize_failed',
              'soft_link_skipped', 'soft_link_write_failed',
              'chr_boundary_detected', 'chr_no_boundary', 'chr_classify_failed', 'chr_throttled'
            )),
            detail              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
            latency_ms          REAL,
            timestamp_epoch_ms  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            adapter             TEXT DEFAULT 'unknown'
          );
          CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch_ms DESC);
          CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch_ms DESC);
        `);
        db.exec(`
          INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
          SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
          FROM telemetry_v38
          WHERE event_kind IN (
            'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
            'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
            'reranker_fallback',
            'cross_project_ambiguous', 'cross_project_query_expansion',
            'episodic_write_failure',
            'signal_reread_after_surface', 'signal_retrieval_fallback',
            'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
            'handoff_parse_failed',
            'session_end_action',
            're_vectorize_failed',
            'soft_link_skipped', 'soft_link_write_failed',
            'chr_boundary_detected', 'chr_no_boundary', 'chr_classify_failed', 'chr_throttled'
          );
        `);
        db.exec(`DROP TABLE telemetry_v38;`);
      }
    }
    db.pragma("user_version = 39");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (39)`);
    } catch {
    }
  });
  tx();
}
function migrateV39toV40(db) {
  const backfillTargets = [
    ["checkpoint_meta", "created_at_epoch_ms"],
    ["checkpoint_meta", "updated_at_epoch_ms"],
    ["sessions", "created_at_epoch_ms"],
    ["observations", "timestamp_epoch_ms"],
    ["retrieval_events", "timestamp_epoch_ms"],
    ["session_signals", "created_at_epoch_ms"],
    ["session_messages", "created_at_epoch_ms"],
    ["episodic_events", "ts_epoch_ms"]
  ];
  const ddlTables = [
    "checkpoint_meta",
    "sessions",
    "observations",
    "retrieval_events",
    "session_signals",
    "session_messages",
    "episodic_events"
  ];
  const tx = db.transaction(() => {
    for (const [table, col] of backfillTargets) {
      if (!hasTable(db, table) || !hasColumn(db, table, col)) continue;
      db.exec(
        `UPDATE ${table} SET ${col} = ${col} * 1000 WHERE ${col} > 0 AND ${col} < 100000000000`
      );
    }
    if (hasTable(db, "kind_registry")) {
      db.exec(`DROP TRIGGER IF EXISTS artifact_register_kind`);
      if (hasTable(db, "artifact")) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS artifact_register_kind
                 AFTER INSERT ON artifact
                 BEGIN
                   INSERT INTO kind_registry(kind, first_seen_epoch_ms, last_seen_epoch_ms)
                     VALUES (NEW.kind, NEW.created_at_epoch_ms, NEW.created_at_epoch_ms)
                   ON CONFLICT(kind) DO UPDATE SET last_seen_epoch_ms = excluded.last_seen_epoch_ms;
                 END`);
      }
      if (hasColumn(db, "kind_registry", "first_seen_epoch")) {
        try {
          db.exec("ALTER TABLE kind_registry DROP COLUMN first_seen_epoch");
        } catch {
        }
      }
      if (hasColumn(db, "kind_registry", "last_seen_epoch")) {
        try {
          db.exec("ALTER TABLE kind_registry DROP COLUMN last_seen_epoch");
        } catch {
        }
      }
    }
  });
  tx();
  const anyDb = db;
  if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(true);
  db.pragma("writable_schema = 1");
  try {
    const stmt = db.prepare(
      `UPDATE sqlite_master
       SET sql = replace(sql, 'DEFAULT (unixepoch())', 'DEFAULT (unixepoch() * 1000)')
       WHERE type = 'table' AND name = ?`
    );
    for (const t of ddlTables) {
      if (hasTable(db, t)) stmt.run(t);
    }
  } finally {
    db.pragma("writable_schema = 0");
    if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(false);
  }
  db.pragma("user_version = 40");
  try {
    db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (40)`);
  } catch {
  }
}
function migrateV40toV41(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chr_pending_classifications (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id             TEXT NOT NULL,
        project                TEXT NOT NULL,
        user_text              TEXT,
        assistant_text         TEXT NOT NULL,
        source_turn_uuid       TEXT NOT NULL,
        enqueued_at_epoch_ms   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        processed_at_epoch_ms  INTEGER,
        attempt_count          INTEGER NOT NULL DEFAULT 0,
        last_error             TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chr_pending_unprocessed
        ON chr_pending_classifications(processed_at_epoch_ms, enqueued_at_epoch_ms)
        WHERE processed_at_epoch_ms IS NULL;
      CREATE INDEX IF NOT EXISTS idx_chr_pending_session
        ON chr_pending_classifications(session_id, enqueued_at_epoch_ms DESC);
    `);
    db.pragma("user_version = 41");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (41)`);
    } catch {
    }
  });
  tx();
}
function migrateV41toV42(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_termination (
        session_id              TEXT PRIMARY KEY,
        project                 TEXT NOT NULL,
        ended_at_epoch_ms       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        end_reason              TEXT NOT NULL
          CHECK (end_reason IN ('endsession', 'crash', 'compact', 'idle_close', 'unknown')),
        last_user_directive     TEXT,
        last_assistant_text     TEXT,
        observation_count       INTEGER NOT NULL DEFAULT 0,
        recorded_at_epoch_ms    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_session_termination_recent
        ON session_termination(ended_at_epoch_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_session_termination_project_recent
        ON session_termination(project, ended_at_epoch_ms DESC);
    `);
    db.pragma("user_version = 42");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (42)`);
    } catch {
    }
  });
  tx();
}
function migrateV42toV43(db) {
  const renames = [
    ["thread_state", "updated_at_epoch", "updated_at_epoch_ms"],
    ["checkpoint_tracking", "last_checkpoint_epoch", "last_checkpoint_epoch_ms"],
    ["checkpoint_tracking", "updated_at_epoch", "updated_at_epoch_ms"],
    ["checkpoint_tracking", "last_tick_epoch", "last_tick_epoch_ms"],
    ["verified_facts", "created_at_epoch", "created_at_epoch_ms"],
    ["file_leases", "granted_at_epoch", "granted_at_epoch_ms"],
    ["artifact_claims", "claimed_at_epoch", "claimed_at_epoch_ms"],
    ["session_events", "timestamp_epoch", "timestamp_epoch_ms"],
    ["session_journal", "timestamp_epoch", "timestamp_epoch_ms"],
    ["artifact_links", "created_at_epoch", "created_at_epoch_ms"],
    ["artifact_links", "valid_at_epoch", "valid_at_epoch_ms"],
    ["artifact_links", "invalid_at_epoch", "invalid_at_epoch_ms"],
    ["capability_boundaries", "last_updated_epoch", "last_updated_epoch_ms"],
    ["conversation_turns", "timestamp_epoch", "timestamp_epoch_ms"],
    ["artifact_access_log", "timestamp_epoch", "timestamp_epoch_ms"],
    ["knowledge_gaps", "detected_at_epoch", "detected_at_epoch_ms"],
    ["knowledge_gaps", "resolved_at_epoch", "resolved_at_epoch_ms"],
    ["temporal_profile", "updated_at_epoch", "updated_at_epoch_ms"],
    ["action_transitions", "last_epoch", "last_epoch_ms"],
    ["solution_outcomes", "created_at_epoch", "created_at_epoch_ms"],
    ["entity_aliases", "created_at_epoch", "created_at_epoch_ms"],
    ["artifacts", "timestamp_epoch", "timestamp_epoch_ms"],
    ["artifacts", "last_materialized_epoch", "last_materialized_epoch_ms"],
    ["code_index", "last_indexed_epoch", "last_indexed_epoch_ms"]
  ];
  let restoreReadOnlyTriggers = false;
  try {
    if (hasTable(db, "artifacts") && hasColumn(db, "artifacts", "read_only")) {
      const flipped = db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE read_only = 1`).get().n;
      if (flipped > 0) {
        db.exec(`DROP TRIGGER IF EXISTS prevent_legacy_insert_post_cutover`);
        db.exec(`DROP TRIGGER IF EXISTS prevent_legacy_update_post_cutover`);
        db.exec(`DROP TRIGGER IF EXISTS prevent_legacy_delete_post_cutover`);
        restoreReadOnlyTriggers = true;
      }
    }
  } catch {
  }
  try {
    const tx = db.transaction(() => {
      for (const [table, oldCol, newCol] of renames) {
        if (!hasTable(db, table)) continue;
        if (hasColumn(db, table, oldCol) && !hasColumn(db, table, newCol)) {
          db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${oldCol}" TO "${newCol}"`);
          db.exec(
            `UPDATE "${table}" SET "${newCol}" = "${newCol}" * 1000 WHERE "${newCol}" > 0 AND "${newCol}" < 100000000000`
          );
        }
      }
    });
    tx();
  } finally {
    if (restoreReadOnlyTriggers) {
      try {
        _installReadOnlyTriggers(db);
      } catch {
      }
    }
  }
  const tables = [...new Set(renames.map(([t]) => t))];
  const anyDb = db;
  if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(true);
  db.pragma("writable_schema = 1");
  try {
    const stmt = db.prepare(
      `UPDATE sqlite_master
       SET sql = replace(sql, 'DEFAULT (unixepoch())', 'DEFAULT (unixepoch() * 1000)')
       WHERE type = 'table' AND name = ?`
    );
    for (const t of tables) {
      if (hasTable(db, t)) stmt.run(t);
    }
  } finally {
    db.pragma("writable_schema = 0");
    if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(false);
  }
  db.pragma("user_version = 43");
  try {
    db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (43)`);
  } catch {
  }
}
function migrateV43toV44(db) {
  if (!hasTable(db, "session_termination")) {
    return;
  }
  if (!hasColumn(db, "session_termination", "open_blockers")) {
    db.exec(`ALTER TABLE session_termination ADD COLUMN open_blockers TEXT`);
  }
  db.pragma("user_version = 44");
  try {
    db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (44)`);
  } catch {
  }
}

// src/core/migrations.ts
init_sqlite_vec_loader();
var TARGET_USER_VERSION = 44;
function runMigrations(db) {
  const row = db.pragma("user_version");
  let version = row[0]?.user_version ?? 0;
  const TARGET_VERSION = TARGET_USER_VERSION;
  if (version >= TARGET_VERSION) {
    loadSqliteVec(db);
    return;
  }
  const migrations = [
    [2, () => {
    }],
    [3, () => migrateV3toV4(db)],
    [4, () => migrateV4toV5(db)],
    [5, () => migrateV5toV6(db)],
    [6, () => migrateV6toV7(db)],
    [7, () => migrateV7toV8(db)],
    [8, () => migrateV8toV9(db)],
    [9, () => migrateV9toV10(db)],
    [10, () => migrateV10toV11(db)],
    [11, () => migrateV11toV12(db)],
    [12, () => migrateV12toV13(db)],
    [13, () => migrateV13toV14(db)],
    [14, () => migrateV14toV15(db)],
    [15, () => migrateV15toV16(db)],
    [16, () => migrateV16toV17(db)],
    [17, () => migrateV17toV18(db)],
    [18, () => migrateV18toV19(db)],
    [19, () => {
      migrateV19toV20(db);
    }],
    [20, () => {
      migrateV20toV21(db);
    }],
    [21, () => {
      migrateV21toV22(db);
    }],
    [22, () => {
      migrateV22toV23(db);
    }],
    [23, () => {
      migrateV23toV24(db);
    }],
    [24, () => {
      migrateV24toV25(db);
    }],
    [25, () => {
      migrateV25toV26(db);
    }],
    [26, () => {
      migrateV26toV27(db);
    }],
    [27, () => {
      migrateV27toV28(db);
    }],
    [28, () => {
      migrateV28toV29(db);
    }],
    [29, () => {
      migrateV29toV30(db);
    }],
    [30, () => {
      migrateV30toV31(db);
    }],
    [31, () => {
      migrateV31toV32(db);
    }],
    [32, () => {
      migrateV32toV33(db);
    }],
    [33, () => {
      migrateV33toV34(db);
    }],
    [34, () => {
      migrateV34toV35(db);
    }],
    [35, () => {
      migrateV35toV36(db);
    }],
    [36, () => {
      migrateV36toV37(db);
    }],
    [37, () => {
      migrateV37toV38(db);
    }],
    [38, () => {
      migrateV38toV39(db);
    }],
    [39, () => {
      migrateV39toV40(db);
    }],
    [40, () => {
      migrateV40toV41(db);
    }],
    [41, () => {
      migrateV41toV42(db);
    }],
    [42, () => {
      migrateV42toV43(db);
    }],
    [43, () => {
      migrateV43toV44(db);
    }]
  ];
  if (version === 0) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    if (!tables.includes("observations")) return;
    migrateV1toV2(db);
    if (!migrateV2toV3(db)) {
      db.pragma("user_version = 2");
      return;
    }
    version = 3;
  } else if (version === 1) {
    migrateV1toV2(db);
    if (!migrateV2toV3(db)) {
      db.pragma("user_version = 2");
      return;
    }
    version = 3;
  } else if (version === 2) {
    if (!migrateV2toV3(db)) return;
    version = 3;
  }
  let lastSuccessfulVersion = version;
  for (const [fromVersion, migrate] of migrations) {
    if (version <= fromVersion && fromVersion >= 3) {
      try {
        migrate();
        lastSuccessfulVersion = fromVersion + 1;
      } catch (err) {
        if (process.env.DEBUG_MIGRATIONS) {
          console.error(`[migrations] step [${fromVersion}\u2192${fromVersion + 1}] failed:`, err);
        }
        break;
      }
    }
  }
  db.pragma(`user_version = ${lastSuccessfulVersion >= TARGET_VERSION ? TARGET_VERSION : lastSuccessfulVersion}`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  extractDirectivesFromSession,
  runMigrations
});
