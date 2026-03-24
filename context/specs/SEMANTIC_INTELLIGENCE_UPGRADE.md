# Claudex v3 → Semantic Intelligence Upgrade — Full Scope

**Date:** 2026-03-22
**Sources:** 5 research agents (33 competitors, 25 MCP servers, 16 academic papers, 14 learning systems, 7 retrieval architectures), system audit (session 23), Gavrilo's 4-part proposal (session 23b), 22 sessions of production experience.

**Philosophy:** Every decision point that currently uses keyword matching gets a semantic path. FTS5 stays as the fast, precise, always-available floor. Vector search adds the semantic ceiling. Graceful degradation means you operate anywhere on that spectrum. No v2 deferrals — if the right approach is known, build it now.

---

## Part 0: Cleanup & Wire the Unwired

Before building new capabilities, fix the holes in what exists.

### 0.1 Delete Dead Code
- Delete `src/intelligence/artifact-claims.ts` (6.2 KB, zero production imports)
- Delete `src/intelligence/file-leases.ts` (6.8 KB, zero production imports)
- Delete `src/intelligence/worker-observations.ts` (8.7 KB, zero production imports)
- Remove dead exports: `getObservationsByProject`, `searchObservations`, `getLastSessionEvents`, `loadPatternsByIds`, `pruneDeadPatterns`, `isSqliteExpectedError`
- Remove dead re-exports in `checkpoint/writer.ts` (`writeCompressedFile`, `addVerifiedFact`)
- Remove pre-compact smoke test payload from `build.ts`

### 0.2 Wire applySessionSuccessBonus
**File:** `src/intelligence/retrieval-feedback.ts:139` → called from `src/adapters/shared/lifecycle.ts`
**What:** At session end (Stop hook, final invocation), if no corrections were detected during the session, apply +0.05 bonus to all recently-active artifacts. This closes the retrieval feedback loop for the positive signal.
**How:** In the Stop hook, after retrieval feedback processing, check `experience_flags.correction_flagged`. If false, gather all fresh+materialized artifact IDs and call `applySessionSuccessBonus()`.

### 0.3 Wire trigger_glob / trigger_command
**File:** `src/intelligence/experience-patterns.ts` → `createPattern()`
**What:** When creating a pattern, extract file globs and command patterns from the trigger_context. Store them in `trigger_glob` and `trigger_command` columns so the trigger engine's predictive matching actually fires.
**How:** Parse trigger_context for file paths (extract glob like `**/auth*.ts`), command patterns (extract from Bash tool references). Simple regex extraction, not LLM.

### 0.4 Wire detectIdleSession
**File:** `src/adapters/shared/lifecycle.ts:840` → called from Stop hook
**What:** When back-to-back compactions with <3 events between them are detected, inject an advisory suggesting the user run `/endsession`.
**How:** Call `detectIdleSession()` in the Stop hook using the preloaded events. If true, return `additionalContext` with idle session advisory.

### 0.5 Update /endsession for Recall Aliases
**File:** `~/.claude/skills/endsession/SKILL.md`
**What:** After session log creation (Step 1), call `updateRecallText` with LLM-generated recall aliases — the ceiling path that currently only fires at heuristic tier.
**How:** Add a step between Step 1 and Step 2: generate recall aliases from the session log content using the LLM (Claude itself during /endsession execution). Format: "user's voice" aliases that describe how the user would search for this session later. Write via `node dist/cli/update-recall.cjs <session_id> <recall_text>` (new CLI entry point).

### 0.6 Skip Empty Trigger Engine Queries
**File:** `src/intelligence/trigger-engine.ts`
**What:** `matchTriggers` runs 2 SQL queries per PostToolUse call that always return empty. Add a fast-path: if `context_triggers` count is 0 AND no patterns have non-null `trigger_glob`/`trigger_command`, skip entirely.
**How:** Cache the count at module init (single query), invalidate on insert. Zero overhead on the hot path.

