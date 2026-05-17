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

---

## Appendix — exhaustive linear sweep (added 2026-05-18, redo)

The first version of this audit was pattern-grep spot-check. The operator caught the scope cut and asked for an exhaustive read. Following pass covers **every** `\bawait\b` in `src/angel/` (43 files) and `src/embeddings/` (6 files) plus `src/adapters/shared/lifecycle.ts` (hook-path awaits not covered by Angel's heartbeat watchdog).

### Outermost guarantee (the catch-all)

**`heartbeat.ts:1815` is the load-bearing bound.** Every Angel tick runs via:

```ts
const result = await Promise.race([
  heartbeatTick(ctx),
  new Promise<TickResult>((resolve) => setTimeout(() => { /* skip */ }, 5 * 60 * 1000)),
]);
```

**Any await inside `heartbeatTick` is implicitly bounded to 5 minutes.** Even a deeply-nested unbounded await — discovered or future — cannot dark the heartbeat loop. This is the substrate-level kill switch.

That said, individual awaits are *also* bounded where possible (defense in depth). The per-call bounds matter for caller-side correctness; the outer watchdog matters for substrate liveness.

### Per-file findings (full surface, ~130 awaits total)

**`heartbeat.ts` (~45 awaits)** — all inside the watchdog-protected `heartbeatTick`.
- 11 are `await import(...)` — dynamic module loads (instant, no IO).
- 4 are direct `await fetch(...)` against localhost — every one has `AbortSignal.timeout(3000)`.
- 6 are supervisor calls (`ensureRunning`, `checkHealth`, `start`) — internally bounded by `waitForHealth` deadlines.
- 24 are `await <ts function>(db, ...)` — better-sqlite3 sync under the hood OR delegations to wrappers that bound IO (`generate`, `embedText`, supervisor ops).
- Notable: line 371, 419 — `withTimeout` Promise.race wrapping `extractDirectivesFromSession` and `classifySessionDomains` at PHASE2_AWAIT_TIMEOUT_MS=60_000 (belt-and-suspenders even though the inner generate() is already bounded).
- Notable: line 1386 — `await Promise.allSettled(...)` — fan-out, bounded by each individual promise's own timeout.

**`claude-subprocess.ts` (6 awaits)** — wrapper bounds itself.
- L65 semaphore wait: bounded by slot-holders (each 90s + 2s grace = max). Worst-case sustained-load wait: 4 × 92 = ~6min. Slow, not hung.
- L289 subprocess exit: `Promise<number|null>` raced with `setTimeout(timeoutMs)` → kill SIGTERM then SIGKILL.
- L350 `acquireSlot` from public entry: same bound as L65.
- L358 `invokeClaudeOnce`: bounded by L289 race.
- L441 retry sleep: `setTimeout(BASE_BACKOFF_MS * 2^attempt)`, max ~12s.
- L458 text-shim delegation: inherits.

**`llama-client.ts` (4 awaits)** — every fetch has `AbortSignal.timeout(timeoutMs ?? 120_000)`.

**`llama-server-supervisor.ts` (10 awaits)** — `checkHealth` uses `controller.abort()` setTimeout race; `waitForHealth` loops have explicit `deadline = startMs + maxWaitMs`; `await new Promise(setTimeout)` backoffs bounded by `Math.min(delay, remaining)`.

**`reranker-supervisor.ts` (8 awaits)** — same shape as llama-server-supervisor.

**`generation-backend.ts` (1 await)** — `await callLocalLLM(...)` in revert path, inherits llama-client's 120s.

**`last-session-synthesis.ts` (1 await)** — `await generate(...)` bounded.

**`handoff-decision-watcher.ts` (1 await)** — `await classifyDecisionBoundary(...)` bounded.

**`chr-async.ts` (1 await)** — `await classifyTurnAsDecisionBoundary(...)` bounded; called only from heartbeat (covered by watchdog).

**`highlights-extractor.ts` (5 awaits)** — generate() bounded; the direct Anthropic API call at L301 uses https.request with `timeout: 60_000` + `req.destroy()` on timeout.

**`entity-summarizer.ts` (1 await)** — `await generate(...)` bounded.

**`consolidator.ts` (10 awaits)** — generate() bounded + embedText bounded; cluster-building is sync DB.

**`curated-context-extractor.ts` (1 await)** — `await generate(...)` bounded.

**`domain-classifier.ts` (1 await)** — `await generate(...)` bounded.

**`transcript-chunker.ts` (2 awaits)** — `await generate(...)` bounded; `await segmentViaLLM` inherits.

**`user-profile-sync.ts` (9 awaits)** — `fsp.readdir` / `fsp.stat` / `fsp.readFile`. On local FS these are fast. **One identified residual risk**: if `~/.claude/projects/` is on a network mount and the mount stalls, individual fs ops have no inherent timeout. Mitigation: this function is only called from heartbeat (line 936), so the 5-min outer watchdog bounds it. For non-heartbeat callers (none today), the fs ops would be unbounded. **Flagging as a known limitation, not a bug.**

**`boundary/boundary-detector.ts` (18 awaits)** — all dynamic imports + delegations to bounded extractors (`extractDirectivesFromSession`, `classifySessionDomains`, `extractHighlightsForSession`, `runHardLinkProposer`). Called from heartbeat → covered.

**`boundary/jsonl-watcher.ts` (1 await)** — `await watcher.close()` — fs watcher close, near-instant.

**`index.ts` (4 awaits)** — Angel startup: `ensureCollections` (sqlite-vec, sync), `rerankerSupervisor.start()` / `llamaServerSupervisor.start()` (bounded by `waitForHealth` deadlines), `checkLlamaServerHealth()` (bounded). The shutdown `jsonlWatcher.close()` is near-instant.

**`pointer-recall.ts` (0 awaits)** — sync only.

**`embeddings/templates.ts` (1 await)** — `await provider.embedBatch(...)` → fetchJsonWithTimeout bounded.

**`embeddings/embedding-provider.ts` (7 awaits)** — every fetch is `fetchJsonWithTimeout` with 3-30s explicit timeoutMs.

**`embeddings/embed-pipeline.ts` (18 awaits)** — all delegate to embedding-provider (bounded) + sync DB upserts.

**`embeddings/qdrant-client.ts` (0 awaits)** — sync delegations to sqlite-vec backend.

**`lifecycle.ts` (15+ hook-path awaits)** — checked separately because these run from CC hooks, not from Angel's watchdog-protected loop:
- All `await embedArtifact(...)` / `await embedText(...)` calls — bounded by embedding-provider timeouts.
- All `await writeCheckpoint(...)` — sync DB.
- All `await captureDecisions(...)` / `await buildDecisionClassifier(...)` — sync DB + bounded embed.
- All `await import(...)` — dynamic imports, instant.

### Identified residual risks (documented, not bugs)

1. **claude-subprocess semaphore wait** can stack to ~6min under sustained load (4 concurrent slots × 90s wrapper bound). By design — concurrency control prevents burst rate-limit hits on MAX. Acceptable.

2. **user-profile-sync.ts fs ops** have no inherent per-op timeout. Bounded today only via the heartbeat watchdog. If a future caller invokes this from a non-heartbeat context AND the user's CC projects directory is on a stalled network mount, individual `fsp.readdir`/`stat`/`readFile` could hang. Mitigation: add per-op `Promise.race` with a small (10s) timeout if anyone moves this off the heartbeat path. Filed as a follow-up consideration.

### Verdict (revised after exhaustive sweep)

**No outstanding unbounded external-IO awaits in Angel + embeddings + hook lifecycle.** The 2026-05-14 Phase 13.1 W2 hang vector (unbounded `await callLocalLLM` against stalled Ollama) is closed at three layers: backend swap (Phase 14-08 generate() default to Claude subprocess), per-await timeouts (`PHASE2_AWAIT_TIMEOUT_MS=60_000` Promise.race), and outer tick watchdog (heartbeat.ts:1815, 5min). All three would need to fail simultaneously for the hang to recur.

Two residual risks documented above are not currently active hang vectors but would matter under future changes.

