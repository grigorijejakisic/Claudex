# Claudex v4 — Project CLAUDE.md

> **v4.0 is internal infrastructure. v4.1 = Distribution will make it installable by strangers.**

## What This Is

Persistent memory system giving LLMs context continuity across sessions. One shared SQLite DB (`~/.claudex/db/claudex.db`), three runtime components:

- **CC Hooks** (`src/adapters/cc-hooks/`): 26 ephemeral Node.js scripts (7 substantive hooks + 19 event recorders). DB-only state. Never call CC's API from a hook (deadlock).
- **Angel** (`src/angel/`): Persistent guardian process. Extracts patterns, forms opinions (CARA), monitors sessions, sends messages, supervises the Python reranker (via `RerankerSupervisor`), indexes cross-agent sessions. Auto-spawned by session-start.
- **OpenClaw Bridge** (`src/adapters/openclaw-bridge/`): Long-lived process, in-memory + DB state.
- **Shared lifecycle** (`src/adapters/shared/lifecycle.ts`): Composable functions all adapters call.

V15 schema, 33 tables. Single-store design: SQLite is both source of truth AND vector store. Vector search uses sqlite-vec (vec0 virtual tables) embedded in the same `~/.claudex/db/claudex.db` file. Embeddings via Ollama snowflake-arctic-embed2 (1024d). Reranking via BGE-reranker-v2-m3 cross-encoder (Python service on port 7439, supervised by Angel's `RerankerSupervisor` with bounded restart + log capture). Qdrant was removed in session 47 — see `context/specs/SQLITE_VEC_MIGRATION.md`.

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
- **Hook deadlock**: Never call CC's CLIProxyAPI from a hook — use Ollama instead.
- **Fire-and-forget**: Always await in hooks. Only Angel/OpenClaw can fire-and-forget.

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