### 0.7 Split migrations.ts
**Current:** 71KB monolith with V1-V8 migrations + fresh schema.
**Target structure:**
```
src/core/
  schema.ts              — SCHEMA_V3 DDL (fresh install)
  migrations/
    index.ts             — runMigrations() dispatcher
    v1-tables.ts         — V1 base table additions
    v2-columns.ts        — V2 column additions
    v3-schema.ts         — V3 table rebuilds
    v4-fts.ts            — V4 FTS5 additions
    v5-artifacts.ts      — V5 artifact table
    v6-patterns.ts       — V6 experience patterns
    v7-journal.ts        — V7 session journal
    v8-recall.ts         — V8 recall metadata
    v9-vectors.ts        — V9 vector columns + activation scores (NEW)
```

---

## Part 1: Vector Infrastructure (Foundation)

Everything else depends on this. Shared embedding infra for retrieval, classification, and linking.

### 1.1 Qdrant Vector Database
**What:** Run Qdrant as a local service for all vector storage and semantic search. SQLite remains the relational/FTS5 layer. Qdrant handles embeddings, KNN, and metadata-filtered vector queries.

**Why Qdrant over sqlite-vec:**
- **Metadata filtering inside the vector query** — `WHERE category = 'decision' AND importance >= 3 AND project = 'claudex-v3'` as part of the vector search, not post-hoc. This is Gavrilo's key insight: the structured filtering within the vector space is the real value.
- **HNSW indexing** — sub-millisecond search at any scale, vs sqlite-vec's linear scan
- **Payload storage** — artifact metadata co-located with vectors, single query returns everything
- **Proven at scale** — production-grade, battle-tested. sqlite-vec is pre-v1 with breaking changes.

**Setup:** Docker container or standalone binary. On Grigorije's hardware (128GB RAM), Qdrant runs trivially.
```bash
docker run -p 6333:6333 -v ~/.claudex/qdrant:/qdrant/storage qdrant/qdrant
```
Or native binary: `qdrant --storage-path ~/.claudex/qdrant`

**Collection schema:**
```json
{
  "collection_name": "claudex_artifacts",
  "vectors": { "size": 384, "distance": "Cosine" },
  "payload_schema": {
    "artifact_id": "integer",
    "project": "keyword",
    "artifact_type": "keyword",
    "importance": "integer",
    "confidence": "float",
    "activation_score": "float",
    "session_id": "keyword",
    "timestamp_epoch": "integer",
    "superseded": "bool"
  }
}
```
Additional collections: `claudex_patterns` (experience patterns), `claudex_threads` (thread summaries), `claudex_journal` (recall entries).

**Why 384 dims:** nomic-embed-text v1.5 supports Matryoshka (768→384→256). 384 is the sweet spot — high quality, half the storage. ~580 KB total for current 1978 artifacts.

**Dual-write pattern:** SQLite is always written first (source of truth). Qdrant upsert follows async. If Qdrant is down, SQLite + FTS5 still works. Qdrant is acceleration, not dependency.

**Client:** `@qdrant/js-client-rest` (official TypeScript SDK, mature).

### 1.2 Embedding Generation
**Primary:** Ollama nomic-embed-text (already in codebase, `src/embeddings/embedding-provider.ts`)
**Fallback:** No embeddings → FTS5-only retrieval (current behavior, always works)

**When to embed:**
- At artifact creation (`lifecycle.ts:processToolAndPressure` → after `createArtifact`)
- At pattern creation (`experience-patterns.ts:createPattern`)
- At journal entry creation (when recall_text is set)
- At session-end thread summary

**Latency budget:** ~10ms per embedding (nomic-embed-text is fast). Well within 100ms hook budget.

