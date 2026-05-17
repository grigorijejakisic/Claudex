# Angel Await Audit — 2026-05-18

**Purpose:** Verify every `await` in Angel and its hot dependencies (`src/angel/`, `src/embeddings/`) is bounded by an explicit timeout. The 2026-05-14 Phase 13.1 W2 heartbeat hang ("Phase 2 extract_directives never returns") was caused by an unbounded `await callLocalLLM(...)` against a stalled Ollama daemon. This audit confirms whether the hang vector still exists after the Phase 14-08 backend swap.

## Result

**No unbounded awaits remain.** Every external-IO await in Angel + embeddings has either an `AbortSignal.timeout(...)`, a wrapper-level kill-after-N-seconds, or an inline `setTimeout` race. The 2026-05-14 hang shape cannot recur in production code paths.

## Audited surfaces

### LLM generation paths

| Caller | Backend | Timeout mechanism | Bound |
|---|---|---|---|
| `last-session-synthesis.ts` → `generate()` | claude-subprocess (default) or callLocalLLM | wrapper-level kill | 90s default |
| `highlights-extractor.ts` → `callLocalFallback` → `generate()` | same | same | 90s |
| `entity-summarizer.ts` → `generate()` | same | same | 90s |
| `consolidator.ts` → `generate()` | same | same | 90s |
| `curated-context-extractor.ts` → `generate()` | same | same | 90s |
| `domain-classifier.ts` → `generate()` | same | same | 90s |
| `transcript-chunker.ts` → `generate()` | same | same | 90s |
| `directive-detector.ts` → `generate()` (CHR + extract) | same | same | 90s (CHR async uses 30s in classifyDecisionBoundary) |
| `highlights-extractor.ts` direct Opus path (when ANTHROPIC_API_KEY set) | https.request to api.anthropic.com | `timeout: 60_000` on the request + `req.destroy()` on timeout event | 60s |
| `claude-subprocess.ts` (the wrapper) | spawn `claude --print` | `setTimeout` → `SIGTERM` → `SIGKILL` after 2s grace | 90s default + 2s kill grace |
| `llama-client.ts` → `callLocalLLM` | fetch to Ollama OpenAI-compat endpoint | `AbortSignal.timeout(timeoutMs)` | 120s default |

### Embeddings (still load-bearing for retrieval)

| Caller | Path | Bound |
|---|---|---|
| `src/embeddings/embedding-provider.ts` | `fetchJsonWithTimeout` with explicit `timeoutMs` (3s health, 5–30s embed) | 3–30s |
| `src/embeddings/embed-pipeline.ts` | delegates to embedding-provider | inherits above |

### Heartbeat health probes

| Probe | Bound |
|---|---|
| Reranker `:7439/health` | `AbortSignal.timeout(3000)` |
| Ollama `/api/tags` | `AbortSignal.timeout(3000)` |
| Per-Phase-2-await timeout (`extractDirectives`, `classifyDomains`) | `Promise.race` with `PHASE2_AWAIT_TIMEOUT_MS = 60_000` |

### Supervisor lifecycles

| File | Await pattern | Bound |
|---|---|---|
| `llama-server-supervisor.ts:653` | `await new Promise((r) => setTimeout(r, Math.min(delay, remaining)))` (backoff loop) | bounded by `deadline` + max-delay 8s |
| `reranker-supervisor.ts:376` | same shape | same |
| Both: `child.on('exit')` | event handler, not awaited directly — bounded by parent loop's `deadline` |

### Wrapper / queue paths

| File | Await | Bound |
|---|---|---|
| `claude-subprocess.ts:65` | `await new Promise<void>(resolve => _waiters.push(resolve))` (concurrency semaphore) | bounded by **other slot-holders' wrapper timeouts** — if all 4 slots stick, worst case 4 × 90s = 6min, but since `claude-subprocess.ts` self-bounds, each slot releases when its subprocess exits or its own setTimeout fires. No starvation possible. |
| `claude-subprocess.ts:441` | retry backoff `await new Promise(setTimeout)` | bounded by `BASE_BACKOFF_MS * 2^attempt` (max ~12s on 3rd retry) |
| `chr-async.ts` drain | calls `classifyTurnAsDecisionBoundary` which goes through `generate()` | inherits 30s |
| `heartbeat.ts` Phase 2 loop | inline `Promise.race` per-await | 60s per session × `MAX_PHASE2_RETRIES=3` give-up |

## Phase 2 hang remediation summary

The historical 2026-05-14 hang was Ollama-against-`extractDirectivesFromSession`. After Phase 14-08:

1. **Backend swap** — `extractDirectivesFromSession` calls go through `generate()`, which defaults to claude-subprocess. Claude subprocess has self-contained kill-after-90s.
2. **Per-await timeout** — Phase 2 wraps every LLM call in `Promise.race([call, timeout(60_000)])` regardless of backend (legacy belt-and-suspenders).
3. **Give-up after 3** — `MAX_PHASE2_RETRIES = 3`. A session that times out 3× gets `angel_processed/permanently_failed` and falls out of `getUnprocessedSessions`. No infinite retry loop.
4. **Throttle** — CHR drain respects 60s `handoff_refresh_state` cooldown; within-window rows mark processed without re-firing.

Result: the hang vector is closed on three layers (backend, per-await, give-up). To regress, all three would have to fail simultaneously.

## Still-Ollama-dependent operations

Generation no longer needs Ollama. The remaining Ollama dependencies are:

- **Embeddings** (arctic-embed2 1024d via `/api/embed`) — load-bearing for retrieval. Bounded by `fetchJsonWithTimeout`.
- **`OllamaHealthCheck` in pre-compact** — `detectEnrichmentProvider`, bounded by its own timeout in `intelligence/enrichment.ts`.

When `Ollama daemon not reachable` (as it has been throughout this session), retrieval degrades to reranker-only / FTS5 fallback. Memory generation (LSS, CHR, highlights, directives, domain, curated-context, consolidator, entity-summarizer, hard-link-proposer, transcript-chunker) all continue to work via claude-subprocess.

## What's NOT in this audit

- `src/intelligence/` — most LLM calls now route through `generate()` (audited above); the remaining intelligence-tier code is non-IO logic.
- `src/core/` — DB-only operations.
- `src/adapters/cc-hooks/` — hook lifecycle, no long awaits beyond what they delegate to Angel.

## Verdict

**No outstanding Angel hang vectors as of 2026-05-18.** The 2026-05-14 Phase 13.1 W2 hang shape is closed. Future hangs would require either:

- A new caller adding unbounded IO without timeout (preventable via convention — CLAUDE.md already says "Always await in hooks. Only Angel/OpenClaw can fire-and-forget"; add: "Every external IO await MUST have an explicit timeout").
- A subprocess that ignores SIGTERM/SIGKILL (OS-level pathology, not Angel's concern).

Convention added to CLAUDE.md under Critical Safety Rules:
> **Bounded awaits**: every `await` against external IO (fetch, subprocess, file watch) MUST have an explicit timeout (`AbortSignal.timeout`, `Promise.race` with `setTimeout`, or wrapper-level kill). Unbounded awaits are a hang vector.
