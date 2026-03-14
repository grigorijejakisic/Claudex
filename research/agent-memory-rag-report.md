# Agent Memory RAG: What Works in Practice

Research compiled 2026-03-13. Focused on real implementations, not theory.

---

## Executive Summary

The agent memory landscape has matured significantly through 2025-2026. The key finding: **there is no single best architecture**. The winning approach depends on scale (single-user local vs. enterprise multi-tenant), latency requirements, and whether you need the agent to manage its own memory or have the system do it automatically. The most practical, battle-tested pattern for a local-first tool is **SQLite FTS5 + sqlite-vec hybrid search with Reciprocal Rank Fusion**, which delivers sub-3ms retrieval on even a Raspberry Pi. For production multi-tenant systems, Mem0 and Hindsight lead with structured memory networks and graph-augmented retrieval.

---

## 1. Retrieval Architectures That Actually Work

### 1A. Hybrid FTS5 + Vector Search (Best for Local-First / Embedded)

**The pattern:** Two SQLite virtual tables side-by-side — FTS5 for keyword/BM25 matching, sqlite-vec for cosine similarity on embeddings. Results merged via Reciprocal Rank Fusion (RRF).

**Implementation (from Alex Garcia, sqlite-vec creator):**

```sql
-- FTS5 index (external content, stores only the index)
CREATE VIRTUAL TABLE fts_memory USING fts5(
  content, content='memories', content_rowid='id'
);

-- Vector index (768-dim embeddings)
CREATE VIRTUAL TABLE vec_memory USING vec0(
  memory_id INTEGER PRIMARY KEY,
  embedding float[768]
);

-- Hybrid RRF query
WITH vec_matches AS (
  SELECT memory_id,
         row_number() OVER (ORDER BY distance) AS rank_number
  FROM vec_memory
  WHERE embedding MATCH lembed(:query) AND k = :k
),
fts_matches AS (
  SELECT rowid,
         row_number() OVER (ORDER BY rank) AS rank_number
  FROM fts_memory
  WHERE content MATCH :query
  LIMIT :k
)
SELECT memories.*,
  (COALESCE(1.0 / (:rrf_k + fts_matches.rank_number), 0.0) * :weight_fts +
   COALESCE(1.0 / (:rrf_k + vec_matches.rank_number), 0.0) * :weight_vec)
    AS combined_rank
FROM fts_matches
FULL OUTER JOIN vec_matches ON vec_matches.memory_id = fts_matches.rowid
JOIN memories ON memories.rowid = COALESCE(fts_matches.rowid, vec_matches.memory_id)
ORDER BY combined_rank DESC;
```

**Performance (ZeroClaw benchmarks on Raspberry Pi Zero 2 W):**
- Total retrieval: <3ms
- FTS5 search: ~0.3ms
- Vector search: ~2ms
- Result merging: ~0.1ms
- Compare: Pinecone/Weaviate network round-trip = 10-50ms

**Scoring weights:** Default 0.6 vector / 0.4 FTS (sqlite-memory project). RRF constant k=60 is the industry standard. Documents appearing in both result sets get boosted; single-method matches rank lower.

**sqlite-vec scaling limits:** At 1M vectors with 3072 dimensions, brute-force scan takes ~8.5s. At 192 dimensions, ~192ms. Practical ceiling for latency-sensitive apps: hundreds of thousands of vectors depending on dimensionality. Binary quantization helps significantly.

**Real projects using this:**
- **sqlite-memory** (github.com/sqliteai/sqlite-memory) — Markdown-aware chunking, hybrid search, content-hash dedup, SAVEPOINT transactions
- **sqlite-rag** (github.com/sqliteai/sqlite-rag) — Full RAG pipeline with RRF, supports PDF/DOCX/code
- **Memento** (github.com/iachilles/memento) — MCP memory server, SQLite + FTS5 + sqlite-vec, knowledge graph with entities/observations/relations, BGE-M3 embeddings (1024-dim, runs offline)
- **OpenClaw** — Local-first agent memory, graceful degradation if extensions unavailable

**Verdict:** This is the best architecture for a local-first tool. Zero ops, single-file portability, ACID compliance, sub-millisecond FTS5, and good-enough vector search for datasets under ~100K memories. The Alex Garcia blog post is the canonical reference implementation.

### 1B. Hindsight: Four-Network Structured Memory (Best Benchmark Scores)

**Architecture:** Four parallel memory networks:
1. **World** — Objective external facts
2. **Bank** — Agent's own experiences (first-person)
3. **Observation** — Preference-neutral entity summaries
4. **Opinion** — Subjective judgments with confidence scores that evolve