### 1.3 Graceful Degradation Chain
```
Ollama available + Qdrant running? → Full semantic search (Qdrant KNN + metadata filters)
  ↓ Qdrant down
Ollama available, Qdrant down? → Embed + cosine in app code against SQLite BLOB column (slower fallback)
  ↓ Ollama down
No embeddings available? → FTS5-only retrieval (current behavior, always works)
```
Every code path that calls embedding must handle null. Pattern: `const embedding = await tryEmbed(text); if (!embedding) return fts5OnlyPath();`

**Key principle:** SQLite + FTS5 is the always-available floor. Qdrant is acceleration. The system must never fail because Qdrant is down.

### 1.4 Migration V9
```sql
-- Add embedding column to artifacts (BLOB, nullable)
ALTER TABLE artifacts ADD COLUMN embedding BLOB;

-- Add activation_score column (replaces flat TTL)
ALTER TABLE artifacts ADD COLUMN activation_score REAL NOT NULL DEFAULT 1.0;

-- Add superseded_by column (for stale artifact flagging)
ALTER TABLE artifacts ADD COLUMN superseded_by INTEGER REFERENCES artifacts(id);

-- Add valid_until column (bi-temporal)
ALTER TABLE artifacts ADD COLUMN valid_until INTEGER;

-- Add confidence column (factual confidence at write time)
ALTER TABLE artifacts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;

-- Add novelty_score column (prediction error / semantic novelty)
ALTER TABLE artifacts ADD COLUMN novelty_score REAL NOT NULL DEFAULT 0.5;

-- NOTE: Vector storage is in Qdrant, not SQLite.
-- SQLite embedding BLOBs are retained as fallback when Qdrant is unavailable.
-- Qdrant collections: claudex_artifacts, claudex_patterns, claudex_threads, claudex_journal

-- Experience patterns: add embedding column
ALTER TABLE experience_patterns ADD COLUMN embedding BLOB;

-- Thread state: add embedding column for cross-session linking
ALTER TABLE thread_state ADD COLUMN summary_embedding BLOB;

-- Journal: add embedding column for recall search
ALTER TABLE session_journal ADD COLUMN embedding BLOB;
```

---

## Part 2: Retrieval Overhaul

Replace FTS5-only retrieval with a multi-signal hybrid system.

### 2.1 RRF Hybrid Scoring
**What:** Reciprocal Rank Fusion across three retrieval channels.
**Formula:** `RRF_score(d) = Σ_i 1 / (60 + rank_i(d))`
**Channels:**
1. FTS5 keyword match (SQLite) → ranked list A
2. Qdrant KNN with metadata filters (cosine similarity + structured filtering) → ranked list B
3. Recency-sorted (newest first) → ranked list C
4. RRF merge → final ranking
5. Top-K injected into context

**File:** New `src/core/hybrid-retrieval.ts`
**Integration:** Replace `searchArtifactsGlobal()` calls in `assembler.ts` and `recall-server.ts` with `hybridSearch()`.

### 2.2 Three-Factor Retrieval Scoring (Generative Agents)
**Formula:**
```
score(artifact, query) = α·recency + β·importance + γ·relevance
  recency    = exp(-0.995 * hours_since_last_access)
  importance = artifact.importance / 5  (normalized 0-1)
  relevance  = cosine(embed(artifact), embed(query))  OR  fts5_rank (fallback)
```
**Weights:** α=1.0, β=1.0, γ=1.0 (equal weight, tunable per-project via config)
**Integration:** This becomes the ranking function inside `hybridSearch()`. RRF handles the channel fusion; three-factor handles the per-artifact scoring within each channel.

### 2.3 Superseded-Artifact Flagging (SleepGate)
**What:** When a new artifact is created about the same entity, check for existing artifacts on that entity. If found and the new one supersedes it, mark the old one.
**Schema:** `superseded_by INTEGER REFERENCES artifacts(id)` + `valid_until INTEGER`
**Logic (in artifact creation):**
1. After creating artifact A about entity X (file path, concept)
2. FTS5 search for existing artifacts about X (same project, same entity)
3. If found older artifact B where cosine(A.embedding, B.embedding) > 0.85:
   - Set B.superseded_by = A.id
   - Set B.valid_until = now()
