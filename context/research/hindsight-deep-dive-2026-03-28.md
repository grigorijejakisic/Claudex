# Hindsight Deep-Dive Research Report (W1)

Date: 2026-03-28

## Sources
- Paper: arxiv.org/abs/2512.12818 (Dec 2025)
- Repo: github.com/vectorize-io/hindsight (Python + Rust CLI + TS clients, open-source)
- Docs: hindsight.vectorize.io (config, API, benchmarks)
- Blog: conflict resolution, MCP integration, Mem0 comparison

---

## 1. ARCHITECTURE OVERVIEW

Three core ops: Retain (ingest), Recall (retrieve), Reflect (reason). Single PostgreSQL + pgvector backend. Memory organized into isolated "banks."

### Four Memory Networks

Each memory unit: f = (u, b, t, v, ts, te, tm, l, c, x) -- id, bank, text, embedding, occurrence interval start/end, mention time, type, confidence, metadata.

| Network | Symbol | Contents |
|---------|--------|----------|
| World | W | Objective external facts |
| Experience | B | Agent's own actions (first person) |
| Opinion | O | Subjective beliefs as (text, confidence in [0,1], timestamp) |
| Observation | S | Preference-neutral entity summaries synthesized from W and B |

Design principle: Evidence (W, B) structurally separated from inference (O). "Epistemic clarity."

### Storage
- PostgreSQL single DB (no separate graph DB or vector DB)
- pgvector HNSW for vectors (also supports pgvectorscale DiskANN, vchord)
- GIN index for BM25 full-text search (also supports vchord, pg_textsearch)
- Graph = entity_links table within PostgreSQL
- Tables: banks, memory_units, documents, entities, entity_links
- Schema via Alembic migrations

---

## 2. RETAIN PIPELINE (TEMPR -- Temporal Entity Memory Priming Retrieval)

### Fact Extraction
LLM-based, 2-5 narrative facts per conversation exchange:
1. Coreference resolution
2. Temporal normalization (relative to absolute timestamps)
3. Participant attribution
4. Fact type classification into 4 networks
5. Entity extraction (PERSON, ORG, LOCATION, PRODUCT, CONCEPT, OTHER)
6. Causal link extraction (causes, caused_by, enables, prevents)

Config: extraction_mode = concise (default) | verbose | verbatim | chunks | custom. chunk_size = 3000 chars default.

**Retain is async** -- API returns immediately, extraction happens in background workers with configurable slots.

LLM requirement: must support 65K+ output tokens for reliable extraction. Default model: gpt-4o-mini for retain.

### Entity Resolution
rho(m) = argmax_{e in E} [alpha * sim_str(m,e) + beta * sim_co(m,e) + gamma * sim_temp(m,e)]

- sim_str = Levenshtein string similarity
- sim_co = co-occurrence pattern similarity
- sim_temp = temporal proximity

"Alice", "alice@company.com", "the account owner" all resolve to same canonical entity node.

### Graph Construction -- Four Edge Types

| Edge Type | Weight Formula | Notes |
|-----------|---------------|-------|
| Temporal | w = exp(-delta_t / sigma_t) | sigma_t is configurable decay parameter (exact value not published) |
| Semantic | cosine(vi, vj) if >= theta_s, else 0 | Threshold-gated |
| Entity | 1.0 (fixed) | Bidirectional between all facts mentioning same entity |
| Causal | 1.0 (fixed) | LLM-extracted: causes, caused_by, enables, prevents |

### Observation Generation (Entity Summaries)
Formula: o_e = Summarize_LLM(F_e) where F_e = all facts mentioning entity e.

**Trigger**: When new facts mentioning entity e are retained, a background consolidation job fires.

Consolidation config:
- consolidation_batch_size = 50 facts per batch (default)
- consolidation_llm_batch_size = 8 facts per LLM call (default)
- consolidation_source_facts_max_tokens_per_observation = 256 tokens (default)
- Uses _find_related_observations() with semantic similarity to find existing observations to update

**Conflict resolution during consolidation:**
- Redundant facts: merge into single cleaner observation
- Direct contradictions: preserve both states with temporal markers ("used to X, now Y")
- State updates: explicit temporal language ("changed from X to Y")
- Three temporal fields tracked: occurred_start, occurred_end, mentioned_at

**Mental Models (product evolution beyond paper):**
- Living documents that auto-update as memories grow
- Higher priority than raw observations in reflect: Mental Models -> Observations -> Raw Facts
- User-curated or auto-generated

---

## 3. RECALL PIPELINE

### 4 Parallel Retrieval Channels

All four fire simultaneously on every query:

**Channel 1 -- Semantic**: pgvector HNSW cosine similarity, top-k.
- Default embedding: BAAI/bge-small-en-v1.5 (384 dims, ~130MB)
- Also supports: OpenAI text-embedding-3-small (1536d), Cohere embed-english-v3.0 (1024d)

**Channel 2 -- BM25 Keyword**: PostgreSQL GIN index, BM25 scoring.

