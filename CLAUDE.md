# Claudex v3 — Project CLAUDE.md

## What This Is

Persistent memory system giving LLMs context continuity across sessions. One shared SQLite DB (`~/.claudex/db/claudex.db`), three runtime components:

- **CC Hooks** (`src/adapters/cc-hooks/`): 6 ephemeral Node.js scripts per hook. DB-only state. Never call CC's API from a hook (deadlock).
- **Angel** (`src/angel/`): Persistent guardian process. Extracts patterns, forms opinions (CARA), monitors sessions, sends messages, indexes cross-agent sessions. Auto-spawned by session-start.
- **OpenClaw Bridge** (`src/adapters/openclaw-bridge/`): Long-lived process, in-memory + DB state.
- **Shared lifecycle** (`src/adapters/shared/lifecycle.ts`): Composable functions all adapters call.

V12 schema, 27+ tables. Dual-write: SQLite (truth) + Qdrant (5 collections, acceleration). Embeddings via Ollama nomic-embed-text (768->384 Matryoshka) + snowflake-arctic-embed2 (1024d for reranking).

## Benchmarks

- **LoCoMo: #1** (90.8%) — local 16B model, beats Hindsight (89.6%), Backboard (90.0%)
- **LongMemEval: #2** (90.6%) — 0.8pp behind Hindsight's 91.4% (they use Gemini-3 Pro)

## Critical Safety Rules

<!-- critical: drift-risk=safety, domains=api,mcp -->
- **MAX subscription**: Never ask about API costs. OAuth auth at `~/.claude/.credentials.json`.
- **Cross-encoder is bi-encoder**: snowflake-arctic-embed2 via /api/embed is a bi-encoder, NOT a true neural cross-encoder.
<!-- critical: drift-risk=safety, domains=hooks,cc-hooks -->
- **Hook deadlock**: Never call CC's CLIProxyAPI from a hook — use Ollama instead.
- **Fire-and-forget**: Always await in hooks. Only Angel/OpenClaw can fire-and-forget.

## Build & Test

```bash
bun run build          # esbuild, ~70ms, outputs to dist/
bun run test           # vitest, 100 files, 2020 tests
bun run setup          # register hooks
node dist/angel/index.cjs  # start Angel (auto-spawned by session-start)
```

**Do NOT use `bun test`** — invokes Bun's native runner, not Vitest.

Intelligence systems, quality gates, and gotchas are in Claudex DB — surfaced by hybrid retrieval when relevant. Detailed hook/angel responsibilities, schema tables, payload truth, and file structure are in `.claude/rules/` (loaded conditionally when editing relevant paths).