4. Assembly filters: `WHERE superseded_by IS NULL` by default
**File:** `src/core/artifacts.ts` → extend `createArtifact()`

### 2.4 ACT-R Activation Scores (Replace Flat TTL)
**What:** Replace integer TTL ticking with cognitive activation scores.
**Formula:**
```
activation(m) = base_level + spreading_activation
base_level = ln(Σ_j t_j^(-0.5))    -- sum over all access times
spreading_activation = Σ_k W_k · S_ki  -- from currently-active concepts
```
**Simplified version for Claudex:**
```
activation = ln(access_count + 1) - 0.5 * ln(hours_since_last_access + 1) + importance_boost
```
Where `importance_boost = (importance - 3) * 0.3` (centered at importance=3).

**Retrieval threshold:** Artifacts with `activation_score < 0.1` are eligible for pruning.
**Access tracking:** Every retrieval (materialization, assembly inclusion, MCP recall) increments `access_count` and updates `last_accessed_at_epoch`.

**Migration:** Backfill existing artifacts: `activation_score = ln(access_count + 1) + (importance - 3) * 0.3`

**Files:** Replace `tickArtifactTTL()` in `src/core/artifacts.ts` with `decayActivationScores()`. Replace TTL checks in assembly with activation threshold checks.

### 2.5 Prediction Error Gating (Novelty at Admission)
**What:** Before storing an observation as an artifact, check if it's novel (adds new information) vs redundant (duplicates what's stored).
**How:**
1. Embed the candidate content
2. KNN search against existing artifact embeddings (top-3)
3. If max cosine similarity > 0.92 → skip (redundant)
4. If max cosine < 0.92 → novel, compute novelty_score = 1.0 - max_cosine
5. Store novelty_score on the artifact

**Effect:** High-novelty artifacts get activation boosts. Low-novelty artifacts compete on recency and importance alone.
**File:** `src/extraction/extractor.ts` → extend `processToolObservation()`

### 2.6 Confidence Scoring
**What:** Track factual confidence at write time. Deterministic tool outputs (file read, grep result) get confidence=1.0. LLM-inferred content (decisions, learnings) gets confidence=0.7. User-stated facts get confidence=0.9.
**How:** Set confidence based on artifact source:
- `observation` from Read/Grep/Glob/Edit/Write: 1.0
- `observation` from Bash: 0.9
- `decision` from user text: 0.9
- `decision` from assistant inference: 0.7
- `learning`: 0.7 (promoted from inference)
- `flow`: 0.8

**Assembly use:** Multiply activation by confidence for final ranking. Low-confidence artifacts need higher base activation to surface.

---

## Part 3: Experience Intelligence

Upgrade the experience pattern system from regex to semantic.

### 3.1 Structured Failure Analysis (Reflexion)
**What:** When a correction is detected, generate a structured analysis — not just raw pattern text.
**Schema change on experience_patterns:**
```sql
ALTER TABLE experience_patterns ADD COLUMN assumption TEXT;
ALTER TABLE experience_patterns ADD COLUMN reality TEXT;
ALTER TABLE experience_patterns ADD COLUMN root_cause TEXT;
ALTER TABLE experience_patterns ADD COLUMN generalized_rule TEXT;
```
**How:** In `applyExperienceFeedback()`, after detecting a correction:
1. Extract the user's correction text
2. Extract what the assistant assumed (from the previous response)
3. Structure: `{assumption, reality, root_cause, generalized_rule}`
4. If Ollama available: use LLM to structure the analysis
5. If not: heuristic extraction from correction text (existing path, improved)

**Assembly rendering:** Show structured fields instead of flat text:
```
### Past Experience: [trigger_context]
**Assumption:** [what went wrong]
**Correct approach:** [generalized_rule]
*Helped N/M times*
```