**Channel 3 -- Graph** (3 available modes):
- link_expansion (DEFAULT): Fast, simple graph expansion from semantic seeds via entity co-occurrence and causal links. Target latency under 100ms. Recommended for most use cases.
- mpfp: Multi-Path Fact Propagation -- iterative graph traversal with spreading activation. MPFP_TOP_K_NEIGHBORS = 20 fan-out limit. Slower but more thorough.
- bfs: Basic breadth-first search.

Spreading activation formula: A(fj, t+1) = max_{edges} [A(fi, t) * w * delta * mu(l)]
- delta in (0,1): per-hop decay factor (exact value not published)
- mu(l): link-type multiplier -- causal/entity edges get mu > 1, semantic/temporal get mu <= 1
- No published hop limit or activation threshold

**MPFP NOTE**: NOT described in the arxiv paper. It is a post-paper implementation feature in the open-source codebase. It is NOT the default mode -- link_expansion is default. Appears to be a Personalized PageRank variant (alpha=0.15 teleport probability mentioned in one source, unconfirmed).

**Channel 4 -- Temporal**: Hybrid parser using rule-based date extraction (two off-the-shelf libraries) with fallback to google/flan-t5-small for difficult temporal expressions.
- Interval matching: R_temp = {f in V: [ts_f, te_f] intersection [t_start, t_end] is nonempty}
- Scoring: s_temp(Q, f) = 1 - |tau_mid_f - tau_mid_Q| / (delta_tau / 2)

### Reciprocal Rank Fusion
RRF(f) = sum_{i=1}^{4} 1/(k + r_i(f)), **k = 60**

Combines R_sem, R_bm25, R_graph, R_temp where r_i(f) = rank in list i (infinity if absent).

### Cross-Encoder Reranking
**Default model**: cross-encoder/ms-marco-MiniLM-L-6-v2 (~85MB, ~22M params)
- Alternative: cross-encoder/ms-marco-MiniLM-L-12-v2 (higher accuracy)
- Also supports: Cohere rerank-english-v3.0, ZeroEntropy zerank-2, FlashRank, Jina MLX
- RERANKER_MAX_CANDIDATES = 300 (max candidates entering reranker)
- Batch size: 32 default for local, 128 for TEI
- Max concurrent: 4 for local, 8 for TEI
- FP16 inference option available

**Latency**: Recall without reranking: 50-100ms. With reranking: 200-500ms.

### Token Budget Filtering
Greedy sequential packing: iterate candidates in reranked order, include each until cumulative tokens reach budget k.

R_output = {f1,...,fn: sum|fi| <= k and sum|fi+1| > k}

Interface: Recall(B, Q, k) -> {f1,...,fn} where combined tokens <= k.

Default token limit: 4096 tokens for MCP recall. Configurable via recallMaxTokens. Optional recallTopK hard cap on number of memories. Budget levels: recallBudget = low | mid | high.

---

## 4. REFLECT / CARA (Contextual Adaptive Reasoning Architecture)

### Behavioral Profile
Three disposition parameters + bias strength (all per-bank configurable):
- S in {1,...,5}: Skepticism (1=trusting, 5=skeptical) -- default 3
- L in {1,...,5}: Literalism (1=flexible, 5=literal) -- default 3
- E in {1,...,5}: Empathy (1=detached, 5=empathetic) -- default 3
- beta in [0,1]: Bias strength controlling preference influence

Bank profile: P = (n, Theta, h) where n=name, Theta=behavioral profile, h=first-person background description.

### Directives
Hard rules distinct from soft disposition traits. Injected into reflect prompts. Always enforced -- not probabilistic like disposition. Created/updated/deleted per bank via API.

### Opinion Formation and Reinforcement
New opinions formed as: o = (t, c, tau, b, E) where c=confidence, E=evidence entities.

Reinforcement candidates found by: O_cand = {o in O: |E_o intersection E_f| > 0 or sim(v_o, v_f) > theta}

Confidence updates:
- Reinforce: c' = min(c + alpha, 1.0)
- Weaken: c' = max(c - alpha, 0.0)
- Contradict: c' = max(c - 2*alpha, 0.0)
- Neutral: c' = c

Where alpha in (0,1) is step size parameter (value not published).

### Background Merging
h' = Merge_LLM(h, h_new) -- resolves conflicts favoring new information while maintaining coherence.

### Reflect Operation
Uses autonomous search loop -- reflect calls recall internally, iterates up to:
- reflect_max_iterations = 10
- reflect_max_context_tokens = 100,000
- reflect_wall_timeout = 300 seconds

Priority order: Mental Models -> Observations -> Raw Facts.

---

## 5. BENCHMARK RESULTS

### LongMemEval (S setting, 500 questions)

| System | Overall | Multi-session | Temporal | Knowledge Update |
|--------|---------|--------------|----------|-----------------|
| Full-context GPT-4o | 60.2% | 44.3% | 45.1% | 78.2% |
| Full-context OSS-20B | 39.0% | 21.1% | 31.6% | 60.3% |
| Mem0 (independent eval) | 49.0% | -- | -- | -- |
| Zep (GPT-4o) | 71.2% | 57.9% | 62.4% | 83.3% |
| Supermemory (GPT-4o) | 81.6% | 71.4% | 76.7% | 88.5% |
| Hindsight (OSS-20B) | 83.6% | 79.7% | 79.7% | 84.6% |
| Hindsight (OSS-120B) | 89.0% | 81.2% | 85.7% | 92.3% |
| Hindsight (Gemini-3) | 91.4% | 87.2% | 91.0% | 94.9% |

