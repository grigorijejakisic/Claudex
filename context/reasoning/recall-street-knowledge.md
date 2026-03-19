# Claudex Recall — Street Knowledge Research
Date: 2026-03-19

## Top Findings

### Real Projects Doing What We Need

| Project | Stars | What | Key Pattern |
|---------|-------|------|-------------|
| **Rifflux** | New | Local hybrid retrieval (FTS5 + embeddings + RRF) for markdown | FTS5 + local embeddings + RRF fusion via MCP tools |
| **claude-chat-search** | New | Indexes Claude Code JSONL into SQLite FTS5 + sqlite-vec | Daemon-based background indexing, multi-signal RRF |
| **Srclight** | 19 | Deep code indexer with 29 MCP tools | Multi-tokenizer FTS5, ATTACH + UNION for cross-DB search |
| **sqlite-vec** | 7.2K | Vector search extension for SQLite | `sqliteVec.load(db)` with better-sqlite3, `vec0` virtual tables |
| **Letta (MemGPT)** | 21.7K | Stateful AI agents with structured memory | Two-tier: always-injected core + on-demand searchable archive |
| **mem0** | 50.4K | Memory layer for AI agents | LLM-driven fact dedup, threshold filtering |
| **Khoj** | 33.5K | Personal AI searching local docs + web + history | Multi-format ingestion + semantic + FTS hybrid |
| **Continue** | 31.9K | AI coding assistant | Multi-index architecture (FTS5 + embeddings queried in parallel) |

### Top 3 Patterns to Adopt

1. **Reciprocal Rank Fusion (RRF)** — `score(d) = sum(1/(k + rank_i(d)))`, k=60. Position-based, no score normalization needed. Used by Srclight, Rifflux, claude-chat-search, Haystack.

2. **sqlite-vec + FTS5 hybrid in same DB** — sqlite-vec loads into better-sqlite3 with one line. Entire Recall system = single `.db` file. At 16K observations, brute-force KNN < 10ms.

3. **Source-typed FTS5 with UNION ALL** — Separate FTS5 tables per source (observations, memory files, session logs, handoffs). UNION ALL with `source` column gives provenance for free.

### Recommended Architecture

```
Query (user prompt or explicit /recall)
  → FTS5 search (observations + memory_files + session_logs + handoffs — UNION ALL)
  → Vec search (sqlite-vec embeddings via Ollama nomic-embed-text)
  → File scan (memory/*.md, context/sessions/*.md)
  → RRF Fusion (merge all ranked lists, k=60)
  → Provenance annotation ("from memory file X", "from session 12")
  → Priority budget cut (token limit)
  → Inject into context
```

### What to Build vs Borrow

**Borrow:** sqlite-vec (npm), Ollama embeddings (already have)

**Build:**
- File indexer (memory files, session logs → FTS5 + vec0 tables)
- RRF fusion (~20 lines TypeScript)
- Source provenance annotation
- Incremental re-indexing (file mtime)
- Hook integration (extend UserPromptSubmit)

**Don't build:** HNSW index (brute-force fine at our scale), graph memory (overkill), LLM-in-the-loop dedup (too expensive per hook)

### Estimated Complexity: 2-3 sessions

Heaviest: embedding pipeline + file indexer. Must degrade gracefully to FTS5-only when Ollama unavailable (pattern already exists in topic-shift).

## Detailed Findings

### 1. Unified Search Across Heterogeneous Sources

- **Rifflux** — Local/offline hybrid retrieval for markdown. SQLite FTS5/BM25 + local embeddings, RRF fusion. MCP tools (`search_rifflux`, `get_chunk`, `reindex`). Incremental indexing with git fingerprints.
- **claude-chat-search** — Indexes Claude Code JSONL into SQLite with FTS5 + sqlite-vec. RRF merging vector + keyword + grep + path filter. Background daemon polls queue file every 2s.
- **Srclight** — 3 separate FTS5 indexes with different tokenizers (name-aware, trigram, Porter). Embeddings as BLOBs, ~3ms for 27K vectors. Multi-repo via ATTACH + UNION.
- **ripgrep-all** (9.5K stars) — Extends ripgrep to PDFs, SQLite, archives. Adapter pattern per source type.
- **Unstructured** (14.3K stars) — ETL for heterogeneous docs to structured elements. Auto-detects format.

### 2. Hybrid Retrieval (FTS + Semantic)

- **sqlite-vec** (7.2K stars) — Pure C SQLite extension, zero deps. `vec0` virtual tables, KNN via `WHERE embedding MATCH ?`. Node.js: `sqliteVec.load(db)` with better-sqlite3. 16K vectors = trivial.
- **sqfox** — HNSW graph serialized as CSR BLOB in SQLite. Single-writer + WAL readers. Adaptive alpha score fusion.
- **Haystack DocumentJoiner** — 4 fusion algorithms: concatenate, weighted merge, RRF, distribution-based rank fusion.
- **txtai** (12.3K stars) — SQLite + vector indexes + unified query. Local-first.

### 3. LLM Memory/Recall Systems

- **Letta/MemGPT** (21.7K stars) — Two-tier: core memory (always injected) + archival memory (searched via tools). Auto-summarization on token pressure.
- **mem0** (50.4K stars) — LLM-driven fact extraction, vector search, memory actions (ADD/UPDATE/DELETE). Threshold filtering.
- **Khoj** (33.5K stars) — Multi-format doc ingestion + conversation history + semantic retrieval. Local LLM support.
- **Zep/Graphiti** (4.3K stars) — Temporal knowledge graphs. Facts with valid_at/invalid_at timestamps. Graph RAG.
- **MCP Memory Server** — Knowledge graph with entities/relations/observations in JSONL. Simple but reference API.
- **llm CLI** (11.4K stars, Simon Willison) — SQLite-backed conversation logs. Fragment system for reusable prompts.

### 4. Context-Aware Retrieval Triggers

- **FLARE** — Confidence-based trigger during generation. Not applicable to hooks (pre/post, not during).
- **MemWalker** — Hierarchical summary tree navigation. Maps to Claudex's learnings → sessions → observations hierarchy.
- **Practical for Claudex:** (1) Prompt keyword detection in UserPromptSubmit, (2) post-compact reassembly trigger (exists), (3) artifact materialization on search (exists), (4) explicit tool exposure (`claudex_recall`).

### 5. SQLite-Native Approaches

- sqlite-vec is THE extension to use. FTS5 across tables via UNION ALL. At our scale, no HNSW needed.
- CozoDB (3.9K stars) — Datalog + FTS + HNSW + MinHash. Different ecosystem, not worth switching.
- LanceDB (9.5K stars) — Embedded vector DB, native TypeScript. But separate from SQLite.

### 6. CLI-First Retrieval Tools

- **Priompt** (2.8K stars, Cursor) — JSX-based priority budgeted prompt assembly. Binary search for optimal priority cutoff. Directly applicable to Recall's output stage.
- **Continue** (31.9K stars) — Multi-index: CodeSnippetsIndex, FTS5 index, chunk embeddings, LanceDb. Incremental indexing via timestamp comparison.