### 3.2 Tips/Strategies Dual-Level Storage (ExperienceWeaver)
**What:** Each correction produces TWO artifacts:
- **Tip** — specific: "In lifecycle.ts, the session_events query returns stale data if called after checkpoint"
- **Strategy** — abstract: "Always reload session events from DB after any write operation, don't cache across hook boundaries"

**Schema:** Add `abstraction_level TEXT CHECK (abstraction_level IN ('tip', 'strategy'))` to experience_patterns.
**Retrieval:** When query matches a tip, prefer it. When query is more general, prefer strategies.
**How:** In pattern creation, generate both. Tip = the literal correction context. Strategy = generalized via LLM (or heuristic: strip file names, class names, replace with generic patterns).

### 3.3 Outcome Verification Gate (Voyager)
**What:** Patterns aren't confirmed until they've been retrieved and the interaction went well.
**Schema:** Add `verified BOOLEAN NOT NULL DEFAULT 0` and `verification_count INTEGER NOT NULL DEFAULT 0` to experience_patterns.
**Logic:**
1. Pattern created → `verified = 0`
2. Pattern retrieved → `times_triggered++` (existing)
3. At Stop hook, if pattern was injected AND no correction detected → `verification_count++`
4. When `verification_count >= 2` → `verified = 1`
5. Verified patterns get 1.5x retrieval weight boost
6. Unverified patterns that have been triggered 3+ times without verification → flag for review

### 3.4 Semantic Insight Extraction (Gavrilo Upgrade 2)
**What:** Replace regex-based insight detection with embedding similarity.
**Current:** `extractPatternFromAssistantText()` matches phrases like "the fix is", "correct approach is"
**New:**
1. Embed assistant text segments (paragraph-level chunking)
2. Compare against reference embeddings for "actionable insight" category
3. Threshold: cosine > 0.75 = likely insight
4. Fallback: existing regex (always runs, acts as floor)

**Reference embeddings (pre-computed, stored as constants):**
- "The root cause was..." (diagnosis)
- "The correct approach is..." (prescription)
- "This happened because..." (explanation)
- "Going forward, always..." (rule)
- "Never do X when Y because Z" (anti-pattern)

**File:** `src/intelligence/insight-extractor.ts` — extend or replace regex with semantic path.

### 3.5 Contrastive Pattern Extraction (ExpeL)
**What:** Periodically compare successful vs. failed sessions of the same type to extract WHY one worked.
**When:** At session-end, if 5+ sessions exist on the same project:
1. Find sessions with corrections (failed) and sessions without (successful)
2. Pair them by topic similarity (thread embedding cosine)
3. Diff the decisions/approaches between paired sessions
4. Extract contrastive rules: "In successful sessions, X was done differently from failed sessions"

**Frequency:** Every 10 sessions per project (not every session — expensive).
**File:** New `src/intelligence/contrastive-extraction.ts`

### 3.6 Capability Boundary Tracking (EvoCUA)
**What:** Track correction rate by topic/domain. Surface known-weak areas in assembly.
**Schema:**
```sql
CREATE TABLE IF NOT EXISTS capability_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,           -- e.g., "auth", "testing", "migrations"
  total_interactions INTEGER NOT NULL DEFAULT 0,
  corrections INTEGER NOT NULL DEFAULT 0,
  correction_rate REAL GENERATED ALWAYS AS (
    CASE WHEN total_interactions > 0 THEN CAST(corrections AS REAL) / total_interactions ELSE 0 END
  ) STORED,
  last_updated_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, domain)
);
```
**Logic:** At Stop hook, extract domain from thread topic. Increment `total_interactions`. If correction detected, increment `corrections`.
**Assembly:** When correction_rate > 0.3 for the current domain, inject: "This topic area has a 35% correction rate — extra care advised."

### 3.7 Causal Attribution (LEAFE)
**What:** When a correction at turn N is detected, trace back to find which earlier decision/action caused it.
**How:**
1. At correction detection, scan session_events for the last 5 tool calls before the correction
2. Identify the tool call whose output the user is correcting (heuristic: file path match, content overlap)
3. Store the causal link: `correction_origin_event_id` on the experience pattern
4. Assembly rendering: "This pattern was triggered by [tool call] at [time], not just the correction itself"

