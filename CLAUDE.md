# Claudex v3 — Project CLAUDE.md

## What This Is

Persistent memory system giving LLMs context continuity across sessions. One shared SQLite DB (`~/.claudex/db/claudex.db`), three runtime components:

- **CC Hooks** (`src/adapters/cc-hooks/`): 6 ephemeral Node.js scripts per hook. DB-only state. Never call CC's API from a hook (deadlock).
- **Angel** (`src/angel/`): Persistent guardian process. Extracts patterns, forms opinions (CARA), monitors sessions, sends messages, indexes cross-agent sessions. Auto-spawned by session-start.
- **OpenClaw Bridge** (`src/adapters/openclaw-bridge/`): Long-lived process, in-memory + DB state.
- **Shared lifecycle** (`src/adapters/shared/lifecycle.ts`): Composable functions all adapters call.

V12 schema, 27+ tables. Dual-write: SQLite (truth) + Qdrant (5 collections, acceleration). Embeddings via Ollama nomic-embed-text (768→384 Matryoshka) + snowflake-arctic-embed2 (1024d for reranking).

## Benchmarks

- **LoCoMo: #1** (90.8%) — local 16B model, beats Hindsight (89.6%), Backboard (90.0%)
- **LongMemEval: #2** (90.6%) — 0.8pp behind Hindsight's 91.4% (they use Gemini-3 Pro)

## Hook/Angel Responsibility Split

**Hooks** (fast, mechanical, ephemeral): decision capture, thread tracking, conversation turn storage, checkpoint, retrieval feedback, activation decay, pattern verification + helpful scoring, session summary, stigmergic signal creation (wip on file edits), cross-session message delivery, auto-session naming, outcome inference, contradiction detection.

**Angel** (reflective, holistic, persistent): pattern extraction from full conversations, CARA opinion formation, domain classification, session monitoring, idle warnings, inter-session messaging, entity summary generation, cross-agent session indexing (Codex/Gemini/Aider), pattern promotion to always-inject, retention sweep with observation pruning.

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
- **Cross-encoder is bi-encoder**: The "cross-encoder" reranking uses snowflake-arctic-embed2 via /api/embed (bi-encoder cosine similarity), NOT a true neural cross-encoder. Do not claim otherwise.

Intelligence systems, quality gates, and gotchas are in Claudex DB — surfaced by hybrid retrieval when relevant.

## Build & Test

```bash
bun run build          # esbuild, ~70ms, outputs to dist/
bun run test           # vitest, 100 files, 2020 tests
bun run setup          # register hooks
node dist/angel/index.cjs  # start Angel (auto-spawned by session-start)
```

**Do NOT use `bun test`** — invokes Bun's native runner, not Vitest.

## File Structure

```
src/
  angel/            # Persistent guardian: heartbeat, pattern-extractor, session-monitor,
                    # message-sender, memory-monitor, entity-summarizer, proactive-curator,
                    # cara-reasoning (opinion network), retention-sweep
  core/             # schema (V12 DDL), migrations, storage, artifacts, observations, journal,
                    # session-events, hybrid-retrieval (5-channel RRF), file-ingester, pressure,
                    # thread, stmt-cache, session-signals, session-discovery, session-transfer
  extraction/       # Per-tool extractors + redaction + quality gates
  intelligence/     # experience-patterns (exponential decay, Q-value RL), correction-detection,
                    # capability-tracker, batch-reflection, thread-tracker, topic-shift,
                    # decision-capture, retrieval-feedback, insight-extractor,
                    # cross-session-coordination, enrichment, trigger-engine,
                    # outcome-tracker, contradiction-detector, entity-resolver,
                    # retrieval-rl (Q-value + UCB), cross-agent-indexer, canonical-session-ir
  embeddings/       # Ollama client, Qdrant client (5 collections), embed pipeline
  assembly/         # assembler (full + regular), sections, worker-context, token-estimator
  checkpoint/       # ULID writer (DB-first), 3-hop loader, inject renderer
  mcp/              # MCP recall server — 6 tools: search, recall, store, events, message, session
  adapters/cc-hooks/  # 6 hook entry points + infrastructure
  adapters/shared/    # lifecycle.ts — composable functions
```

## V12 Tables (new this session)

| Table | Purpose |
|-------|---------|
| `session_signals` | Stigmergic coordination (wip, failure, danger, claim, discovery) |
| `angel_opinions` | CARA reasoning (opinions with confidence dynamics) |
| `solution_outcomes` | Outcome tracking (success/failure/partial per pattern) |
| `entity_aliases` | Entity name canonicalization |
| + `sessions.name` | Human-friendly session naming (project-sN-pid) |
| + `sessions.transferred_to` | Session transfer tracking |
| + `session_messages.sender_type` | Angel vs session vs system messages |
| + `session_messages.request_id` | Request/response linking |

## Reference Documents

- `ARCHITECTURE.md` — READ WHEN: reviewing design, checking schema DDL
- `context/specs/ANGEL_SYSTEM.md` — READ WHEN: understanding Angel design
- `context/specs/SESSION_COMMUNICATION.md` — READ WHEN: cross-session messaging, signals, transfer
- `context/specs/HINDSIGHT_UPGRADES.md` — READ WHEN: retrieval upgrades (5 Hindsight-inspired)
- `context/specs/ROADMAP_GAPS.md` — READ WHEN: competitive gaps and implementation roadmap
- `context/research/COMPETITIVE_POSITIONING_2026-03-28.md` — READ WHEN: benchmarks, competitor comparison
