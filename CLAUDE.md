# Claudex v3 — Project CLAUDE.md

## What This Is

Persistent memory system giving LLMs context continuity across sessions. One shared SQLite DB (`~/.claudex/db/claudex.db`), three runtime components:

- **CC Hooks** (`src/adapters/cc-hooks/`): 6 ephemeral Node.js scripts per hook. DB-only state. Never call CC's API from a hook (deadlock).
- **Angel** (`src/angel/`): Persistent guardian process. Extracts patterns from completed sessions via LLM (CliProxy → Claude CLI → Ollama fallback). Auto-spawned by session-start.
- **OpenClaw Bridge** (`src/adapters/openclaw-bridge/`): Long-lived process, in-memory + DB state.
- **Shared lifecycle** (`src/adapters/shared/lifecycle.ts`): Composable functions all adapters call.

V10 schema, 23 tables. Dual-write: SQLite (truth) + Qdrant (5 collections, acceleration). Embeddings via Ollama nomic-embed-text (768→384 Matryoshka truncation).

## Hook/Angel Responsibility Split

**Hooks** (fast, mechanical, ephemeral): decision capture, thread tracking, conversation turn storage, checkpoint, retrieval feedback, activation decay, pattern verification + helpful scoring, session summary.

**Angel** (reflective, holistic, persistent): pattern extraction from full conversations, domain classification, session monitoring, idle warnings, inter-session messaging via session_messages table.

## CC Hook Payload Truth

| Hook | Field | CC sends | Code assumed (wrong) |
|---|---|---|---|
| PostToolUse | tool output | `tool_response` | `tool_output` |
| UserPromptSubmit | user text | `prompt` | `user_prompt` |
| Stop | assistant text | `last_assistant_message` | `stop_assistant_turn` |

Never assume field names. Capture real payloads to verify.

## Critical Safety Rules

- **CC hook deadlock**: Never call CC's CLIProxyAPI from a hook. Use Ollama instead.
- **Fire-and-forget dies**: CC hooks are ephemeral — always await. Only Angel/OpenClaw can fire-and-forget.
- **MAX subscription**: Never ask about API costs. OAuth auth at `~/.claude/.credentials.json`.

Intelligence systems, quality gates, and gotchas are in Claudex DB — surfaced by hybrid retrieval when relevant.

## Build & Test

```bash
bun run build          # esbuild, ~60ms, outputs to dist/
bun run test           # vitest, 92 files, 1714 tests
bun run setup          # register hooks
node dist/angel/index.cjs  # start Angel (auto-spawned by session-start)
```

**Do NOT use `bun test`** — invokes Bun's native runner, not Vitest.

## File Structure

```
src/
  angel/            # Persistent guardian: heartbeat, pattern-extractor, session-monitor, message-sender, memory-monitor
  core/             # schema (V10 DDL), migrations, storage, artifacts, observations, journal,
                    # session-events, hybrid-retrieval, file-ingester, pressure, thread, stmt-cache
  extraction/       # Per-tool extractors + redaction + quality gates
  intelligence/     # experience-patterns, correction-detection, capability-tracker, batch-reflection,
                    # thread-tracker, topic-shift, decision-capture, retrieval-feedback, insight-extractor,
                    # cross-session-coordination, enrichment, trigger-engine
  embeddings/       # Ollama client, Qdrant client (5 collections), embed pipeline
  assembly/         # assembler (full + regular), sections, worker-context, token-estimator
  checkpoint/       # ULID writer (DB-first), 3-hop loader, inject renderer
  mcp/              # MCP recall server (search, recall, store, events) — 3-channel RRF
  adapters/cc-hooks/  # 6 hook entry points + infrastructure
  adapters/shared/    # lifecycle.ts — composable functions
```

## Reference Documents

- `ARCHITECTURE.md` — READ WHEN: reviewing design, checking schema DDL
- `context/specs/ANGEL_SYSTEM.md` — READ WHEN: understanding Angel design
- `context/specs/SEMANTIC_INTELLIGENCE_UPGRADE.md` — READ WHEN: V9 features (6 parts, 31 changes)