**File:** Extend `src/intelligence/correction-detection.ts` with backward attribution.

---

## Part 4: Memory Architecture

Higher-order memory structures built on the vector infrastructure.

### 4.1 Artifact Linking (A-MEM / Zettelkasten)
**What:** When storing an artifact, compute semantic overlap with existing artifacts and write explicit links.
**Schema:**
```sql
CREATE TABLE IF NOT EXISTS artifact_links (
  source_id INTEGER NOT NULL REFERENCES artifacts(id),
  target_id INTEGER NOT NULL REFERENCES artifacts(id),
  link_type TEXT NOT NULL CHECK (link_type IN ('related', 'supports', 'contradicts', 'supersedes', 'caused_by')),
  strength REAL NOT NULL DEFAULT 0.5,
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (source_id, target_id)
);
```
**Logic (at artifact creation):**
1. Embed the new artifact
2. KNN search existing artifacts (top-5, same project)
3. For each with cosine > 0.6, create a `related` link
4. If cosine > 0.85 and same entity, create `supersedes` link (ties to Part 2.3)
5. During assembly, when materializing artifact A, also surface top-2 linked artifacts

**Link type detection:**
- `related`: cosine > 0.6
- `supports`: same conclusion, different evidence
- `contradicts`: conflicting content on same entity (keyword detection + cosine)
- `supersedes`: same entity, newer timestamp (Part 2.3)
- `caused_by`: explicit causal chain from correction attribution (Part 3.7)

### 4.2 Active Forgetting (Contradiction Detection)
**What:** When a newer artifact contradicts an older one, deprioritize the older one.
**How:** Part of the linking pass (4.1). When a `contradicts` link is created:
1. Compare timestamps — newer wins
2. Set older artifact's `activation_score *= 0.5`
3. Set older artifact's `valid_until = now()`
4. The older artifact remains queryable for historical reconstruction but doesn't surface in assembly

### 4.3 Cross-Session Thread Linking (Gavrilo Upgrade 4)
**What:** At session-end, embed the thread summary. At session-start, compare opening prompt against stored thread embeddings. Auto-resume if similar.
**Logic:**
1. Stop hook: embed `thread.summary` → store in `thread_state.summary_embedding`
2. Session-start (UserPromptSubmit, first prompt): embed user prompt
3. KNN search stored thread embeddings (top-3, same project)
4. If cosine > 0.8: inject thread context: "This looks like a continuation of [topic] from session [N]"
5. Include: relevant decisions, learnings, and hot files from that thread

**File:** Extend `src/intelligence/thread-tracker.ts` and `src/adapters/cc-hooks/user-prompt-submit.ts`.

### 4.4 Cross-Session Batch Reflection (Generative Agents)
**What:** Every N sessions, synthesize high-level insights from accumulated memories.
**When:** At session-start, if `sessions_since_last_reflection >= 10` for this project.
**How:**
1. Gather top-20 learnings + top-10 patterns + recent thread summaries
2. If Ollama available: ask "What are the 3 most important insights from these?"
3. If not: cluster learnings by keyword overlap, extract the largest clusters as themes
4. Store results as high-importance learning artifacts
5. Mark reflection timestamp

**File:** New `src/intelligence/batch-reflection.ts`, called from session-start.

### 4.5 Sleep-Time Pre-Assembly
**What:** At session-end, pre-compute likely-needed context blocks for the next session.
**Logic:**
1. At Stop hook (after summary), analyze: what topic is active? what files are hot? what patterns are relevant?
2. Pre-assemble a "predicted context" block and store as a `pre_assembled` artifact
3. At next session-start, check if opening prompt matches the prediction (cosine > 0.7)
4. If match: use pre-assembled block instead of running full assembly (saves latency)
5. If no match: discard pre-assembly, run normal assembly

