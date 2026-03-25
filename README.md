# Claudex

**Persistent memory that makes LLM agents actually remember.**

LoCoMo **90.8%** | LongMemEval **90.6%** — outperforming every published memory system we benchmarked against.

```
  OpenAI Memory      52.9%
  Mem0               67.1%
  Zep                75.1%
  Memori             82.0%
  MemMachine         84.9%
  Hindsight OSS-120B 89.0%
  Hindsight          89.6%
  ----
  Claudex            90.6%   LongMemEval Oracle (470 questions, 7 task types)
  Claudex            90.8%   LoCoMo (1540 questions, 10 conversations)
  Claudex            89.1%   LongMemEval Oracle (470 questions, 7 task types)
```

No cloud dependency. No external memory service. One SQLite database, one vector store, running entirely on your machine.

---

## What It Does

Claudex gives LLM coding agents context continuity across sessions. It hooks into [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and silently captures everything that matters — observations, decisions, artifacts, patterns, conversation history — then surfaces exactly the right context at the right time.

After 233 sessions and 21,000+ observations in production use, the system knows:
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
├────────────────────┬────────────────────────────────┤
│   SQLite (truth)   │      Qdrant (acceleration)     │
│   V11 schema       │      5 collections             │
│   FTS5 full-text   │      1024-dim vectors           │
│   21 tables        │      snowflake-arctic-embed2   │
├────────────────────┴────────────────────────────────┤
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
│              Hybrid Retrieval (4-channel RRF)         │
│   FTS5 keyword · Qdrant KNN · recency · graph walk  │
└─────────────────────────────────────────────────────┘
```

**Three runtime components:**
- **CC Hooks** — 6 ephemeral scripts that fire on Claude Code events. Fast, mechanical, DB-only state. Never call the API from a hook (deadlock).
- **Angel** — Persistent guardian process. Extracts patterns from completed sessions via LLM. Monitors idle sessions and auto-closes them with state preservation. Runs 8 heartbeat phases.
- **Assembly** — Context injection engine. Assembles the right memories into the right prompt at the right time, with token budgeting and 3-tier degradation.

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
- 4-channel Reciprocal Rank Fusion: FTS5 keyword + Qdrant KNN + recency decay + artifact graph walk
- Snowflake Arctic Embed 2 (568M params, 1024-dim, 8K context)
- Content-length-aware embedding backfill
- Activation spreading across artifact links

**Resilience**
- Angel auto-closes idle sessions (warn at 15min, close at 30min with summary + recall capture)
- Session-start orphan recovery for crash/power-loss scenarios
- Split-write conversation storage: user text survives even if the response never completes
- Every operation is non-throwing — individual failures never break the pipeline

## Benchmark Results

### LoCoMo (Long-term Conversational Memory)

10 conversations, 1540 questions across 4 categories. The standard benchmark for memory systems.

| Category | Claudex | Description |
|---|---|---|
| Single-hop | **92.6%** | Direct fact retrieval from one session |
| Temporal | **91.7%** | Time-based reasoning across sessions |
| Open-domain | **91.0%** | Combining conversation facts with world knowledge |
| Multi-hop | **88.8%** | Cross-session synthesis requiring multiple facts |
| **Overall** | **90.8%** | **1399/1540 correct** |

### LongMemEval (Oracle Mode)

500 instances, 7 task types. Tests reading comprehension and answer quality with perfect retrieval.

| Category | Claudex | Description |
|---|---|---|
| Single-session (preference) | **100.0%** | Identify user preferences |
| Single-session (assistant) | **98.2%** | Recall assistant-provided info |
| Single-session (user) | **98.4%** | Recall user-stated facts |
| Multi-session | **88.4%** | Combine info across sessions |
| Knowledge-update | **87.5%** | Detect changed information |
| Temporal-reasoning | **85.0%** | Time-based reasoning |
| **Overall** | **90.6%** | **426/470 correct** |

Answer model: `deepseek-coder-v2:16b` (local, 16B params). Published baselines use GPT-4o. The retrieval and assembly architecture does the heavy lifting — a stronger answer model would push scores higher.

## Production Stats

Running in daily production use since March 2026:

- **233 sessions** tracked
- **21,219 observations** captured (with dedup, novelty scoring, stability classification)
- **2,945 artifacts** managed (with activation decay and automatic packing)
- **10 experience patterns** learned from corrections
- **99 test files**, **1,968 tests**, all passing
- **~29,000 lines** of TypeScript

## Setup

```bash
# Prerequisites: Node.js 22+, Bun 1.3+, Ollama, Qdrant
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
- **Build:** esbuild (~60ms)
- **Database:** SQLite via better-sqlite3 (V11 schema, 21 tables)
- **Vector Store:** Qdrant (5 collections, 1024-dim cosine)
- **Embeddings:** Ollama + Snowflake Arctic Embed 2 (568M params)
- **LLM:** Claude Code CLI + Ollama fallback
- **Tests:** Vitest (99 files, 1968 tests)

## Schema

V11 schema with 21 core tables:

`observations` · `artifacts` · `sessions` · `thread_state` · `conversation_turns` · `session_events` · `experience_patterns` · `decisions` · `learnings` · `retrieval_events` · `artifact_links` · `temporal_profile` · `action_transitions` · `session_journal` · `session_messages` · `pressure_scores` · `checkpoint_tracking` · `schema_versions` · `telemetry` · `artifact_access_log` · `knowledge_gaps`

Dual-write: SQLite is the source of truth. Qdrant accelerates semantic search. FTS5 handles keyword search. The system degrades gracefully — if Qdrant or Ollama are down, everything still works via FTS5.

## How It's Different

Most memory systems are wrappers around a vector database with an LLM summarizer. Claudex is different:

1. **It runs locally.** No cloud memory service, no API keys for memory operations, no data leaving your machine.
2. **It learns from mistakes.** Experience patterns detect when you correct the AI, extract what went wrong, and inject warnings before the same mistake happens again.
3. **It predicts what you need.** Intent classification and prediction pre-fetch relevant context before you finish asking.
4. **It has a guardian.** The Angel process watches over sessions, extracts patterns holistically (not from 2-second snapshots), auto-closes abandoned sessions, and continuously improves retrieval quality through RL training.
5. **It's built for one user.** Not a multi-tenant SaaS product. A personal memory system that gets better the more you use it.

## License

MIT
