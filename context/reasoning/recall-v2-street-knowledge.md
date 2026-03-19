# Street Knowledge Deep Dive: 6 Topics for Claudex Memory System Upgrade

## Topic 1: Task-Aware Context Assembly

### Finding 1: Codified Context — Trigger Tables
**Source**: [Codified Context: Infrastructure for AI Agents in a Complex Codebase](https://arxiv.org/html/2602.20478v1) (Feb 2026, arXiv)
**What it does**: Three-tier architecture (hot memory/domain specialists/cold memory) for a 108K-line C# project. A "trigger table" in Tier 1 automatically routes tasks to specialized agents based on which files are being modified — no developer decision-making required.
**What to steal**: The trigger table pattern. Map file-path globs to knowledge domains. When PostToolUse fires on an Edit to `src/migrations/*.ts`, surface migration-related learnings automatically. This removes FTS5 keyword matching from the critical path entirely.
**Limitations**: Evaluated observationally across 283 sessions, not controlled experiments. Requires substantial upfront domain knowledge encoding (~660 lines for the "constitution" alone).

### Finding 2: Spotify's Context Engineering for Background Agents
**Source**: [Spotify Engineering Blog — Context Engineering (Honk Part 2)](https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2) (Nov 2025)
**What it does**: Spotify's background coding agents prefer large static prompts over dynamic context fetching. They explicitly limit tool access ("more tools = more unpredictability") and use build system feedback (tests/linters) as the primary context signal.
**What to steal**: The insight that build system output IS context. PostToolUse on Bash already captures test/lint results — using those to inform next-turn context injection is cheaper and more reliable than semantic search.
**Limitations**: Enterprise context. They moved to Claude Code for complex tasks, suggesting their homegrown loop had limits.

### Finding 3: Anthropic's Official Context Engineering Guidance
**Source**: [Anthropic — Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (2025)
**What it does**: Recommends "just-in-time" retrieval via lightweight identifiers (file paths, queries) loaded dynamically via tools, rather than pre-loading. Advocates progressive disclosure and sub-agent architectures.
**What to steal**: The hybrid strategy — combine upfront context loading (for speed at session start) with autonomous exploration tools (glob/grep) to bypass stale indexing. Claudex already does upfront injection; adding MCP tools for on-demand query is the natural next step.
**Limitations**: Generic guidance, not implementation-specific.

### Finding 4: File-Scoped Rules in Claude Code
**Source**: [Martin Fowler — Context Engineering for Coding Agents](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html) (2025)
**What it does**: Documents how Claude Code rules can be scoped to file patterns (e.g., `*.sh` rules only load when shell scripts are touched). Three activation modes: LLM-driven (uncertain), human-triggered (slash commands), software-deterministic (hooks).
**What to steal**: Software-deterministic activation via hooks is the highest-reliability path. Claudex hooks already fire per-tool — adding file-glob-to-knowledge routing at the hook level gives deterministic task-awareness.
**Limitations**: Current Claude Code rules are static text, not dynamic DB-backed knowledge.

### Finding 5: ETH Zurich AGENTS.md Study
**Source**: [InfoQ — New Research Reassesses the Value of AGENTS.md Files](https://www.infoq.com/news/2026/03/agents-context-file-value-review/) (Mar 2026)
**What it does**: Measured that LLM-generated context files DEGRADE performance by 3%, while human-written files improve it by only 4%. Context file quality matters more than quantity.
**What to steal**: Quality gate for injected context. Don't inject everything — inject only high-confidence, human-validated knowledge. Claudex's importance scoring (>= 3) is already on this path; adding a "validated" flag for learnings would sharpen it.
**Limitations**: Study focused on AGENTS.md-style static files, not dynamic DB-backed injection.

---

## Topic 2: MCP Servers for Memory/Recall

### Finding 1: Memento — SQLite + FTS5 + sqlite-vec MCP Server
**Source**: [iAchilles/memento](https://github.com/iAchilles/memento) (GitHub)
**What it does**: Knowledge graph MCP server using SQLite with FTS5 keyword search AND sqlite-vec (1024-dim BGE-M3 embeddings) for hybrid retrieval. Entities/observations/relations triad. 9 MCP tools. Runs offline with @xenova/transformers for embeddings.
**What to steal**: The hybrid FTS5 + sqlite-vec pattern on a single SQLite DB. Their entity-observation-relation schema mirrors Claudex's existing observation/artifact/learning structure. Node.js-native, uses sqlite-vec loaded dynamically.
**Limitations**: ChromaDB-level sophistication missing. No feedback loops. No content-type-aware ranking.

### Finding 2: OMEGA Memory — 95.4% LongMemEval
**Source**: [omega-memory/core](https://github.com/omega-memory/core) (GitHub)
**What it does**: 25 MCP tools, SQLite single-DB design (`~/.omega/omega.db`), 384-dim BGE-Small-EN-V1.5 embeddings via ONNX, hybrid search (vector + FTS5 + contextual re-ranking). Proactive memory surfacing via hooks on Edit/Write/Bash/Read. Scores 95.4% on LongMemEval.
**What to steal**: The proactive surfacing pattern — hooking into tool use events (Edit, Write) to automatically query and surface relevant memories. Their deduplication (SHA256 + embedding similarity >= 0.85) and memory-type weighting (decisions/lessons scored 2x) are directly applicable to Claudex.
**Limitations**: 25+ tools is MCP tool bloat. Claudex should expose fewer, more focused tools.

### Finding 3: SQLite WAL Mode for Concurrent MCP Sessions
**Source**: [Dev.to — Fixing Claude Code's Concurrent Session Problem](https://dev.to/daichikudo/fixing-claude-codes-concurrent-session-problem-implementing-memory-mcp-with-sqlite-wal-mode-o7k) (2026)
**What it does**: Solves "database is locked" errors when multiple Claude Code sessions access the same MCP memory. Uses `pragma journal_mode = WAL` and `pragma busy_timeout = 5000` with better-sqlite3's `.transaction()` for atomicity.
**What to steal**: Claudex already uses WAL mode, but the pattern of publishing as an MCP server (npm: `@pepk/mcp-memory-sqlite`) with entities/observations/relations tables + CASCADE deletion is a clean reference for Claudex's MCP exposure.
**Limitations**: No FTS5 or vector search. Basic entity-relation model only.

### Finding 4: OpenMemory — Hierarchical Memory Decomposition
**Source**: [CaviraOSS/OpenMemory](https://github.com/CaviraOSS/OpenMemory) (GitHub)
**What it does**: 5 memory sectors (episodic, semantic, procedural, emotional, reflective) with independent decay curves per sector. Composite scoring: salience + recency + coactivation. Temporal knowledge graph with `valid_from`/`valid_to` for fact lifecycles.
**What to steal**: Independent decay curves per memory type. Claudex currently uses uniform TTL — having decisions decay slower than observations (which it partially does via importance) could be formalized per-type. The `valid_from`/`valid_to` pattern for facts that become outdated is excellent.
**Limitations**: Heavy architecture. The 5-sector model may be over-engineered for Claudex's use case.

### Finding 5: gnosis-mcp — FTS5 + RRF Hybrid Search
**Source**: [nicholasglazer/gnosis-mcp](https://github.com/nicholasglazer/gnosis-mcp) (GitHub)
**What it does**: Zero-config MCP server. SQLite + FTS5 (BM25 ranking) + optional sqlite-vec vectors. Reciprocal Rank Fusion (RRF) to merge keyword and semantic results. 9,800 QPS at 100 docs, 3,500 QPS at 500 docs/1,500 chunks.
**What to steal**: RRF for merging FTS5 and vector results — it's simpler than learning a reranker and works well empirically. Their performance numbers (sub-millisecond p50 latency) confirm FTS5 scales fine for Claudex's 16K observations.
**Limitations**: Python (aiosqlite), not Node.js. Would need translation to better-sqlite3 patterns.

### Finding 6: Codebase-Memory-MCP — Knowledge Graph for Code
**Source**: [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (GitHub)
**What it does**: Indexes codebases into a SQLite knowledge graph via tree-sitter. Cypher-like query syntax. 14 MCP tools. Sub-ms queries, 99.2% token reduction vs file-by-file grep. Incremental updates via content-hash tracking.
**What to steal**: Content-hash tracking for incremental updates (skip unchanged items). The concept of precomputed relationship graphs — Claudex could precompute artifact relationships instead of computing them at query time.
**Limitations**: Go binary, not Node.js. Focused on code structure, not conversation/decision memory.

---

## Topic 3: FTS5 Across Multiple Content Types

### Finding 1: FTS5 Column Weighting via bm25()
**Source**: [SQLite FTS5 Extension docs](https://www.sqlite.org/fts5.html) + [TheLinuxCode FTS5 patterns](https://thelinuxcode.com/sqlite-full-text-search-fts5-in-practice-fast-search-ranking-and-real-world-patterns/)
**What it does**: FTS5's `bm25(table, w0, w1, ...)` accepts per-column weights. A column storing "decision" content can be weighted 2x versus "observation" content.
**What to steal**: Single unified FTS5 table with a `content_type` column AND per-type weighting at query time. `SELECT *, bm25(fts_all, 2.0, 1.0, 1.5) as score FROM fts_all WHERE fts_all MATCH ? ORDER BY score` — with columns ordered as [decision_text, observation_text, artifact_text].
**Limitations**: Column weights are static per query, not per-document. Dynamic content-type-aware ranking requires a custom ranking function or post-query re-weighting.

### Finding 2: KohakuVault Two-Table Pattern
**Source**: [KohakuVault FTS5+BM25 Integration](https://deepwiki.com/KohakuBlueleaf/KohakuVault/6.2-fts5-integration-and-bm25-ranking)
**What it does**: Separates FTS5 virtual table (indexed text + value_ref) from a values table (BLOBs). Prevents large data from bloating the inverted index. Negative BM25 scores negated to positive for consistency.
**What to steal**: The two-table pattern. Store full content in the main tables, but only index searchable text + type metadata in FTS5. This keeps the FTS5 index lean. Also: their `escape_fts5_query()` function that handles special characters — Claudex likely has the same problem with user prompts containing FTS5 operators.
**Limitations**: Python implementation. Needs translation.

### Finding 3: FTS5 at Scale — 15M Records
**Source**: [Hacker News discussion](https://news.ycombinator.com/item?id=41207085) (Aug 2024)
**What it does**: Production deployment with 15M records sharded across 16 cores. 200K record DB returns results in ~150ms for 3-term queries. Smaller DBs (thousands-hundreds of thousands) respond in ~10ms.
**What to steal**: At Claudex's scale (16K observations, growing ~80KB/day), FTS5 will be sub-10ms for years. No sharding needed. The concern about FTS5 performance at scale is a non-issue for this use case.
**Limitations**: Sharding approach (randomized row distribution) would lose BM25 consistency without adjustment — but irrelevant at Claudex's scale.

### Finding 4: sqlite-memory Hybrid Retrieval
**Source**: [sqliteai/sqlite-memory](https://github.com/sqliteai/sqlite-memory) (GitHub)
**What it does**: Configurable `vector_weight` (default 0.6) and `text_weight` (default 0.4) for hybrid ranking. 4x oversampling from each method before merging. Content hashing for change detection.
**What to steal**: The weight-tuning pattern. Start with 60/40 vector/keyword split, measure retrieval quality, adjust. The 4x oversampling before merge ensures neither method dominates when result sets have different distributions.
**Limitations**: C extension (llama.cpp for embeddings). Not directly usable from better-sqlite3 without the extension binary.

### Finding 5: FTS5 Performance Regression Warning
**Source**: [SQLite Forum — FTS5 regression in 3.51.0](https://sqlite.org/forum/info/757413557cef5adbfd986b0b179d9009084a9b2864469ab9641f39eb528bb66d) (2025)
**What it does**: Reports 8.4x slowdown for prepared statements in SQLite 3.51.2 vs 3.50.4. Fixed in subsequent releases.
**What to steal**: Pin SQLite version in production. better-sqlite3 bundles a specific SQLite version — verify it's not affected. This is a real production risk.
**Limitations**: Specific to one version range, likely patched.

---

## Topic 4: Predictive Experience Pattern Matching

### Finding 1: OMEGA — Hook-Based Proactive Surfacing
**Source**: [omega-memory/core](https://github.com/omega-memory/core) (GitHub)
**What it does**: 7 hook processes with 11 handlers. `surface_memories` fires on Edit/Write/Bash/Read tool use, extracting semantic intent from tool input and querying relevant memories. Auto-creates `related` edges to top-3 similar memories (similarity >= 0.45).
**What to steal**: The pattern of extracting semantic intent FROM THE TOOL INPUT (not the user prompt) and using that to query memories. When a user edits `migrations.ts`, the tool input path IS the query — no NLP needed. Claudex's PostToolUse already receives `tool_input` with file paths.
**Limitations**: Requires embedding model for semantic matching. Claudex can start with file-path-based matching (cheaper) and add embeddings later.

### Finding 2: Codified Context Trigger Tables
**Source**: [Codified Context paper](https://arxiv.org/html/2602.20478v1) (Feb 2026)
**What it does**: Trigger table maps observable signals (file paths being modified) to specialized agents. Removes developer decision-making from the loop.
**What to steal**: Build a `pattern_triggers` table: `(glob_pattern, knowledge_domain, priority)`. When PostToolUse fires on a file matching `src/adapters/**`, surface all learnings/decisions tagged with the "adapters" domain. This is pure SQL — no ML required.
**Limitations**: Requires manual curation of trigger patterns. But Claudex's existing `experience_patterns` table could be adapted.

### Finding 3: Claude Code Hooks as Enforcement Gates
**Source**: [Claude Code hooks documentation](https://claude.com/blog/how-to-configure-hooks) + [Pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
**What it does**: PreToolUse hooks can approve/deny/ask on tool executions. They receive `$TOOL_INPUT_file_path` and full JSON input. PostToolUse hooks capture results.
**What to steal**: Using PreToolUse to inject warnings BEFORE the edit happens. If a file has known patterns/footguns (stored in DB), surface them as warnings before Claude writes code. This is the "proactive warning" pattern — context delivered before the action, not after.
**Limitations**: PreToolUse adds latency to every tool call. Need to be fast (< 50ms) or the UX degrades.

### Finding 4: SuperLocalMemory V3 — Pattern Detection via Math
**Source**: [varun369/SuperLocalMemoryV2](https://github.com/varun369/SuperLocalMemoryV2) (GitHub, 4.3K stars)
**What it does**: Behavioral pattern detection through continuous access monitoring. Uses Bayesian Beta distributions for trust scores. Fisher-Rao metric for similarity scoring. 4-channel parallel hybrid search (semantic + BM25 + entity graph + temporal).
**What to steal**: RRF (Reciprocal Rank Fusion) with k=60 for merging multiple search channels. The pattern detection via access monitoring — track which memories get accessed together to build implicit associations.
**Limitations**: Heavy math (differential geometry, algebraic topology). Overkill for Claudex unless significantly simplified.

### Finding 5: Linting as AI Guidance
**Source**: [Kinde — AI Code Review Automation Building Custom Linting Rules with LLMs](https://www.kinde.com/learn/ai-for-software-engineering/code-reviews/ai-code-review-automation-building-custom-linting-rules-with-llms/)
**What it does**: Natural language linting rules that LLMs can enforce. "Ensure all new public API endpoints include rate limiting" — rules created as human-readable instructions, enforced by AI during review.
**What to steal**: Experience patterns as natural-language lint rules. When pattern says "never use `bun test` — use `vitest`", that's a lint rule that should fire when Bash tool is used with `bun test` in the command. Pattern matching on tool_input, not just file paths.
**Limitations**: Requires running patterns through an LLM or regex engine at hook time.

---

## Topic 5: Feedback Loops on Retrieval Quality

### Finding 1: NirDiamant RAG_Techniques — Feedback Loop Implementation
**Source**: [NirDiamant/RAG_Techniques](https://github.com/NirDiamant/RAG_Techniques) (GitHub, 11K+ stars)
**What it does**: Feedback stored as JSON: {query, response, relevance_rating, quality_rating, comments}. LLM-based relevance checker compares stored feedback against current documents. High-quality responses (relevance >= 4, quality >= 4) create synthetic documents that reinforce valuable patterns.
**What to steal**: The synthetic document creation pattern. When a retrieved context gets positive feedback (user used it, task succeeded), create a reinforced version that scores higher in future searches. For Claudex: when an injected learning/artifact is followed by a successful outcome, boost its retrieval score.
**Limitations**: Uses LLM-in-the-loop for relevance checking — expensive for hook-time processing. Simpler heuristics (access count, recency decay) may suffice.

### Finding 2: FeedbackRAG — Three-Loop Architecture
**Source**: [FeedbackRAG (Nov 2025)](https://journal.rais.education/index.php/raiss/article/view/315)
**What it does**: Loop A: real-time bias updates with decay-weighted confidence. Loop B: aggregated feedback trains reranker via contrastive learning. Loop C: generator governance (tighten prompts or abstain on hallucination risk).
**What to steal**: Loop A is directly applicable — decay-weighted confidence on retrieved chunks. Every time context is injected and the session goes well (no corrections, task completed), increase confidence. When context is injected and user corrects/overrides, decrease it. Simple exponential decay: `new_score = old_score * decay + signal * (1 - decay)`.
**Limitations**: Loop B (contrastive learning) requires ML infrastructure Claudex doesn't have. Loop C requires evaluating generation quality, which hooks can't directly observe.

### Finding 3: Pistis-RAG — Human Feedback for Ranking
**Source**: [Pistis-RAG](https://arxiv.org/html/2407.00072v5) (AAAI 2024, updated 2025)
**What it does**: Five-stage pipeline (Matching, Pre-Ranking, Ranking, Reasoning, Aggregation). User actions (copy, regenerate, dislike) collected as training data. Listwide learning-to-rank approach.
**What to steal**: The implicit signal taxonomy. For Claudex: copy = user referenced the context (positive). Correction = user overrode the context (negative). Ignore = context was noise (mild negative). These signals are observable from hook data without explicit user feedback.
**Limitations**: Requires aggregating signals over many sessions to be statistically meaningful. Cold-start problem for new content.

### Finding 4: Implicit Feedback via User Behavior
**Source**: [ThirdAI Blog — Cross the Chasm with RAG](https://medium.com/thirdai-blog/cross-the-chasm-with-rag-implicit-feedback-and-click-through-data-a9eee6e7ec47)
**What it does**: Tracks implicit signals: copy-pasting (satisfaction), clicking cited sources (relevance), quick abandonment/reformulation (dissatisfaction). Hard negatives identified when users immediately refine queries after viewing responses.
**What to steal**: For Claudex: if injected context is followed by the user asking a follow-up that contradicts or ignores it, that's a negative signal. If the assistant's response references the injected context, that's a positive signal. Both are detectable from Stop hook data.
**Limitations**: Requires comparing injected context against assistant output — needs text similarity, not just keyword matching.

### Finding 5: ExpeL — Experiential Learning for Agents
**Source**: [LeapLabTHU/ExpeL](https://github.com/LeapLabTHU/ExpeL) (GitHub, AAAI 2024)
**What it does**: Two-stage: experience gathering (store successful trajectories) + insight extraction (distill high-level rules from experience). Uses Faiss vectorstore + kNN retriever for experience recall. top-k successful trajectories retrieved by task similarity.
**What to steal**: The two-stage pattern maps directly to Claudex. Stage 1: Claudex already stores observations/decisions. Stage 2: insight extraction (promote observations to learnings) already exists but is keyword-based. Adding embedding similarity for experience recall would improve retrieval quality significantly.
**Limitations**: Python/Faiss. Translation to SQLite + sqlite-vec needed.

---

## Topic 6: Cross-Session Thread Reconstruction

### Finding 1: Chronos — Temporal Event Extraction
**Source**: [Chronos (LoResMT 2026, EACL)](https://arxiv.org/html/2603.16862) (Mar 2026)
**What it does**: Decomposes dialogue into SVO (subject-verb-object) tuples with resolved datetime ranges + entity aliases. Dual calendar: event calendar (structured) + turn calendar (raw context). Dense search (top-100) -> Cohere Rerank (top-15) -> context expansion. 95.6% accuracy on LongMemEval.
**What to steal**: SVO extraction adapted for coding: subjects = code entities (functions, files), verbs = operations (defined, modified, debugged), objects = dependencies/values. Store these as structured events alongside raw observations. At session start, reconstruct "what happened" by querying events by entity/time.
**Limitations**: Requires LLM for SVO extraction at observation time. Chronos uses text-embedding-3-large + Cohere Rerank — expensive stack.

### Finding 2: Episodic Memory for Claude Code
**Source**: [obra/episodic-memory](https://github.com/obra/episodic-memory) (GitHub)
**What it does**: Syncs conversation files from `~/.claude/projects`, parses JSONL exchanges, generates embeddings via Transformers.js (offline), indexes in SQLite + sqlite-vec. MCP server exposes search across past conversations. Date-range filtering, multi-concept AND searches.
**What to steal**: Direct parsing of Claude Code's conversation JSONL files as a source for cross-session reconstruction. Claudex currently relies on hook-captured data — adding conversation file parsing would capture context that hooks miss (e.g., assistant reasoning).
**Limitations**: Focused on conversation search, not structured reconstruction. No synthesis of "what happened last session."

### Finding 3: Mem0 — Memory Processing Pipeline
**Source**: [Mem0 (DeepWiki)](https://deepwiki.com/mem0ai/mem0) (2025-2026)
**What it does**: LLM-powered fact extraction from conversations. Each fact classified as ADD/UPDATE/DELETE/NOOP. Parallel writes to vector store + SQLite history. Four scoping levels: user/agent/app/session.
**What to steal**: The ADD/UPDATE/DELETE/NOOP classification. When a new observation arrives that contradicts an existing one, mark the old one as superseded (not deleted). Claudex's artifacts already have states (fresh/packed) — adding "superseded" with a reference to the superseding observation enables temporal truth tracking.
**Limitations**: Requires LLM at ingestion time for fact classification. Claudex could use simpler heuristics (text similarity > threshold = potential update).

### Finding 4: A-Mem — Zettelkasten for Agents
**Source**: [agiresearch/A-mem](https://github.com/agiresearch/A-mem) (NeurIPS 2025)
**What it does**: Each memory is a "note" with: content, tags, category, timestamp, context (LLM-generated), keywords (auto-extracted), dense embedding, and links to related notes. When new memories arrive, they trigger updates to existing memories' context.
**What to steal**: Memory evolution — when a new observation is added, automatically update related existing observations' metadata/context. Claudex's artifact system could add a `last_context_update` timestamp and periodically re-evaluate relationships.
**Limitations**: ChromaDB-based, requires LLM for context generation. Translation to SQLite + heuristic context needed.

### Finding 5: WebCoach — Episodic Experience Store
**Source**: [WebCoach (arXiv 2511.12997)](https://arxiv.org/abs/2511.12997) (Nov 2025)
**What it does**: Three components: WebCondenser (standardizes navigation logs), External Memory Store (stores completed trajectories as episodes), Coach (retrieves relevant experiences by similarity + recency, decides whether to inject advice at runtime). Only COMPLETED trajectories are persisted — partial ones are discarded.
**What to steal**: The completed-trajectory-only persistence pattern. Claudex should weight session-end summaries higher than mid-session observations for cross-session reconstruction. The Coach pattern (retrieve + decide whether to inject) maps to Claudex's assembly threshold logic.
**Limitations**: Web browsing domain. Adaptation to coding requires different "trajectory completion" signals.

### Finding 6: MAGMA — Multi-Graph Memory Architecture
**Source**: [MAGMA (arXiv 2601.03236)](https://arxiv.org/html/2601.03236v1) (Jan 2026)
**What it does**: Four orthogonal graphs (temporal, causal, semantic, entity) stored as typed edges over the same node set. Intent-aware query: maps query intent (why/when/entity) to graph type priority. Heuristic beam search with RRF anchoring. 45.5% higher reasoning accuracy, 95% fewer tokens.
**What to steal**: The intent-to-graph-type routing. For Claudex: "what did I decide about X?" routes to decision edges. "When did we change Y?" routes to temporal edges. "Why did we do Z?" routes to causal edges. This can be implemented as typed edges in SQLite without a full graph DB.
**Limitations**: Academic prototype. Heavy infrastructure (4 separate graphs, beam search, RRF). Needs significant simplification for SQLite.

---

## Synthesis

### Top 5 Patterns Worth Adopting

1. **File-path trigger tables for context routing** (from Codified Context + OMEGA). Map file globs to knowledge domains in a `pattern_triggers` table. When PostToolUse fires on a file matching a glob, surface domain-specific learnings. No ML required — pure SQL pattern matching. This replaces FTS5 keyword matching against user prompts as the primary context selection mechanism.

2. **Hybrid FTS5 + sqlite-vec search with RRF merging** (from gnosis-mcp + sqlite-memory + SuperLocalMemory). Use FTS5 for keyword recall and sqlite-vec for semantic similarity. Merge results via Reciprocal Rank Fusion (simpler than training a reranker). Start with 60/40 vector/keyword weighting. gnosis-mcp proves sub-ms latency at Claudex's scale.

3. **Implicit feedback from hook data** (from FeedbackRAG + Pistis-RAG). Track whether injected context was referenced in the assistant's response (Stop hook). If referenced: boost retrieval score. If contradicted or ignored: decrease. Exponential decay-weighted confidence: `score = score * 0.95 + signal * 0.05`. No explicit user feedback needed.

4. **Structured event extraction for cross-session reconstruction** (from Chronos + MAGMA). At Stop hook, extract key events as structured tuples: `(entity, action, target, timestamp)`. Store in an `events` table with typed edges (temporal, causal). At session start, reconstruct "what happened" by querying events for the current project, ordered by time. Replaces handwritten handoff notes.

5. **MCP tool exposure for on-demand recall** (from Memento + OMEGA + gnosis-mcp). Expose Claudex's DB as 3-5 MCP tools: `claudex_search` (hybrid query), `claudex_recall` (retrieve specific memory by ID), `claudex_store` (explicitly save a decision/learning), `claudex_context` (get assembled context for current task). Enables workers and agents to query mid-task, not just at spawn time.

### Recommended Approach Per Topic

| Topic | Recommended Approach | Stack |
|-------|---------------------|-------|
| 1. Task-aware assembly | File-glob trigger table + hook-driven routing | SQLite table + PostToolUse hook logic |
| 2. MCP for memory | Expose 3-5 focused MCP tools over existing DB | fastmcp or custom MCP server in Node.js |
| 3. FTS5 multi-type | Single unified FTS5 table with content_type column + bm25() column weighting | better-sqlite3 FTS5 (already available) |
| 4. Predictive patterns | File-path glob matching in PreToolUse + pattern_triggers table | SQLite GLOB/LIKE + existing hook infrastructure |
| 5. Feedback loops | Decay-weighted confidence score on observations/artifacts, updated from Stop hook data | New `retrieval_score` column + Stop hook logic |
| 6. Cross-session reconstruction | Structured events table + temporal query at session start | New `events` table + UserPromptSubmit assembly |

### What to Build vs What to Borrow

**Build (implement yourself)**:
- File-glob trigger table and routing logic (too specific to Claudex's hook model)
- Implicit feedback scoring from hook data (novel combination of existing hooks)
- Structured event extraction at Stop hook (domain-specific to coding workflows)
- MCP server wrapping existing Claudex DB (thin layer over existing queries)
- Content-type-aware FTS5 ranking (simple bm25() weight tuning)

**Borrow (npm install or adapt)**:
- `sqlite-vec` for vector search (npm: `sqlite-vec`, works with better-sqlite3)
- `@xenova/transformers` or `onnxruntime-node` for local embeddings (BGE-Small-EN 384-dim is sufficient)
- RRF algorithm (10 lines of code, well-documented in gnosis-mcp and SuperLocalMemory)
- `escape_fts5_query()` pattern from KohakuVault (prevent FTS5 syntax errors from user input)

### Estimated Complexity

| Topic | Complexity | What Makes It Hard |
|-------|-----------|-------------------|
| 1. Task-aware assembly | **Small** | Trigger table schema + PostToolUse routing. Mostly SQL + hook logic. Hard part: curating initial trigger patterns. |
| 2. MCP tools | **Medium** | MCP server boilerplate + tool definitions + query translation. Hard part: deciding tool granularity (too few = limited, too many = confusion). |
| 3. FTS5 multi-type | **Small** | Unified FTS5 table + bm25() weights. Migration of existing FTS5 usage. Hard part: tuning weights empirically. |
| 4. Predictive patterns | **Small-Medium** | Glob matching in hooks is simple. Hard part: building the pattern-to-knowledge-domain mapping without manual curation. |
| 5. Feedback loops | **Medium** | New scoring column + Stop hook analysis. Hard part: detecting whether injected context was "used" by the assistant (requires text similarity). |
| 6. Cross-session reconstruction | **Medium-Large** | Event extraction needs structured parsing. Hard part: extracting meaningful (entity, action, target) tuples from free-text observations without an LLM. |

### What Nobody Is Doing Yet (Gaps = Opportunities)

1. **Tool-input-aware context retrieval**. Everyone searches by user prompt text or embeddings. Nobody is using the TOOL INPUT (file path, command, code being written) as the retrieval query. Claudex's hooks already have this data. Matching experience patterns against `tool_input.file_path` rather than `user_prompt` is a massive untapped signal.

2. **Feedback loops without explicit user signals**. Every feedback RAG system asks users to rate or click. Nobody is inferring retrieval quality from whether the assistant's response REFERENCES the injected context. Claudex can compare injected context at UserPromptSubmit against assistant output at Stop — if the assistant used the knowledge, it was useful.

3. **Content-type-aware FTS5 ranking in a single table**. Everyone either uses separate FTS5 tables per type OR a single table with uniform ranking. Nobody is using bm25() column weighting where columns represent content types (decisions, observations, artifacts). This gives type-prioritized search with zero infrastructure cost.

4. **Hook-driven event extraction for session reconstruction**. Everyone relies on either full conversation replay (expensive) or handwritten handoff notes (manual). Nobody is extracting structured events from each hook invocation (PostToolUse: "edited file X", "ran test Y") and synthesizing session summaries from those events at session end. Claudex's existing hooks fire at every boundary — it's already capturing the raw events.

5. **Decay curves per memory type**. OpenMemory proposes this but nobody has shipped it in production. Decisions should decay slower than observations. Learnings should decay slower than decisions. Error patterns should NEVER decay (they're always relevant). Claudex's existing importance/TTL system could be enhanced with type-specific decay functions.

Sources:
- [Codified Context: Infrastructure for AI Agents](https://arxiv.org/html/2602.20478v1)
- [Spotify Context Engineering (Honk Part 2)](https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2)
- [Anthropic — Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Martin Fowler — Context Engineering for Coding Agents](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)
- [ETH Zurich AGENTS.md Study](https://www.infoq.com/news/2026/03/agents-context-file-value-review/)
- [iAchilles/memento (SQLite + FTS5 + sqlite-vec MCP)](https://github.com/iAchilles/memento)
- [omega-memory/core](https://github.com/omega-memory/core)
- [SQLite WAL for concurrent MCP sessions](https://dev.to/daichikudo/fixing-claude-codes-concurrent-session-problem-implementing-memory-mcp-with-sqlite-wal-mode-o7k)
- [CaviraOSS/OpenMemory](https://github.com/CaviraOSS/OpenMemory)
- [nicholasglazer/gnosis-mcp (FTS5 + RRF)](https://github.com/nicholasglazer/gnosis-mcp)
- [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
- [SQLite FTS5 docs](https://www.sqlite.org/fts5.html)
- [KohakuVault FTS5 + BM25](https://deepwiki.com/KohakuBlueleaf/KohakuVault/6.2-fts5-integration-and-bm25-ranking)
- [FTS5 at 15M records (HN)](https://news.ycombinator.com/item?id=41207085)
- [sqliteai/sqlite-memory](https://github.com/sqliteai/sqlite-memory)
- [Claude Code hooks](https://claude.com/blog/how-to-configure-hooks)
- [varun369/SuperLocalMemoryV2](https://github.com/varun369/SuperLocalMemoryV2)
- [NirDiamant/RAG_Techniques](https://github.com/NirDiamant/RAG_Techniques)
- [FeedbackRAG](https://journal.rais.education/index.php/raiss/article/view/315)
- [Pistis-RAG](https://arxiv.org/html/2407.00072v5)
- [ThirdAI — Implicit Feedback in RAG](https://medium.com/thirdai-blog/cross-the-chasm-with-rag-implicit-feedback-and-click-through-data-a9eee6e7ec47)
- [LeapLabTHU/ExpeL](https://github.com/LeapLabTHU/ExpeL)
- [Chronos (EACL 2026)](https://arxiv.org/html/2603.16862)
- [obra/episodic-memory](https://github.com/obra/episodic-memory)
- [Mem0 (DeepWiki)](https://deepwiki.com/mem0ai/mem0)
- [agiresearch/A-mem (NeurIPS 2025)](https://github.com/agiresearch/A-mem)
- [WebCoach](https://arxiv.org/abs/2511.12997)
- [MAGMA](https://arxiv.org/html/2601.03236v1)
- [MemTensor/MemOS](https://github.com/MemTensor/MemOS)
- [sqlite-vec (better-sqlite3 compatible)](https://github.com/asg017/sqlite-vec)
- [Awesome MCP Servers — Memory](https://github.com/TensorBlock/awesome-mcp-servers/blob/main/docs/knowledge-management--memory.md)
- [Claude Code Session Memory](https://claudefa.st/blog/guide/mechanics/session-memory)