**Effect:** Predictable workflows (same project, same topic) get faster session starts.
**File:** Extend `src/adapters/shared/lifecycle.ts` with pre-assembly generation at session-end.

---

## Part 5: Retrieval Feedback Loop (Gavrilo Upgrade 3 + MemRL)

Close the loop. Make the system learn from its own retrieval decisions.

### 5.1 Retrieval Event Tracking
**Schema:**
```sql
CREATE TABLE IF NOT EXISTS retrieval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  session_id TEXT NOT NULL,
  query_embedding BLOB,          -- what was searched for
  was_referenced BOOLEAN,        -- did the assistant use this content?
  correction_followed BOOLEAN,   -- did a correction happen after this retrieval?
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_retrieval_artifact ON retrieval_events(artifact_id);
```
**When:** At assembly time (when artifact is materialized), record the retrieval event. At Stop hook, update `was_referenced` and `correction_followed`.

### 5.2 Retrieval Score Feedback
**Current:** `retrieval-feedback.ts` updates `retrieval_score` but doesn't influence future retrieval.
**New:** `retrieval_score` becomes a multiplier in the three-factor formula:
```
final_score = base_score * retrieval_score
```
Where `retrieval_score` is the EMA of past retrieval outcomes:
- Referenced: +0.1
- Correction after retrieval: -0.2
- Session success (no corrections, artifact was injected): +0.05
- Never referenced after 3 retrievals: -0.05

**Effect:** Artifacts that consistently help get boosted. Artifacts that consistently don't help get demoted. The system learns which materializations are valuable.

### 5.3 Spreading Activation
**What:** When artifact A is retrieved, boost the activation scores of artifacts linked to A.
**Formula:** `linked_artifact.activation += 0.3 * link_strength * retrieving_artifact.activation`
**How:** After materializing artifact A, query `artifact_links WHERE source_id = A.id`. For each linked artifact, apply activation boost. This surfaces related context without explicit search.
**File:** Extend `src/core/hybrid-retrieval.ts`.

---

## Part 6: MCP Recall Server Upgrades

### 6.1 Hybrid Search in claudex_search
Replace FTS5-only search with the hybrid retrieval pipeline (Part 2.1).

### 6.2 Pagination
Add `offset` parameter to `claudex_search`. Return `{results, total, has_more}`.

### 6.3 Relevance Scoring in Results
Return `score` field on each result (the three-factor score). Currently returns unsorted.

### 6.4 Agent-ID Attribution
Add optional `agent_id` parameter to `claudex_store`. Track which agent/session wrote each memory.

---

## Dependency Graph

```
Part 0 (Cleanup)           → independent, do first
Part 1 (Vector Infra)      → foundation for everything below
Part 2 (Retrieval)         → depends on Part 1
Part 3 (Experience Intel)  → depends on Part 1 (embedding), independent of Part 2
Part 4 (Memory Arch)       → depends on Part 1 + Part 2 (linking needs vectors + hybrid search)
Part 5 (Feedback Loop)     → depends on Part 2 (needs retrieval events) + Part 4 (needs links)
Part 6 (MCP)               → depends on Part 2 (hybrid search)
```

**Execution order:**
1. Part 0 (cleanup) — parallel with Part 1
2. Part 1 (vector infra) — enables everything
3. Part 2 + Part 3 — parallel (both depend on Part 1 only)
4. Part 4 — after Part 2
5. Part 5 — after Part 2 + Part 4
6. Part 6 — after Part 2

---

## Schema V9 Summary

New tables:
- `artifact_embeddings` (vec0 virtual table)
- `artifact_links` (junction table for Zettelkasten linking)
- `retrieval_events` (feedback tracking)
- `capability_boundaries` (correction rate by domain)