### LoCoMo
| System | Accuracy |
|--------|----------|
| Mem0-Graph (prior best) | 75.78% |
| Hindsight (OSS-120B) | 89.61% |

### Internal Model Leaderboards (benchmarks.hindsight.vectorize.io)
- Best retain model: openai/gpt-oss-20b
- Best reflect model: openai/gpt-oss-120b
- Best reranker: MiniLM-L6 (their default)
- Best embeddings: BGE Small EN v1.5 (their default)

### Latency
- Recall without reranking: 50-100ms
- Recall with reranking: 200-500ms
- Reflect: 1-10 seconds
- Scale: handles millions of memories
- System requirements: Python 3.11+, 4GB RAM minimum, 8GB recommended

---

## 6. UNADOPTED FEATURES (beyond the 5 already spec'd in HINDSIGHT_UPGRADES.md)

### Already spec'd (upgrades 1-5):
1. Cross-encoder reranking
2. MPFP meta-path traversal
3. Entity summary layer
4. Token budget-aware retrieval
5. Temporal link decay

### NOT yet identified or spec'd:

**A. Temporal as explicit 4th retrieval channel** -- Dedicated interval-matching logic + temporal expression parser (rule-based + flan-t5-small fallback). Handles "what happened last week" as first-class query type. We handle temporal implicitly through keyword/vector.

**B. CARA opinion/belief system** -- Confidence-scored opinions that reinforce/weaken/contradict over time. Disposition traits (skepticism, literalism, empathy) that shape reasoning. Directives as hard rules. An entire reasoning layer we lack entirely.

**C. Entity resolution with multi-signal scoring** -- Formula combining Levenshtein + co-occurrence + temporal proximity to canonicalize entities. We store entity names as raw unresolved strings.

**D. Conflict resolution in consolidation** -- Their observation merger explicitly handles redundancy (merge), contradiction (preserve both with temporal markers), and state transitions. Our observation system does not handle conflicts.

**E. Mental Models as living documents** -- Higher-priority than observations, auto-updating, user-curated. Checked first during reflect. We do not have this tier.

**F. Async retain with background workers** -- Their retain returns immediately; extraction happens in distributed workers with configurable slots. Our hooks are synchronous.

**G. Causal link extraction** -- They extract causes/caused_by/enables/prevents links between facts. Our artifact_links have types but we do not extract causal relationships from content.

**H. Configurable extraction modes** -- concise/verbose/verbatim/chunks/custom with different extraction aggressiveness per bank. We have one extraction approach.

**I. Per-bank configuration isolation** -- Each bank can have different LLM, extraction mode, disposition, directives. Our system is global config.

**J. Feedback loop prevention** -- They automatically strip injected memory tags before re-retention, preventing recursive extraction of injected memories.

---

## 7. COMPARISON TABLE

| Dimension | Claudex | Hindsight |
|-----------|---------|-----------|
| Storage | SQLite + Qdrant (5 collections) | PostgreSQL + pgvector (1 DB) |
| Retrieval channels | 3 (keyword, vector, graph) | 4 (+temporal) |
| Reranking | RRF only | RRF + cross-encoder |
| Entity handling | Raw strings | Canonical entities, multi-signal resolution |
| Observations | Angel pattern extraction | Background consolidation + conflict resolution |
| Belief tracking | None | Opinion network with confidence dynamics |
| Reasoning | Inject-only | CARA reflect with autonomous search loop |
| Graph traversal | 2-hop BFS | link_expansion (default) or MPFP |
| Token budgeting | Fixed top-k | Greedy pack to token limit |
| Temporal retrieval | Implicit | Explicit channel with interval matching |
| Extraction | Synchronous hooks | Async background workers |
| Configuration | Global | Per-bank hierarchical |
| Embedding model | nomic-embed-text 768->384 Matryoshka | bge-small-en-v1.5 384d native |

---

## 8. BOTTOM LINE

The 5 upgrades in HINDSIGHT_UPGRADES.md cover cross-encoder, MPFP, entity summaries, token budget, temporal decay -- good coverage of recall pipeline gaps. The biggest unaddressed gaps are:

1. **CARA belief/opinion system** -- entire reasoning layer (largest delta)
2. **Entity resolution** -- canonicalization with multi-signal scoring
3. **Temporal as explicit retrieval channel** -- dedicated interval matching
4. **Conflict resolution in consolidation** -- temporal markers for contradictions
5. **Async retain** -- background worker extraction

CARA is the single largest architectural difference between Claudex and Hindsight. It transforms memory from a retrieval system into a reasoning system with evolving beliefs.

MPFP note: Our meta-path spec (5 typed patterns) may actually be a better approach than their PPR-based MPFP for our graph structure (typed artifact_links). Their MPFP is not even their default -- link_expansion is.
