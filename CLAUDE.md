# Claudex v4 — Project CLAUDE.md

> **v4.0 is internal infrastructure. v4.1 = Distribution will make it installable by strangers.**

## What This Is

Persistent memory system giving LLMs context continuity across sessions. One shared SQLite DB (`~/.claudex/db/claudex.db`), three runtime components:

- **CC Hooks** (`src/adapters/cc-hooks/`): 26 ephemeral Node.js scripts (7 substantive hooks + 19 event recorders). DB-only state. Never call CC's API from a hook (deadlock).
- **Angel** (`src/angel/`): Persistent guardian process. Extracts patterns, forms opinions (CARA), monitors sessions, sends messages, supervises the Python reranker (via `RerankerSupervisor`), indexes cross-agent sessions. Auto-spawned by session-start.
- **OpenClaw Bridge** (`src/adapters/openclaw-bridge/`): Long-lived process, in-memory + DB state.
- **Shared lifecycle** (`src/adapters/shared/lifecycle.ts`): Composable functions all adapters call.

V41 schema, 33+ tables. Single-store design: SQLite is both source of truth AND vector store. Vector search uses sqlite-vec (vec0 virtual tables) embedded in the same `~/.claudex/db/claudex.db` file. Embeddings via Ollama snowflake-arctic-embed2 (1024d). Reranking via BGE-reranker-v2-m3 cross-encoder (Python service on port 7439, supervised by Angel's `RerankerSupervisor` with bounded restart + log capture). Qdrant was removed in session 47 — see `context/specs/SQLITE_VEC_MIGRATION.md`.

## Generation Backend

LLM generation routes through `src/angel/generation-backend.ts` (the `generate()` front door). Two backends:

- **`claude` (default)**: spawns the local `claude --print` CLI as a subprocess (Phase 14-08). Uses MAX OAuth from `~/.claude/.credentials.json`. Quality: Sonnet for synthesis (LSS, highlights, entity-summarizer, consolidator, curated-context); Haiku for classification (CHR, directives, domain, hard-link-proposer, transcript-chunker). Latency ~10-15s/call but cost ≈ $0.001-0.03/call (cached prompts).
- **`ollama` (revert)**: the legacy `callLocalLLM` path against the local Ollama daemon. Stays available for emergency rollback via `CLAUDEX_GENERATION_BACKEND=ollama`. Vitest defaults to `ollama` so existing `vi.mock('llama-client')` patterns intercept without per-test backend overrides.

Embeddings (`arctic-embed2` 1024d) and reranking (BGE cross-encoder on port 7439) stay local — Anthropic ships neither. "Services down: Ollama" remains load-bearing for *retrieval* but no longer for *memory generation*.

When the wrapper spawns `claude`, it sets `CLAUDEX_GENERATION_CHILD=1` in the child env. The `wrapHook` infrastructure short-circuits every claudex hook on that env so the child claude doesn't recursively run all 26 hooks against its own ephemeral session.

## Benchmarks (archival — NOT ship gates)

These are archival v4-ship-time numbers; not used as ship gates per the v4 audit (2026-04-27). The Vesna behavioral probe suite (`bun run vesna`) and the four success criteria in `.planning/phases/11-p9-final-validation/11-V4-VALIDATION.md` are the canonical ship gate.

- **LongMemEval Oracle: 90.6%** (426/470, `deepseek-coder-v2:16b` local) — competitive with Hindsight (89.0–91.4%, GPT-4o/Gemini-3). Oracle mode — only evidence sessions ingested, not full 500-session haystack.
- **LoCoMo: 55.5%** (855/1540, `claude-sonnet-4-6`) — **known work in progress**, below published competitors. An earlier harness reported 90.8% before commit `893270d feat: benchmark analysis tooling + first honest LoCoMo results` switched to the real hybrid-retrieval pipeline. Active improvement area. **Don't cite the old 90.8% number** — it's stale and superseded.

## Critical Safety Rules

<!-- critical: drift-risk=safety, domains=api,mcp -->
- **MAX subscription**: Never ask about API costs. OAuth auth at `~/.claude/.credentials.json`.
- **Reranker is a real cross-encoder; bi-encoder is the fallback**: The primary reranker (`services/reranker.py`, BGE-reranker-v2-m3 on port 7439) is a true neural cross-encoder. The bi-encoder path (snowflake-arctic-embed2 cosine via Ollama `/api/embed`) is only used as a fallback when the cross-encoder service is unavailable.
- **Reranker is load-bearing for production retrieval (RETR-08)**: BGE-v2-m3 on port 7439 must be alive — Angel's `RerankerSupervisor` spawns and monitors it. Bi-encoder fallback is a **degraded mode**, not a transparent default. Every fallback writes one row to `telemetry` with `event_kind='reranker_fallback'` and a `detail.reason` of `unreachable`/`non_2xx`/`timeout`/`empty_response`. Session-start surfaces a `## Reranker Health` line when the 24h count is non-zero. If you see that line across multiple sessions, restart `services/reranker.py`.
<!-- critical: drift-risk=safety, domains=hooks,cc-hooks -->
- **Hook deadlock — in-process API only**: Never call CC's in-process `CLIProxyAPI` from a hook (true deadlock — same process, same event loop). *Subprocess* spawn of `claude --print` from a hook is SAFE (different OS process, no shared lifecycle — verified 2026-05-17 in a real hook context). Use `src/angel/claude-subprocess.ts` for any generation call.
- **Recursive-hook guard**: Every hook checks `process.env.CLAUDEX_GENERATION_CHILD === '1'` at entry and short-circuits before any DB / stdin work. The `callClaudeSubprocess` wrapper sets this env var on every spawn so the child claude doesn't recursively run claudex hooks against its own ephemeral session.
- **Fire-and-forget**: Always await in hooks. Only Angel/OpenClaw can fire-and-forget.
<!-- critical: drift-risk=quality, domains=ship,phase-close,review -->
- **Verified is the only kind of done.** Any ship report, phase-close summary, "all PASS" claim, or "everything landed" assertion REQUIRES `/verify` evidence in the same message — N claims / M verified / K unverified, with diff against the session-start tag, relevant tests run, and grep against the actual code for every named function/flag/file. If `/verify` is unavailable, run the equivalent steps manually and surface what was checked. Self-reported success without verification is how the 2026-05-17 v7.0.0 ship landed a stale cutover-v7 test that nobody caught until the next session. Don't repeat that. The burn: ship reports compound trust; an unverified one corrupts the substrate's record of what's working.

## Build & Test

```bash
bun run build          # esbuild, ~70ms, outputs to dist/
bun run test           # vitest, 100+ files, 3000+ tests
bun run vesna          # SC#1 ship-gate — 18/18 PASS at 100%
bun run sc3            # SC#3 ship-gate — every active project ≥80% MEMORY.md content quality
bun run setup          # register hooks
node dist/angel/index.cjs  # start Angel (auto-spawned by session-start)
```

**Do NOT use `bun test`** — invokes Bun's native runner, not Vitest.

Intelligence systems, quality gates, and gotchas are in Claudex DB — surfaced by hybrid retrieval when relevant. Detailed hook/angel responsibilities, schema tables, payload truth, and file structure are in `.claude/rules/` (loaded conditionally when editing relevant paths).