New columns on `artifacts`:
- `embedding BLOB`
- `activation_score REAL DEFAULT 1.0`
- `superseded_by INTEGER`
- `valid_until INTEGER`
- `confidence REAL DEFAULT 1.0`
- `novelty_score REAL DEFAULT 0.5`

New columns on `experience_patterns`:
- `embedding BLOB`
- `assumption TEXT`
- `reality TEXT`
- `root_cause TEXT`
- `generalized_rule TEXT`
- `abstraction_level TEXT` ('tip' | 'strategy')
- `verified BOOLEAN DEFAULT 0`
- `verification_count INTEGER DEFAULT 0`

New columns on `thread_state`:
- `summary_embedding BLOB`

New columns on `session_journal`:
- `embedding BLOB`

---

## New Files

```
src/core/
  schema.ts                    — fresh install DDL (extracted from migrations.ts)
  migrations/
    index.ts                   — migration dispatcher
    v1-v8.ts                   — existing migrations (consolidated)
    v9-semantic.ts             — V9: vectors, activation, links, boundaries
  hybrid-retrieval.ts          — RRF + three-factor scoring + spreading activation

src/intelligence/
  structured-analysis.ts       — Reflexion-style failure analysis
  contrastive-extraction.ts    — ExpeL batch comparison
  capability-tracker.ts        — domain correction rate tracking
  batch-reflection.ts          — cross-session insight synthesis

src/embeddings/
  embed-pipeline.ts            — unified embed-at-write for all artifact types
  qdrant-client.ts             — Qdrant connection, upsert, search, health check
```

---

## Config Additions

```yaml
vectors:
  enabled: true
  model: "nomic-embed-text"
  dimensions: 384
  similarity_threshold: 0.6        # minimum for artifact linking
  supersede_threshold: 0.85        # minimum for superseded flagging
  novelty_threshold: 0.92          # maximum for novelty gating

retrieval:
  scoring_weights:
    recency: 1.0
    importance: 1.0
    relevance: 1.0
  rrf_k: 60                        # RRF constant
  channels: ["fts5", "vec0", "recency"]

reflection:
  sessions_between_reflections: 10
  max_insights_per_reflection: 3

experience:
  verification_threshold: 2         # retrievals before verified
  capability_warning_threshold: 0.3  # correction rate to trigger warning
```

---

## Success Criteria

1. `claudex health` passes with V9 schema, all new tables present
2. All existing 1623 tests pass (no regressions)
3. New test coverage: hybrid retrieval, artifact linking, activation decay, superseded flagging, structured analysis, capability tracking
4. Benchmark: "auth bug" query finds "OAuth token refresh" artifact (vocabulary mismatch solved)
5. Benchmark: stale architecture doc doesn't surface when newer version exists
6. Benchmark: pattern with 3+ verifications ranks higher than unverified pattern
7. Live test: run 3 sessions, verify retrieval events are tracked and scores evolve
8. Graceful degradation: all features work (at reduced quality) when Ollama is unavailable

---

## What This Changes About Claudex

**Before:** Keyword-intelligence with heuristic scoring. FTS5 for search, regex for extraction, TTL for decay, flat scoring for assembly. Single dependency (SQLite).

**After:** Semantic-intelligence with learned scoring. Qdrant vector search + FTS5 keyword hybrid via RRF, embedding-based extraction, ACT-R activation for decay, three-factor scoring with retrieval feedback for assembly. Every decision point has both a fast keyword floor (SQLite/FTS5) and a semantic ceiling (Qdrant). Two storage layers: SQLite (relational, FTS5, source of truth) + Qdrant (vector, metadata-filtered KNN, acceleration).

The architecture stays the same. The adapter model stays the same. SQLite stays the relational backbone. Qdrant adds the semantic layer. The philosophy stays the same (boundary-only injection, non-throwing, defensive). What changes is the intelligence layer — from keyword matching to semantic understanding, from static scoring to learned scoring, from flat decay to cognitive activation. SQLite + FTS5 is the always-available floor; Qdrant is the semantic ceiling.
