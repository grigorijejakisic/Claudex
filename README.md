# Claudex

**Persistent memory that makes LLM agents actually remember.**

**LongMemEval Oracle 90.6%** — competitive with top published systems at 1–2 percentage points, using a local 16B model instead of GPT-4o.

```
Benchmark             Claudex   Competitors
────────────────────────────────────────────────────────────────
LongMemEval Oracle     90.6%   Hindsight 89.0–91.4%, Memori 82.0%,
                               MemMachine 84.9%, Zep 71.2%,
                               Mem0 —, OpenAI Memory 52.9%
LoCoMo (full)          55.5%   Work in progress. See benchmarks/
                               for honest harness + methodology.
```

**Honesty notes:**
- **LongMemEval mode is oracle**: only the 1–3 evidence sessions per question are ingested, not the full 500-session haystack. This is the standard published-baseline mode used by Hindsight and others. Full-haystack mode has not yet been benchmarked at scale.
- **LoCoMo is a work in progress.** An earlier harness produced higher numbers; our current honest harness (commit `893270d feat: benchmark analysis tooling + first honest LoCoMo results`) scores 55.5% against the real hybrid-retrieval pipeline. The gap is being investigated. Results are committed at `LOCOMO_RESULTS.json` so anyone can verify.
- **Answer model:** `deepseek-coder-v2:16b` locally for LongMemEval. Published competitors use GPT-4o or Gemini. The scores reflect the retrieval + assembly architecture, not raw LLM intelligence. A stronger answer model would likely push scores higher.

No cloud dependency. No external memory service. One SQLite database, one vector store, running entirely on your machine.

---

## What It Does

