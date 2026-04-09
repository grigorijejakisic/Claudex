# Claudex v3 — Architecture

> Audience: an engineer who just cloned the repo and wants to understand the system in 15 minutes. If you're a Claude Code session using `CLAUDE.md`, that's a different document with different goals — this one is for humans reading the code.
>
> The original implementation-ready design document from 2026-03-10 is preserved at `context/specs/ARCHITECTURE_ORIGINAL_2026-03-10.md`.

## What is Claudex?

Claudex is a persistent memory system for Claude Code. It hooks into the Claude Code CLI event system, captures observations from every tool call, decision, and conversation turn, and surfaces relevant context at the start of each session and every user prompt. The design goal is not just storage and retrieval — it is an **intelligence layer on top of memory**: a background process that learns from corrections, forms opinions, consolidates observations, and coordinates across parallel sessions.

On **LongMemEval Oracle** (470 answerable questions), Claudex scores **90.6%** (`LONGMEMEVAL_ORACLE_RESULTS.json`, 2026-03-28) using `deepseek-coder-v2:16b` locally — competitive with Hindsight's 89.0–91.4% which uses GPT-4o/Gemini-3. On **LoCoMo** (1540 questions), the current honest harness (commit `893270d`, which explicitly supersedes an earlier over-scored run) returns **55.5%** — a known work-in-progress. Benchmark methodology is in `benchmarks/BENCHMARKS.md`.

The scores reflect retrieval + assembly architecture more than model intelligence. A stronger answer model on the same pipeline would likely push scores higher without changing any Claudex code.

## System Components

```
┌─────────────────────────────────────────────────────┐
│                   Claude Code CLI                    │
├──────────────────────────────────────────────────────┤
│         CC Hook Adapter (26 ephemeral scripts)       │
│  session-start · user-prompt-submit · post-tool-use  │
│  stop · pre-compact · post-compact · session-end     │
│  + 19 event-record-only hooks                        │
├──────────────────────────────────────────────────────┤
│              Shared Lifecycle (lifecycle.ts)          │
│  observations · artifacts · decisions · threads      │
├──────────────────────────────────────────────────────┤
│                 SQLite (single store)                │
│   33 tables + 5 vec0 virtual tables, V15             │
│   FTS5 full-text · sqlite-vec KNN · WAL journal      │
│   snowflake-arctic-embed2 embeddings · 1024-dim      │
├──────────────────────────────────────────────────────┤
│                  Angel Guardian                       │
│  pattern extraction · CARA opinions · consolidation  │
│  retention sweep · embedding backfill · RL training  │
│  idle session auto-close · reranker supervision      │
├──────────────────────────────────────────────────────┤
│               Intelligence Layer                      │
│  experience patterns · intent classification         │
│  retrieval RL · correction detection · topic shift   │
├──────────────────────────────────────────────────────┤
│         Hybrid Retrieval (up to 5 channels)          │
│  FTS5 · sqlite-vec KNN · recency · graph · temporal │
├──────────────────────────────────────────────────────┤
│        Neural Reranking (bge-reranker-v2-m3)         │
│  supervised Python service · bi-encoder fallback     │
└──────────────────────────────────────────────────────┘
```

### CC Hooks (`src/adapters/cc-hooks/`)

Twenty-six ephemeral Node.js scripts. Each is spawned by Claude Code for a matching hook event, reads JSON from stdin, writes JSON to stdout, and exits. They are stateless between invocations; all state lives in SQLite. Hook process lifespan is typically under 100ms.

A critical constraint: **never call Claude Code's API from a hook**. The hooks run inside CC's event loop; calling back into CC causes deadlock. Any LLM work in hooks goes through Ollama directly. See `.claude/rules/hooks-safety.md`.

The seven substantive hooks that do real work:

| Hook | Role |
|------|------|
| `session-start.ts` | Session init, checkpoint recovery, full context assembly, spawn Angel |
| `user-prompt-submit.ts` | Intent classification, topic shift detection, regular assembly, Angel message delivery, experience pattern matching |
| `post-tool-use.ts` | Observation extraction, pressure update, thread tracking, checkpoint threshold check |
| `stop.ts` | Decision capture, conversation storage, retrieval feedback, activation decay |
| `pre-compact.ts` | Checkpoint write, learning promotion, mark post-compact-pending |
| `post-compact.ts` | Compaction event record, clear pending flag, journal entry |
| `session-end.ts` | Final checkpoint, retention decay, session close, RL Q-value update |

The remaining nineteen hooks are pure event recorders — they write a row to `session_events` and exit. Examples: `config-change`, `cwd-changed`, `elicitation`, `permission-request`, `subagent-start`, `subagent-stop`, `task-created`, `task-completed`, `worktree-create`, `worktree-remove`, `teammate-idle`, `pre-tool-use`.

### Angel (`src/angel/`)

A persistent Node.js process that runs independently of CC hooks. It auto-spawns from `session-start.ts` if not already running (PID file at `~/.claudex/angel.pid`). Angel performs all reflective, holistic work that hooks cannot do in a 100ms window.

Angel operates on a configurable heartbeat (default: 5 minutes). Each tick runs 12+ phases:

1. **Idle session monitoring** — warnings at 15 min idle, auto-close at 30 min with a session summary
2. **Pattern extraction** — cursor-based incremental processing of completed sessions; extracts experience patterns from corrections via Ollama
3. **Domain classification** — classifies unprocessed sessions by engineering domain
4. **CARA reasoning** — forms opinions about tools, approaches, and patterns with Bayesian confidence dynamics (`angel_opinions` table)
5. **Bulk artifact linking** — connects related artifacts via sqlite-vec similarity
6. **Observation consolidation** — clusters similar observations, LLM-summarizes clusters of 3+, sets `consumed=1` on originals (never deletes)
7. **RL policy training** — updates SimpleMLP weights from session outcomes
8. **Data retention sweep** — per-table lifecycle enforcement
9. **Cross-project deduplication** — fingerprint-based dedup across projects
10. **Data quality checks** — fixes orphaned artifacts, backfills missing embeddings
11. **Proactive curation** — promotes high-value patterns, decays stale ones
12. **Service health monitoring** — health-checks Ollama, Reranker, CliProxy (Qdrant removed in session 47)

Angel is also the **sole owner of the reranker service lifecycle** via `RerankerSupervisor` (`src/angel/reranker-supervisor.ts`). If the reranker dies, Angel restarts it up to 3 times with log capture before giving up and logging loudly. If an externally-managed reranker is already running at startup, Angel leaves it alone.

### OpenClaw Bridge (`src/adapters/openclaw-bridge/`)

A long-lived adapter for the OpenClaw (Pi SDK) runtime. Unlike CC hooks, the bridge holds a persistent DB connection and in-memory state across requests. It implements the same lifecycle operations as the CC hooks via `shared/lifecycle.ts`. Most users will not interact with this adapter directly.

### Shared Lifecycle (`src/adapters/shared/lifecycle.ts`)

Composable functions called by both CC hooks and the OpenClaw bridge. Key operations: `processToolAndPressure`, `trackAfterTool`, `trackAfterTurn`, `checkpointIfThresholdMet`, `captureDecisionsWithClassifier`, `runCompactionSequence`. All are non-throwing — individual failures don't crash the caller.

## Data Stores

### SQLite — Source of Truth

Location: `~/.claudex/db/claudex.db` (WAL journal mode, `busy_timeout = 5000ms`).

**Schema version: V14**, 33 tables. Migrations are defined in `src/core/migration-steps.ts` and run automatically on first open. Each migration is incremental and non-destructive (columns added, never dropped).

Key tables:

| Table | Purpose |
|-------|---------|
| `observations` | Raw observations from tool calls, with importance 1–5, stability class, novelty score |
| `artifacts` | Materialization model — observation refs packed into context-injectable units with TTL and activation decay |
| `sessions` | Session registry with status, project, name, transfer links |
| `conversation_turns` | Raw user + assistant text per turn, optional embedding |
| `experience_patterns` | Cross-session correction patterns with ExpeL scoring, ACE escalation levels, maturity lifecycle |
| `angel_opinions` | CARA opinion network with Bayesian confidence |
| `session_signals` | Stigmergic coordination signals (wip/failure/danger/claim/discovery) with TTL |
| `session_messages` | Inter-session message bus (request/response/notify/transfer) |
| `artifact_links` | Zettelkasten-style directed links between artifacts |
| `retrieval_events` | Retrieval feedback loop — was this artifact actually referenced? |
| `policy_weights` | Persisted SimpleMLP weights for RL memory policy |
| `critical_rules` | Behavioral rules for periodic re-injection to prevent drift |

All tables have FTS5 virtual tables or indexes for hot query paths. Complete DDL in `src/core/schema.ts`.

### sqlite-vec — Embedded Vector Store

The vector store lives inside the same SQLite file via the [sqlite-vec](https://github.com/asg017/sqlite-vec) extension (v0.1.9+). Five `vec0` virtual tables mirror the former Qdrant collections: `vec_artifacts`, `vec_patterns`, `vec_threads`, `vec_journal`, `vec_conversations`. All use 1024-dim float vectors (snowflake-arctic-embed2 native dimension) with flat KNN search.

**Single-store design**: no dual-write. The source row and its embedding can be inserted in the same SQLite transaction. Zero divergence risk, zero network latency, zero external service dependency. At Claudex's current scale (tens of thousands of observations), flat KNN is fast (~10-30ms per query); past 500k+ vectors, HNSW would matter but we're nowhere near that threshold.

Qdrant was removed in session 47. See `context/specs/SQLITE_VEC_MIGRATION.md` for the migration design and Phase 1-5 execution history.

## Retrieval Pipeline

Hybrid retrieval lives in `src/core/hybrid-retrieval.ts`. Two entry points:

- `hybridSearchSync` — synchronous, FTS5 + recency only (for hooks where async is unavailable)
- `hybridSearchAsync` — full async, up to 5 channels

### Channels

1. **FTS5 keyword search** — BM25 over `artifacts_fts`. Porter stemmer, unicode61 tokenizer. Always available.
2. **sqlite-vec KNN** — cosine similarity over `vec_artifacts` (vec0 virtual table, L2 distance converted to score via `1 / (1 + d)`). Requires Ollama for embedding generation; the vec0 tables themselves are in-process. Degrades to 0 results if Ollama is down.
3. **Recency** — newest-first sort, no query dependency. Always available.
4. **Graph walk** — 2-hop traversal of `artifact_links` seeded by top-K from channels 1–3. Discovers related artifacts not matched by the query.
5. **Temporal** — time-range filter when the query contains temporal expressions ("last week", "yesterday"). Skipped on parse failure.

### Fusion and Scoring

Channels are merged with **Reciprocal Rank Fusion** (RRF, k=60): `score = Σ 1/(60 + rank_i)`. Then a three-factor re-score: `α·recency + β·importance + γ·relevance`. Weights are configurable per-query; intent classification can override the recency weight.

### Reranking

After RRF, the top 20 candidates are sent to the **cross-encoder reranker** at `http://127.0.0.1:7439/rerank` (3s timeout). The service (`services/reranker.py`) runs `BAAI/bge-reranker-v2-m3` (~568M params) on CUDA via `sentence-transformers`. It is a **true neural cross-encoder** — it scores (query, document) pairs jointly, not independently. Scores blend 40% cross-encoder + 60% hybrid RRF.

If the cross-encoder is unavailable, the system falls back to **snowflake-arctic-embed2 bi-encoder similarity** via Ollama's `/api/embed`. This is cosine similarity between separately-encoded query and document embeddings — not a true cross-encoder, and measurably lower quality. Blend: 30% bi-encoder + 70% hybrid.

If both are unavailable, RRF scores stand unchanged. This three-tier graceful degradation is the reason retrieval quality drops progressively rather than catastrophically when services fail.

### Token Budget Packing

After reranking, a greedy packing loop adds results until `budgetTokens` is reached. Prevents context bloat when the retrieval window is tight.

## Intelligence Layer

The intelligence layer (`src/intelligence/`) is what separates Claudex from a thin vector-database wrapper.

### Experience Patterns (`src/intelligence/experience-patterns.ts`)

When `stop.ts` detects a correction signal (user re-instructing the AI on something it got wrong), Angel's pattern extractor produces an `ExperiencePattern` record. Patterns have:

- **ExpeL scoring**: `helpful_count - 4 * harmful_count` with zone-based exponential decay (corrections: 60-day half-life; architecture decisions: 180-day half-life)
- **ACE escalation**: `pattern → warning → enforcement → circuit_breaker` — escalates when the AI keeps repeating the mistake
- **Maturity levels**: `candidate → established → proven` — proven patterns can be promoted to always-inject mode
- **FTS5 matching** on every `user-prompt-submit` — if the prompt matches a pattern's trigger context, the pattern is injected as a warning

### CARA Reasoning (`src/angel/`)

Angel forms opinions about subjects (tools, approaches, patterns) stored in `angel_opinions`. Each opinion has a confidence value updated via Bayesian dynamics: reinforcement increases confidence toward 1.0, weakening decreases it toward 0, contradiction resets to 0.5 with a new opinion text. Opinions with confidence ≥ 0.7 are surfaced during assembly. Inspired by Hindsight's opinion network architecture.

### Dream Consolidation (`src/angel/consolidator.ts`)

Angel's consolidator finds clusters of similar observations (cosine threshold 0.8), summarizes clusters of 3+ with Ollama, and sets `consumed=1` on originals. It **never deletes**. Claude Code's built-in "Dream" consolidation is disabled (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) to avoid conflicts — Angel is the sole consolidator. The consolidator also runs contradiction detection and staleness pruning.

### Cross-Session Coordination

**Stigmergic signals** (`src/core/session-signals.ts`): sessions leave typed signals in `session_signals` (wip/failure/danger/claim/discovery) with optional expiry. Every `user-prompt-submit` picks up active signals for the current project and injects them. Sessions coordinate by modifying shared state, not by direct messaging.

**Direct messaging** (`src/angel/message-sender.ts`): sessions and Angel write to `session_messages`. Pending messages are delivered at the next `user-prompt-submit`. Types: request/response/notify/transfer. Context transfers use SBAR structure (Situation/Background/Assessment/Recommendation).

### Assembly Pipeline (`src/assembly/assembler.ts`)

Two assembly modes:

**Full assembly** (session-start, post-compaction): priority-ordered cascade that fills the token budget from P1 (identity) to P5+ (codebase context, predicted context). Sections are skipped if they'd exceed remaining budget. Budget details in `.claude/rules/assembly-budget.md`.

**Regular prompt** (every `user-prompt-submit`): lightweight injection — proven principles (500 token cap), critical reminders (300 token cap), intent-triggered patterns, experience warnings, trigger-materialized artifacts. Intent classification (pure regex, <1ms) runs first and configures retrieval weights for the entire assembly.

## External Dependencies

| Service | Port | Used for | Fallback when down |
|---------|------|----------|--------------------|
| **Ollama** | 11434 | Embeddings (snowflake-arctic-embed2, 1024d); LLM for Angel pattern extraction and consolidation | FTS5-only retrieval; no embedding write; pattern extraction skipped |
| **Reranker** (Python) | 7439 | BAAI/bge-reranker-v2-m3 cross-encoder | Bi-encoder cosine via Ollama, then RRF-only |
| **CliProxy** (optional) | 8317 | OAuth passthrough for Claude MAX subscription | Angel falls back to Ollama for LLM work |

The Python reranker requires Python 3.10+, PyTorch with CUDA (ROCm also works), and downloads ~568MB on first run. Angel's `RerankerSupervisor` manages its lifecycle with bounded restarts and log capture to `context/logs/reranker.log`. Qdrant used to be bundled and spawned here; it was removed in session 47 — see `context/specs/SQLITE_VEC_MIGRATION.md` for the migration history.

## File Layout

```
src/
├── adapters/
│   ├── cc-hooks/          26 hook scripts + shared infrastructure
│   ├── openclaw-bridge/   Long-lived Pi SDK adapter
│   └── shared/            lifecycle.ts — composable operations
├── angel/                 Persistent guardian process (pattern extractor,
│                          CARA, consolidator, RerankerSupervisor, ...)
├── assembly/              Context assembly (assembler.ts, sections.ts)
├── benchmark/             LoCoMo + LongMemEval evaluation harness
├── checkpoint/            Checkpoint write/load/inject pipeline
├── cli/                   Health check, setup, migration, recall CLI
├── core/                  SQLite schema, migrations, DB access functions,
│                          hybrid-retrieval.ts
├── decay/                 Observation decay engine
├── embeddings/            EmbeddingProvider, embed pipeline, sqlite-vec backend
├── extraction/            Observation extraction from tool outputs
├── gauge/                 Token window tracking
├── indexer/               Codebase file indexer for context injection
├── intelligence/          Experience patterns, intent classification,
│                          retrieval RL, correction detection, topic shift,
│                          entity resolution, capability tracking, ...
├── mcp/                   MCP server (6 tools)
├── observability/         Telemetry and error telemetry
├── shared/                Config, constants, paths, types, utilities
└── tests/                 Vitest tests

services/
└── reranker.py            Python FastAPI cross-encoder microservice
```

## Comparison to Other Systems

**Mem0** stores memories by running every conversation through an LLM summarizer that decides what to keep. This is lossy by design — the LLM decides what matters, and can drop context it doesn't recognize as important. Claudex extracts observations mechanically from tool calls and only applies LLM judgment during Angel's reflective consolidation pass, not on the hot path. Mem0 is also a hosted multi-tenant product; Claudex is single-user, local-only.

**Zep** builds a temporal knowledge graph over conversations with entity-level time-stamped updates. This is architecturally richer in one dimension: Zep can answer "what did the user's preference change from X to Y and when?" with graph traversal. Claudex handles this via `artifact_links` (Zettelkasten-style directed links with timestamps) but does not have a general temporal KG. Zep scores ~71% on LongMemEval; Claudex scores 90.6%. The difference is likely explained by Claudex's multi-channel retrieval, cross-encoder reranking, and experience pattern injection.

**MemPalace** (the Milla Jovovich / Ben Sigman project, released April 2026) focuses on retrieval quality through structured chunking ("palace / wings / rooms / drawers" metaphor implemented as ChromaDB metadata) and a local SQLite temporal knowledge graph with `valid_from`/`valid_to` semantics. MemPalace has no intelligence layer — no learning from corrections, no opinion network, no consolidation. Its architecture is simpler (one vector store, one SQLite KG, no separate rerank service) which makes it more robust operationally, at the cost of the cognitive features Claudex provides. MemPalace's temporal KG is a concrete feature gap relative to Claudex; Claudex's Angel is a concrete feature gap relative to MemPalace.

**Hindsight** is the closest published peer. It uses a four-network structured memory (episodic, semantic, procedural, working), an opinion network (which Claudex's CARA directly drew from), and GPT-4o or Gemini-3 as the answer model. Hindsight scores 89.0% on LongMemEval Oracle with an open 120B model, 91.4% with Gemini-3 Pro. Claudex scores 90.6% with `deepseek-coder-v2:16b` locally. Competitive within 1 percentage point using a dramatically smaller answer model. Hindsight does not appear to have an equivalent to Claudex's stigmergic cross-session coordination or experience pattern escalation.

## Known Limitations and Trade-offs

**Service complexity, reduced in session 47.** Claudex previously required four external services running for full capability: Ollama, Qdrant, the Python reranker, and Angel. After the sqlite-vec migration (Phases 1-5, session 47), Qdrant is gone — the vector store now lives inside the shared SQLite file as vec0 virtual tables. Current state requires: Ollama (embeddings + local LLM), Python reranker (cross-encoder, CUDA), and Angel (persistent intelligence). The graceful degradation chain (full → FTS5+vector → FTS5+recency → FTS5 only) still works if Ollama goes down. MemPalace's simpler architecture (one process, one store) remains a reference point; Claudex now has a single store matching that simplicity, while keeping Angel for the cognitive features MemPalace lacks.

**Python reranker is a hard dependency for best quality.** The BGE-reranker-v2-m3 model is 568MB, needs PyTorch with CUDA, and downloads on first run. The bi-encoder fallback (snowflake-arctic-embed2 cosine) is weaker. Users without a CUDA GPU will not get the full reranking benefit.

**No general temporal knowledge graph.** Entity relationships are tracked via `artifact_links` and temporal queries via `created_at_epoch` filters, but there is no graph query language, no entity timeline, and no relationship inference. Temporal expressions in natural language ("last week") are parsed by `hybrid-retrieval.ts` but cover only simple cases.

**Windows platform quirks.** The codebase was developed on Windows 11 and has accumulated platform-specific workarounds. See `.claude/rules/` for details. Some shell behaviors differ. Node spawn must be `detached: true, stdio: 'ignore'` for background services — `start /B` does not fully detach.

**Single-user design.** The DB path is hardcoded to `~/.claudex/db/claudex.db`. No auth, no multi-tenancy. This is intentional — it's a personal memory system. Do not expose the MCP server or the database file to a network.

**LoCoMo is a work in progress.** As of this writing the honest LoCoMo score is 55.5%, below published competitors. An earlier harness reported 90.8%; commit `893270d` explicitly documented that earlier number as inflated relative to the real hybrid pipeline. Improvement is an active area of work. See `benchmarks/BENCHMARKS.md`.

## Reading Order for New Engineers

Start here, in this order:

1. **`CLAUDE.md`** — 2-minute overview of what exists, critical safety rules (hook deadlock, fire-and-forget requirement, dual-write invariant). This is written for LLM sessions but it's also the right entry doc for humans.

2. **`src/angel/index.ts`** — Entry point for the persistent guardian. Startup sequence: DB init (which includes V14→V15 sqlite-vec virtual table creation), CliProxy detection, RerankerSupervisor startup, heartbeat loop. Then read `src/angel/heartbeat.ts` to see what each tick does.

3. **`src/assembly/assembler.ts`** — Context injection engine. Read the `FullAssemblyParams` interface, then trace `assembleFullContext` to understand the priority cascade.

4. **`src/core/hybrid-retrieval.ts`** — Retrieval pipeline. Channels, RRF merge, three-factor scoring, reranking fallback chain. The top-of-file comment block is accurate and worth reading in full.

5. **`src/core/schema.ts`** — Complete DDL. Skim the table list and comments to understand what data exists.

6. **`src/intelligence/experience-patterns.ts`** — ExpeL scoring, ACE escalation, maturity promotion. The "learning from corrections" mechanism.

If you want to understand a specific hook, they are self-contained: read `src/adapters/cc-hooks/<hook-name>.ts` and follow imports into `src/adapters/shared/lifecycle.ts`. Each hook file is 80–200 lines and heavily commented.