**Retrieval (TEMPR — Temporal Entity Memory Priming Retrieval):**
Four parallel searches: semantic vector similarity, BM25 keyword, knowledge graph traversal, temporal filtering. Results merged via RRF + neural cross-encoder reranker.

**Benchmark:** 91.4% on LongMemEval (highest recorded). Multi-session questions improved from 21.1% to 79.7%. Temporal reasoning from 31.6% to 79.7%.

**Stack:** PostgreSQL backend, Python/Node SDKs, Docker deployment. Supports OpenAI/Anthropic/Gemini/Ollama.

**Practical assessment:** Heavy infrastructure (requires PostgreSQL), but the structured separation of memory types is the key insight. You don't need four networks — but separating "facts about the world" from "things I learned from experience" from "subjective preferences" dramatically improves retrieval relevance.

### 1C. Mem0: Production Memory Layer (Most Widely Adopted)

**Architecture:** Dual storage — vector DB for semantic retrieval + optional graph DB (Neo4j) for entity relationships. Three-level scoping: user, session, agent.

**How it works:**
1. Extract phase: LLM processes messages + historical context to create candidate memories
2. Update phase: Evaluate candidates against existing memories via tool-call mechanism (insert/update/delete)

**Performance:** 26% improvement over OpenAI on LLM-as-a-Judge metric. 91% lower p95 latency. 90%+ token cost savings vs. full context approaches. Sub-50ms retrieval latency.

**Graph memory variant (Mem0g):** Stores memories as directed labeled graphs — entities as nodes, relationships as edges. Enables multi-hop reasoning across connected facts.

**Practical issues:** ChromaDB backend suffers "database is locked" errors under concurrent load. Qdrant integration has had vector dimension mismatch bugs. For production, use Qdrant or PGVector over ChromaDB.

### 1D. GAM: Just-In-Time Memory Compilation

**Architecture:** Two-agent split:
- **Memorizer** — Runs offline, segments conversations into pages, tags with context
- **Researcher** — Activates on query, conducts deep research using vector search + BM25 + direct page access

**Key insight:** Store minimal cues + full raw archive. Compile tailored context on-the-fly per query (JIT pattern). Avoids premature compression that loses signal.

**Performance:** >90% accuracy on RULER Multi-Hop Tracing where other methods stagnate below 60%. Maintains >55% HotpotQA F1 even at 448K tokens.

### 1E. Observational Memory (Mastra): Simplest Architecture That Works

**Architecture:** No vector DB, no embeddings. Two background agents:
- **Observer** — Compresses unobserved messages into dated observations when they hit 30K tokens
- **Reflector** — Synthesizes observations into higher-level insights

**Context window layout:** Block 1 = observations (compressed history), Block 2 = current session messages.

**Compression ratios:** 3-6x for text, 5-40x for tool-heavy workloads.

**Benchmark:** 94.87% on LongMemEval (GPT-5-mini). 84.23% on GPT-4o vs. 80.05% for Mastra's own RAG.

**Cost advantage:** Stable context window enables aggressive caching. 10x cost reduction claimed.

**Verdict:** Surprisingly effective. No retrieval infrastructure at all — just text compression. Works well for conversational agents but less suitable for structured knowledge retrieval.

### 1F. Google's Always-On Memory Agent: No Vectors, Pure LLM

**Architecture:** Three sub-agents:
1. **Ingestion agent** — Processes incoming information
2. **Consolidation agent** — Runs every 30 minutes, merges/compresses memories
3. **Query agent** — Synthesizes answers from stored memories

**Storage:** Plain SQLite, no embeddings. The LLM itself reads, thinks, and writes structured memory.

**Assessment:** Provocative design that works for moderate-scale personal assistants. Consolidation quality depends entirely on LLM capability. Not suitable for large memory stores where you can't feed everything to the LLM.

---

## 2. Memory Types: What to Implement

The most practical taxonomy (from LangMem/Letta/research consensus):

| Memory Type | What It Stores | Storage Backend | Retrieval Method |
|---|---|---|---|
| **Working** | Current task context, conversation | In-context (prompt) | None needed — it's already there |
| **Episodic** | Specific interactions, "what happened" | Vector DB or FTS5 | Semantic similarity + temporal filtering |
| **Semantic** | Facts, relationships, extracted knowledge | Relational DB / knowledge graph | Keyword + graph traversal |
| **Procedural** | Learned workflows, effective strategies | Document store with metadata | Pattern matching on task type |