Claudex gives LLM coding agents context continuity across sessions. It hooks into [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and silently captures everything that matters — observations, decisions, artifacts, patterns, conversation history — then surfaces exactly the right context at the right time.

After 550+ sessions and 30,000+ observations in production use, the system knows:
- What files you've been editing and why
- What decisions were made and their context
- What patterns lead to corrections (and avoids repeating them)
- What you were working on when you left off
- What your intent is before you finish typing

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Claude Code CLI                    │
├──────────┬──────────┬──────────┬──────────┬─────────┤
│ Session  │ Prompt   │ PostTool │  Stop    │ Session │
│ Start    │ Submit   │ Use      │          │ End     │
├──────────┴──────────┴──────────┴──────────┴─────────┤
│              CC Hook Adapter Layer                    │
│         (ephemeral Node.js processes)                │
├─────────────────────────────────────────────────────┤
│                  Shared Lifecycle                     │
│    observations · artifacts · decisions · threads    │
├─────────────────────────────────────────────────────┤
│                  SQLite (single store)               │
│   V15 schema · 33 tables · FTS5 full-text           │
│   sqlite-vec · 5 vec0 virtual tables · 1024-dim     │
│   snowflake-arctic-embed2 embeddings · one .db file │
├─────────────────────────────────────────────────────┤
│                  Angel Guardian                       │
│   pattern extraction · session monitoring            │
│   auto-close idle sessions · RL policy training      │
│   consolidation · bulk linking · embedding backfill  │
├─────────────────────────────────────────────────────┤
│                Intelligence Layer                     │
│   intent classification · intent prediction          │
│   experience patterns · correction detection         │
│   retrieval feedback · capability tracking           │
│   topic shift detection · cross-session linking      │
├─────────────────────────────────────────────────────┤
│         Hybrid Retrieval (5-channel RRF)             │
│  FTS5 · sqlite-vec KNN · recency · graph · temporal │
├─────────────────────────────────────────────────────┤
│         Neural Reranking (bge-reranker-v2-m3)        │
│   568M params · CUDA · 46 NDCG · bi-encoder fallback │
└─────────────────────────────────────────────────────┘
```

**Three runtime components:**
- **CC Hooks** — 26 ephemeral scripts that fire on Claude Code events (7 substantive hooks + 19 event recorders). Fast, mechanical, DB-only state. Never call the API from a hook (deadlock).
- **Angel** — Persistent guardian process. Extracts patterns, forms opinions (CARA reasoning), monitors sessions, supervises the Python reranker lifecycle, indexes cross-agent sessions (Codex/Gemini/Aider), promotes proven rules, runs retention sweeps. 12+ heartbeat phases.
- **Assembly** — Context injection engine. Assembles the right memories into the right prompt at the right time, with token budgeting, 5-channel retrieval, and priority cascade.

## Key Features

**Memory That Works**
- Observation extraction from every tool use, file edit, search, and command
- Artifact lifecycle: creation, materialization, activation decay, packing
- Session-level thread tracking with topic detection and cross-session linking
- Experience patterns: learns from corrections, injects warnings before you repeat mistakes

**Intelligence Layer**
- Intent classification (6 types) drives retrieval strategy before you finish typing
- Intent prediction (3-layer: temporal profile + Markov chain + session features)
- Negative retrieval: tracks what was retrieved but NOT useful, suppresses it next time
- RL policy system: 6 SimpleMLP models (278 lines, ~34K parameters, pure TypeScript) learn optimal memory decisions

**Retrieval**
- 5-channel Reciprocal Rank Fusion: FTS5 keyword + sqlite-vec KNN + recency decay + MPFP graph walk + temporal
- Neural cross-encoder reranking: bge-reranker-v2-m3 (568M params) on CUDA, 46 NDCG, with bi-encoder fallback (Snowflake Arctic Embed 2, 1024-dim)
- Q-value reinforcement learning: patterns earn effectiveness scores from session outcomes (EMA + UCB exploration)
- Per-event exponential decay with zone-based half-lives (corrections: 60d, architecture: 180d)
- Budget-aware greedy packing — retrieval stops when token budget is full

**Cross-Session Communication**
- Stigmergic signals: sessions coordinate by modifying the shared environment (wip, failure, danger, claim, discovery) with temporal decay
- Session-to-session messaging: request/response/notify/transfer via `claudex_message` MCP tool
- SBAR-structured context transfer with mandatory commander's intent and receiver read-back
- Named sessions (project-sN-pid) addressable by other sessions
- 6 MCP tools: search, recall, store, events, message, session

**Resilience**
- Angel auto-closes idle sessions (warn at 15min, close at 30min with summary + recall capture)
- Session-start orphan recovery for crash/power-loss scenarios
- Split-write conversation storage: user text survives even if the response never completes
- Every operation is non-throwing — individual failures never break the pipeline

## Benchmark Results

### LoCoMo (Long-term Conversational Memory) — work in progress

10 conversations, 1540 questions across 4 categories. Run `2026-03-29` against the real hybrid-retrieval pipeline. Committed evidence: `LOCOMO_RESULTS.json`.

| Category | Claudex | Questions |
|---|---|---|
| Single-hop | **41.1%** | 116/282 |
| Multi-hop | **44.5%** | 143/321 |
| Temporal | **36.5%** | 35/96 |
| Open-domain | **66.7%** | 561/841 |
| **Overall** | **55.5%** | **855/1540 correct** |

The LoCoMo score is known to be below published competitors and is an active improvement area. Failure-mode analysis is in `LOCOMO_FAILURES.json` and the breakdown is categorized by `src/benchmark/analyze-results.ts`. Answer + judge: `claude-sonnet-4-6`.

### LongMemEval (Oracle Mode)

470 answerable questions across 6 task types, plus 30 unanswerable questions scored separately as abstention accuracy. Run `2026-03-28`. Committed evidence: `LONGMEMEVAL_ORACLE_RESULTS.json`.

| Category | Claudex | Questions |
|---|---|---|
| Single-session (preference) | **100.0%** | 30/30 |
| Single-session (user) | **98.4%** | 63/64 |
| Single-session (assistant) | **98.2%** | 55/56 |
| Multi-session | **87.6%** | 106/121 |
| Knowledge-update | **87.5%** | 63/72 |
| Temporal-reasoning | **85.8%** | 109/127 |
| **Overall** | **90.6%** | **426/470 correct** |
| Abstention (unanswerable) | 6.7% | 2/30 — known weak point, not included in overall |

**Mode caveat:** Oracle mode ingests only the 1–3 evidence sessions per question, not the full 500-session haystack. This is the same mode used by Hindsight and other published baselines, and it measures reading comprehension + QA quality with retrieval guaranteed. Full-haystack mode would additionally stress the retrieval pipeline at scale; we have not yet run it.

Answer and judge model: `deepseek-coder-v2:16b` (local, 16B params). Published baselines typically use GPT-4o or Gemini. The retrieval and assembly architecture does most of the work — a stronger answer model would likely push scores higher.

## Production Stats

Running in daily production use since March 2026:

- **550+ sessions** tracked across 5+ projects
- **30,000+ observations** captured (with dedup, novelty scoring, stability classification)
- **4,800+ artifacts** managed (with activation decay and automatic packing)
- **39 experience patterns** learned from corrections (5 promoted to always-inject)
- **7 CARA opinions** formed by Angel from proven patterns
- **108 test files**, **2,076 tests**, all passing
- **~39,000 lines** of TypeScript (70K+ including tests)

## Setup

```bash
# Prerequisites: Node.js 22+, Bun 1.3+, Ollama (Qdrant no longer required — sqlite-vec is embedded)
# Pull the embedding model
ollama pull snowflake-arctic-embed2

# Install, build, register hooks
bun install
bun run build
bun run setup

# Start the Angel guardian
node dist/angel/index.cjs

# Verify
node dist/cli/health.cjs
```

## Tech Stack

- **Runtime:** Node.js 22 + TypeScript 5.8 (strict)
- **Build:** esbuild (~70ms)
- **Database:** SQLite via better-sqlite3 (V15 schema, 33 tables + 5 vec0 virtual tables)
- **Vector Store:** sqlite-vec embedded in the same SQLite file (1024-dim flat KNN, 5 virtual tables mirroring the former Qdrant collections)
- **Embeddings:** Ollama + Snowflake Arctic Embed 2 (1024d, primary for both retrieval and bi-encoder fallback rerank)
- **Reranking:** bge-reranker-v2-m3 (568M params, CUDA) — true neural cross-encoder, supervised by Angel's `RerankerSupervisor` with bounded restart and log capture. **Load-bearing for production retrieval (RETR-08)**: when the cross-encoder is unreachable, the bi-encoder fallback is a degraded mode and every fallback writes one row to `telemetry` with `event_kind='reranker_fallback'`. Session-start surfaces a `## Reranker Health` line when the 24h count is non-zero.
- **LLM:** Claude Code CLI + Ollama fallback
- **Tests:** Vitest (108+ files, 2000+ tests)
- **MCP:** 6 tools (search, recall, store, events, message, session)

## Schema

V14 schema with 33 tables:

`observations` · `artifacts` · `sessions` · `thread_state` · `conversation_turns` · `session_events` · `experience_patterns` · `decisions` · `learnings` · `retrieval_events` · `artifact_links` · `temporal_profile` · `action_transitions` · `session_journal` · `session_messages` · `pressure_scores` · `checkpoint_tracking` · `schema_versions` · `telemetry` · `artifact_access_log` · `knowledge_gaps` · `session_signals` · `angel_opinions` · `solution_outcomes` · `entity_aliases` · `policy_weights` · `file_leases` · `artifact_claims` · `critical_rules` (and others — full list in `src/core/schema.ts`)

Single-store design: SQLite is both the source of truth AND the vector store (via sqlite-vec virtual tables). FTS5 handles keyword search. The system degrades gracefully — if Ollama is down for embeddings, search falls back to FTS5-only. One .db file contains everything.

## How It's Different

Most memory systems are wrappers around a vector database with an LLM summarizer. Claudex is different:

1. **It runs locally.** No cloud memory service, no API keys for memory operations, no data leaving your machine. Single SQLite file is the entire database.
2. **It learns from mistakes.** Experience patterns detect when you correct the AI, extract what went wrong, and inject warnings before the same mistake happens again. Q-value RL learns which patterns actually help.
3. **It predicts what you need.** Intent classification and prediction pre-fetch relevant context before you finish asking. 5-channel retrieval with temporal expression parsing.
4. **It has a guardian.** Angel watches sessions, extracts patterns, forms opinions (CARA reasoning), indexes cross-agent sessions, promotes proven rules, runs retention sweeps, and auto-closes abandoned sessions.
5. **Sessions talk to each other.** Stigmergic signals let sessions coordinate without direct messaging. One session's "this approach failed" warning appears in every other session on the same project. Direct messaging for explicit cross-session requests.
6. **It learns from other agents.** Cross-agent indexer reads sessions from Codex, Gemini CLI, and Aider — extracting user directives and corrections that Claudex can apply in future sessions.
7. **It's built for one user.** Not a multi-tenant SaaS product. A personal memory system that gets better the more you use it.

## License

MIT