**What actually matters in practice:**
- Working memory + episodic memory covers 80% of use cases
- Semantic memory (extracted facts) is high-value but expensive to maintain accurately
- Procedural memory (ReMe framework) is the frontier — agents that improve their own strategies over time — but still experimental

**Letta/MemGPT hierarchy (most mature implementation):**
1. **Message Buffer** — Recent conversation messages
2. **Core Memory** — Editable blocks pinned to context window (~500 tokens for identity, ~2K for project knowledge)
3. **Recall Memory** — Full interaction history, searchable
4. **Archival Memory** — Explicitly stored knowledge in external DB

The agent manages its own memory via tools: `memory_replace`, `memory_insert`, `memory_rethink`. Sleep-time agents do async refinement during idle periods.

**Practical problem with self-managed memory:** Reliability is uneven. LLMs don't always remember to use memory tools, and when they do, they sometimes store low-value information or fail to generalize (e.g., listing every spam vendor individually instead of learning "ignore all cold outreach").

---

## 3. Importance Scoring & Memory Admission

### A-MAC: Adaptive Memory Admission Control (State of the Art)

Five-dimensional scoring, weighted combination:

| Dimension | Method | Cost |
|---|---|---|
| **Utility** | LLM judges if info is actionable | Expensive (~2.6s) |
| **Confidence** | ROUGE-L overlap with source conversation | Cheap (<65ms) |
| **Novelty** | Sentence-BERT distance from existing memories | Cheap |
| **Recency** | Exponential decay, half-life ~69 hours | Cheap |
| **Type Prior** | Rule-based: persistent info > transient states | Cheap |

**Formula:** S(m) = w1*U + w2*C + w3*N + w4*R + w5*T

**Key finding:** Type Prior was the dominant feature in ablation. Simply categorizing content type (preference, decision, fact, task vs. chitchat, acknowledgment) provides most of the signal.

**Conflict resolution:** When candidate similarity to existing memory >0.85, retain higher-scoring version and merge.

**Results:** F1 = 0.583 (+7.8% over SOTA), 31% latency reduction over LLM-native approaches.

### EverMem Importance Scoring (Simpler, Practical)

```
base_score = 0.35
length_bonus = min(0.45, log(len(content)) * factor)
role_bonus = 0.08 if user_message else 0.03
signal_bonus = 0.18 if content_type in (decision, preference, fact, task)
final_score = min(1.0, base_score + length_bonus + role_bonus + signal_bonus)
```

**Consolidation trigger:** 1,400 tokens or every 8 turns. Top 18 high-importance memories summarized into <520 characters using lightweight model (flan-t5-small).

### Practical Filtering Rules (Consensus Across Implementations)

**Always store:**
- Explicit user instructions or corrections (importance = 1.0)
- Task success/failure outcomes (importance = 0.9)
- User preferences and decisions

**Never store:**
- Chitchat, greetings, acknowledgments
- Duplicate information (hash-based dedup)
- Transient state that will be immediately superseded

**Use LLM judgment for:**
- Ambiguous information that might be useful later
- Context that could inform future behavior

---

## 4. Memory Decay, Pruning, and Consolidation

### What the Research Says Works

**Multi-stage pruning (from MaRS framework):**
1. **Temporal pass** — Remove clearly stale entries (e.g., >90 days with no access)
2. **Reflection/consolidation** — Cluster similar episodic memories, merge into summaries
3. **Importance-based eviction** — Remove lowest-density memories per unit token cost
4. **Privacy pass** — Accelerate decay for sensitive/PII content

**Ebbinghaus Forgetting Curve adaptation (MemoryBank):**
- Recency score decays hourly by configurable factor
- Combined with relevance and importance in linear scoring
- Memories that are accessed get their recency "refreshed"

**Engram's approach (pragmatic):**
- No automatic decay — relies on agent discipline
- Exact deduplication via hash of (project + scope + type + title)
- Topic upserts: same topic_key updates existing memory, increments revision_count
- Duplicate window prevents thrashing

**Letta's approach:**
- Recursive summarization of evicted messages
- Summaries compound: evicted messages summarized with existing summaries
- Sleep-time agents do proactive refinement during idle periods

### What Fails in Practice

- **Pure temporal eviction** (LRU/sliding window) — Discards old but still-relevant information
- **No consolidation** — Memory stores bloat with contradictions over time
- **Aggressive compression** — Lightweight summarization models lose technical nuance
- **Over-retrieval** — Loading too many memories into context pollutes the prompt (top-K too high)
- **LLM-managed consolidation** — Agents are bad at knowing when to generalize

---

## 5. Token Costs of Retrieval

### Embedding Generation
- text-embedding-3-small: $0.02/1M tokens (cheapest viable option)
- text-embedding-3-large: $0.13/1M tokens
- Local models (BGE-M3, all-MiniLM-L6-v2): $0 after hardware cost

### Retrieval Overhead Per Query
- Retrieved context typically adds 2,000-10,000 tokens per query
- Well-tuned systems (chunk size 300-400 tokens, top-3 results): ~1,000-1,200 tokens
- Tool descriptions add 2,000-5,000 tokens for function definitions
- 5-turn conversation history: 8,000-12,000 tokens accumulated

### Cost Reduction Strategies That Work
- **Chunk size 300-400 tokens + top-3 retrieval** — 91% reduction vs. top-10 with larger chunks
- **Observational memory compression** — 10x cost reduction via stable cacheable context
- **Hierarchical retrieval** — Start with compact results (~100 tokens each), expand only when needed (Engram's 3-layer pattern)
- **Admission-time filtering** (A-MAC) — Don't store low-value memories in the first place

### Local-First Token Cost
- FTS5 retrieval: $0 (no API calls, no embeddings needed for keyword search)
- sqlite-vec with local embeddings (BGE-M3, Nomic): $0 per query after initial embedding
- Hybrid FTS5 + sqlite-vec: Total retrieval cost = 0 tokens, 0 API calls, <3ms latency

---

## 6. Practical Implementation Recommendations

### For a Local-First Single-User Tool (Like Claudex)

**Architecture:** SQLite FTS5 + sqlite-vec hybrid search with RRF

**Schema:**
```sql
-- Core memories table
CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    memory_type TEXT CHECK(memory_type IN ('episodic','semantic','procedural')),
    importance REAL DEFAULT 0.5,
    created_at TEXT DEFAULT (datetime('now')),
    last_accessed TEXT DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0,
    source_session TEXT,
    topic_key TEXT,
    content_hash TEXT UNIQUE,
    metadata JSON
);

-- FTS5 index
CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, content='memories', content_rowid='id', tokenize='porter'
);

-- Vector index (384-dim for all-MiniLM-L6-v2, 768 for BGE)
CREATE VIRTUAL TABLE memories_vec USING vec0(
    memory_id INTEGER PRIMARY KEY,
    embedding float[384]
);
```

**Retrieval:** RRF with weights 0.6 vector / 0.4 FTS. k=60. Oversample 4x then trim.

**Admission:** Type-based filtering (always store corrections/preferences/outcomes, never store chitchat). Content-hash dedup. Topic upserts for evolving knowledge.

**Consolidation:** Periodic (every N sessions): cluster similar episodic memories, merge into semantic summaries. Temporal decay with access-refresh. Keep raw archive for JIT recompilation if needed.

**Progressive retrieval (Engram pattern):**
1. `search` — Compact results with IDs (~100 tokens each)
2. `timeline` — Surrounding context for a specific memory
3. `get_full` — Complete untruncated content only when needed

### For Multi-Tenant Production Systems

Use Mem0 (simplest) or Hindsight (highest accuracy). Both provide SDKs, handle scaling, and have proven benchmarks.

### What to Avoid

- Don't use ChromaDB for concurrent workloads (database locking)
- Don't rely solely on LLM self-managed memory (unreliable tool usage)
- Don't skip admission filtering (memory bloat degrades everything)
- Don't over-retrieve (top-3 beats top-10 in practice when chunks are well-sized)
- Don't compress too aggressively with small models (flan-t5 loses nuance)
- Don't treat all memory types the same (separate facts from experiences from preferences)

---

## 7. Key Open-Source Projects Reference

| Project | Stack | Memory Type | Stars | Maturity |
|---|---|---|---|---|
| **Mem0** | Python, vector+graph DB | Semantic + Graph | 25K+ | Production |
| **Letta/MemGPT** | Python, PostgreSQL | Self-managed hierarchical | 15K+ | Production |
| **Hindsight** | Python, PostgreSQL | 4-network structured | ~2K | Research-grade |
| **Engram** | Go, SQLite+FTS5 | MCP-based explicit memory | ~500 | Early but solid design |
| **sqlite-memory** | Node, SQLite+FTS5+vec | Hybrid search | ~300 | Early |
| **Memento** | Node, SQLite+FTS5+vec | Knowledge graph | ~50 | Early |
| **Cognee** | Python, vector+graph DB | Knowledge graph extraction | ~2K | Active |
| **GAM** | Python | Dual-agent JIT memory | ~500 | Research |
| **sqlite-rag** | SQLite extensions | Hybrid RRF search | ~200 | Library |
| **OpenClaw Memory** | Node, SQLite | Local-first RAG | ~100 | Active |

---

## Sources

### SQLite Hybrid Search & FTS5
- [Hybrid full-text search and vector search with SQLite — Alex Garcia](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [sqlite-memory: Markdown-based AI agent memory](https://github.com/sqliteai/sqlite-memory)
- [sqlite-rag: Hybrid search engine](https://github.com/sqliteai/sqlite-rag)
- [Engram: Persistent memory system with SQLite + FTS5](https://github.com/Gentleman-Programming/engram)
- [Memento: MCP memory server using SQLite + FTS5 + sqlite-vec](https://github.com/iachilles/memento)
- [ZeroClaw Hybrid Memory: SQLite Vector + FTS5](https://zeroclaws.io/blog/zeroclaw-hybrid-memory-sqlite-vector-fts5/)
- [Local-First RAG: Using SQLite for AI Agent Memory](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/)
- [Building a RAG on SQLite](https://blog.sqlite.ai/building-a-rag-on-sqlite)
- [sqlite-vec Hybrid Search — liamca](https://github.com/liamca/sqlite-hybrid-search)

### Agent Memory Architectures
- [Hindsight: Agent Memory That Learns](https://github.com/vectorize-io/hindsight)
- [Hindsight: 91% accuracy on LongMemEval](https://vectorize.io/blog/introducing-hindsight-agent-memory-that-works-like-human-memory)
- [Mem0: Universal memory layer for AI Agents](https://github.com/mem0ai/mem0)
- [Mem0: Building Production-Ready AI Agents](https://arxiv.org/abs/2504.19413)
- [GAM: General Agentic Memory via Deep Research](https://github.com/VectorSpaceLab/general-agentic-memory)
- [Google Always-On Memory Agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent)
- [Letta (MemGPT): Stateful agents with memory](https://github.com/letta-ai/letta)
- [Letta blog: Agent Memory](https://www.letta.com/blog/agent-memory)
- [Observational Memory — Mastra / VentureBeat](https://venturebeat.com/data/observational-memory-cuts-ai-agent-costs-10x-and-outscores-rag-on-long)

### Memory Scoring, Consolidation, and Admission
- [A-MAC: Adaptive Memory Admission Control for LLM Agents](https://arxiv.org/html/2603.04549)
- [Persistent AI Agent OS with Hierarchical Memory and FAISS](https://earezki.com/ai-news/2026-03-04-how-to-build-an-evermem-style-persistent-ai-agent-os-with-hierarchical-memory-faiss-vector-retrieval-sqlite-storage-and-automated-memory-consolidation/)
- [Forgetful but Faithful: Cognitive Memory Architecture](https://arxiv.org/html/2512.12856v1)
- [Enhancing memory retrieval in generative agents](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1591618/full)
- [Redis: Build AI Agents with Memory Management](https://redis.io/blog/build-smarter-ai-agents-manage-short-term-and-long-term-memory-with-redis/)

### Memory Types and Practical Lessons
- [LangMem Conceptual Guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [LangChain: How we built Agent Builder's memory system](https://blog.langchain.com/how-we-built-agent-builders-memory-system/)
- [ReMe: Dynamic Procedural Memory Framework](https://github.com/agentscope-ai/ReMe)
- [Agent Memory Paper List Survey](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- [How AI agent memory actually works — Rushi](https://www.rushis.com/how-ai-agent-memory-actually-works/)
- [Cognee: AI Memory Tools Evaluation](https://www.cognee.ai/blog/deep-dives/ai-memory-tools-evaluation)
- [Cognee vs Mem0 Comparison](https://dasroot.net/posts/2025/12/cognee-vs-mem0-memory-layer-comparison-llm-agents/)

### Token Costs and Optimization
- [OpenAI Embeddings Pricing](https://costgoat.com/pricing/openai-embeddings)
- [LLM Token Optimization — Redis](https://redis.io/blog/llm-token-optimization-speed-up-apps/)
- [AI Agent Token Cost Optimization Guide](https://fast.io/resources/ai-agent-token-cost-optimization/)
- [Optimizing RAG with Hybrid Search & Reranking](https://superlinked.com/vectorhub/articles/optimizing-rag-with-hybrid-search-reranking)
- [Advanced RAG — RRF in Hybrid Search](https://glaforge.dev/posts/2026/02/10/advanced-rag-understanding-reciprocal-rank-fusion-in-hybrid-search/)
