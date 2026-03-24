# Proactive Memory — Implementation Spec
**Version:** 1.0 | **Date:** 2026-03-24
**Research:** `context/research/proactive-memory-research-2026-03.md` (21 parallel research agents)
**Scope:** V11 schema evolution + 8 implementation parts across 11 core files

---

## Goal

Transform Claudex from a reactive memory system (responds to events) into a predictive memory system (anticipates needs). Built in dependency order so each part is independently testable but designed as a coherent system.

## Success Metrics

- Observation count reduced from 22K to <5K high-density records
- Proactive context matches actual session intent >70% of the time
- Surfaced artifacts reference rate improves from ~4% to >30%
- Session-start assembly stays under 15K tokens, all relevant
- Zero regression in build (92 files) or tests (1714 tests)

---

## Schema Changes (V11 Migration)

All schema changes in one migration step. New tables and columns:

```sql
-- 1. Artifact access log (enables proper ACT-R multi-access BLL)
CREATE TABLE IF NOT EXISTS artifact_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  access_type TEXT NOT NULL DEFAULT 'retrieval'
    CHECK (access_type IN ('retrieval', 'materialization', 'reference', 'spread')),
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_aal_artifact ON artifact_access_log(artifact_id, timestamp_epoch DESC);

-- 2. Knowledge gaps register (System 3 metacognition)
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  description TEXT NOT NULL,
  detected_by TEXT NOT NULL,
  detected_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  priority REAL NOT NULL DEFAULT 0.5,
  resolved_at_epoch INTEGER,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_kg_project ON knowledge_gaps(project, resolved_at_epoch);

-- 3. Temporal profile (user behavior patterns)
CREATE TABLE IF NOT EXISTS temporal_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL CHECK (hour_bucket BETWEEN 0 AND 5),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  session_count INTEGER NOT NULL DEFAULT 0,
  avg_duration_sec REAL,
  common_first_actions TEXT DEFAULT '[]',
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(project, hour_bucket, day_of_week)
);

-- 4. Action transitions (Markov chain for next-action prediction)
CREATE TABLE IF NOT EXISTS action_transitions (
  project TEXT NOT NULL,
  from_action TEXT NOT NULL,
  to_action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (project, from_action, to_action)
);

-- 5. Add columns to artifact_links
ALTER TABLE artifact_links ADD COLUMN valid_at_epoch INTEGER;
ALTER TABLE artifact_links ADD COLUMN invalid_at_epoch INTEGER;

-- 6. Add columns to observations
ALTER TABLE observations ADD COLUMN stability_class TEXT DEFAULT 'standard'
  CHECK (stability_class IN ('transient', 'standard', 'stable', 'permanent'));
ALTER TABLE observations ADD COLUMN novelty_score REAL DEFAULT 0.5;
ALTER TABLE observations ADD COLUMN consolidated_into INTEGER;

-- 7. Add maturity to experience_patterns
ALTER TABLE experience_patterns ADD COLUMN maturity TEXT DEFAULT 'candidate'
  CHECK (maturity IN ('candidate', 'established', 'proven'));
ALTER TABLE experience_patterns ADD COLUMN confidence REAL DEFAULT 0.5;
```

---

## Part 1: Write-Time Deduplication

**Goal:** Prevent observation bloat at the source. Check for semantic duplicates before inserting.

**Files:**
- `src/core/observations.ts` — modify `insertObservation()` (line 56)
- `src/embeddings/embed-pipeline.ts` — reuse `embedQuery()`
- `src/embeddings/qdrant-client.ts` — reuse `searchArtifacts()`

**Logic:**
1. Before inserting, embed the new observation's `title + content`
2. Query Qdrant `observations` collection for cosine similarity > 0.85, limit 3
3. If match found:
   - Same session → SKIP (return existing observation ID)
   - Different session, same content → UPDATE existing (increment access_count, merge content if richer)
   - Different session, contradicting → INSERT new, mark old with `superseded_by` relationship
4. If no match → INSERT normally
5. Fallback: if Qdrant unavailable, skip dedup (never block writes)

**Integration:**
- Every hook that calls `insertObservation()` gets dedup for free
- No hook code changes needed — dedup is in the core function

**Tests:**
- Duplicate observation within same session → skipped
- Duplicate observation across sessions → merged
- Novel observation → inserted normally
- Qdrant down → falls through to normal insert

---

## Part 2: Category-Aware Decay + Stability Classification

**Goal:** Different observation types decay at different rates. Error traces from 3 months ago are noise; architecture decisions from 6 months ago are gold.

**Files:**
- `src/decay/decay-engine.ts` — modify half-life computation
- `src/core/observations.ts` — classify stability on insert
- `src/core/migrations.ts` — backfill stability_class for existing observations

**Stability class mapping:**

| Category | Default Stability | Half-life (importance 1/3/5) |
|---|---|---|
| error, test | transient | 3d / 14d / 90d |
| config, dependency, performance | standard | 7d / 30d / 180d |
| code, documentation, security | standard | 7d / 60d / 365d |
| architecture, decision | stable | 14d / 90d / never |

**Integration:**
- `insertObservation()` auto-classifies stability from category
- Decay engine reads `stability_class` instead of flat half-lives
- Angel heartbeat runs continuous decay (every tick, not threshold-triggered)

**Tests:**
- Error observation decays faster than architecture observation at same importance
- Importance-5 architecture observations never auto-decay
- Backfill migration correctly classifies existing 22K observations

---

## Part 3: Observation Consolidation (Angel Heartbeat)

**Goal:** Reduce 22K observations to ~5K high-density records using Mem0's ADD/UPDATE/DELETE/NOOP model.

**Files:**
- `src/angel/heartbeat.ts` — add consolidation phase
- NEW: `src/angel/consolidator.ts` — consolidation logic
- `src/embeddings/qdrant-client.ts` — cluster discovery via vector search

**Algorithm (runs in Angel heartbeat, low priority phase):**
1. **Pre-filter:** Compute novelty score for unconsolidated observations. `novelty = α × entity_novelty + (1-α) × (1 - max_cosine_to_recent)`. Score < 0.35 → mark as consolidation candidate.
2. **Cluster:** Group candidates by Qdrant cosine similarity > 0.8. Form clusters of 3+ observations.
3. **Consolidate:** For each cluster, LLM (Ollama → Sonnet fallback) decides:
   - **MERGE:** Combine N observations into 1 summary. Create new observation with higher importance. Link originals via `consolidated_into`.
   - **SUPERSEDE:** Newer observation replaces older. Mark old as `consumed`.
   - **KEEP:** Observations are related but distinct. No action.
4. **Never delete originals.** Set `consumed = 1` and `consolidated_into = <summary_id>`. Originals remain for audit.
5. **Batch size:** Process max 50 observations per heartbeat tick. Full consolidation takes multiple ticks.
6. **Guard:** Skip if Angel is under load (pattern extraction running).

**Integration:**
- Consolidation runs AFTER pattern extraction in heartbeat priority
- New summary observations get embedded and indexed in Qdrant automatically (existing pipeline)
- `insertObservation()` dedup (Part 1) prevents new bloat while consolidation reduces existing bloat

**Tests:**
- 5 similar error observations → 1 consolidated summary
- Consolidated summary has higher importance than originals
- Originals marked consumed but not deleted
- Consolidation respects batch limits
- Angel heartbeat still completes within time budget

---

## Part 4: Negative Retrieval Learning

**Goal:** Track what's surfaced but never referenced. Demote consistently-ignored artifacts.

**Files:**
- `src/intelligence/retrieval-feedback.ts` — enhance scoring model
- `src/adapters/cc-hooks/stop.ts` — record reference signals at session end
- `src/core/hybrid-retrieval.ts` — apply negative learning weights

**Logic:**
1. **Track:** In `retrieval_events`, every artifact surfaced in assembly gets a row with `was_referenced = NULL`.
2. **Score at session end (stop hook):** For each surfaced artifact, check if it was referenced in `conversation_turns`. Update `was_referenced = 1` or `was_referenced = 0`.
3. **Compute feedback score:** After 3+ retrievals with `was_referenced = 0`, apply suppression:
   - `suppression = -0.1 × (unreferenced_count - 2)` (caps at -0.5)
   - This multiplies into `retrieval_score` on the artifact
4. **Retrieval-induced suppression:** When hybrid search returns ranked results, candidates below the selection cutoff get `activation_score -= 0.05`. Implements the psychological RIF mechanism.
5. **Floor:** Never suppress below `retrieval_score = 0.1` — allow recovery.

**Integration:**
- Stop hook already processes retrieval feedback; this extends the scoring model
- `computeThreeFactorScore()` in hybrid-retrieval.ts already uses `getRetrievalScoreMultiplier()` — this enhances what that function returns
- Maturity progression (Part 7) can promote suppressed items back if they start being referenced

**Tests:**
- Artifact surfaced 5 times, never referenced → retrieval_score drops
- Artifact surfaced 3 times, referenced once → no suppression
- Floor at 0.1 prevents complete disappearance
- RIF: non-selected candidates get activation decrement

---

## Part 5: Artifact Relationship Graph

**Goal:** Populate `artifact_links` via two-stage linking. Enable 2-hop graph walks in retrieval.

**Files:**
- `src/angel/heartbeat.ts` — add bulk linking phase
- NEW: `src/core/graph-walk.ts` — graph traversal functions
- `src/core/hybrid-retrieval.ts` — add graph walk as 4th RRF channel

**Stage 1 — Bulk linking (Angel heartbeat):**
1. Find all artifacts with embeddings but no outgoing links.
2. For each, query Qdrant for top-5 most similar artifacts (cosine > 0.6).
3. Create `artifact_links` with `link_type = 'related'`, `strength = cosine_similarity`.
4. Fan-effect normalization: when computing spreading activation, divide by `ln(fan + 1)`.

**Stage 2 — Graph walk retrieval:**
```sql
WITH RECURSIVE graph_walk(id, depth, score) AS (
  SELECT id, 0, rrf_score FROM seed_artifacts
  UNION ALL
  SELECT al.target_id, gw.depth + 1,
         gw.score * al.strength * 0.5 / ln(
           (SELECT COUNT(*) FROM artifact_links WHERE source_id = gw.id) + 1
         )
  FROM graph_walk gw
  JOIN artifact_links al ON al.source_id = gw.id
  WHERE gw.depth < 2
    AND gw.score * al.strength * 0.5 > 0.05
    AND al.invalid_at_epoch IS NULL
)
SELECT id, MAX(score) as walk_score FROM graph_walk GROUP BY id;
```

**Stage 3 — Integration into RRF:**
- After FTS5 + Qdrant + recency produce candidates (3 channels)
- Run 1-2 hop walk from each candidate
- Graph-walked artifacts enter as 4th channel in RRF fusion
- Link-type dampening: `caused_by` 2×, `supports` 1.5×, `contradicts` -0.5×

**Tests:**
- Bulk linking creates links for unlinked artifacts
- Graph walk returns 2-hop neighbors
- `contradicts` links suppress, not boost
- Walk respects `invalid_at_epoch` (temporal validity)
- Fan-effect normalization prevents hub dominance

---

## Part 6: Intent Classification at Prompt-Submit

**Goal:** Classify user prompt intent. Route to different retrieval strategies.

**Files:**
- `src/adapters/cc-hooks/user-prompt-submit.ts` — add classification step
- NEW: `src/intelligence/intent-classifier.ts` — classification logic
- `src/core/hybrid-retrieval.ts` — intent-aware search parameters

**Intent types and retrieval strategies:**

| Intent | Signals | Retrieval Strategy |
|---|---|---|
| continuation | Short prompt, references recent work, no question marks | Load thread artifacts, narrow scope |
| investigation | Questions, "why", "how", error messages | Deep search, include error/test artifacts |
| implementation | Imperative verbs, file paths, "add", "create", "fix" | File-focused, recent observations |
| planning | "should we", "approach", "design", architecture keywords | Decisions, patterns, architecture artifacts |
| recall | "last time", "remember", "we discussed", past-tense | Full history search, conversation_turns |

**Classification method:** Rule-based classifier (no ML needed):
1. Check for explicit recall keywords → `recall`
2. Check for question patterns → `investigation`
3. Check for imperative + file paths → `implementation`
4. Check for architecture/design keywords → `planning`
5. Default → `continuation`

**Integration:**
- Classification runs early in user-prompt-submit, before retrieval
- Intent type passed to `hybridSearchAsync()` as new option
- Search function adjusts: scope, artifact_type filter, recency weight, limit

**Tests:**
- "Why is the test failing?" → investigation
- "Add rate limiting to the API endpoint" → implementation
- "What did we decide about the schema?" → recall
- "Should we use Qdrant or sqlite-vec?" → planning
- "yes" → continuation

---

## Part 7: Experience Pattern Maturity + Harmful Multiplier

**Goal:** Patterns progress through maturity stages. Negative outcomes weighted 4× heavier.

**Files:**
- `src/intelligence/experience-patterns.ts` — maturity lifecycle
- `src/adapters/cc-hooks/stop.ts` — maturity promotion logic

**Maturity lifecycle:**
- **candidate** (default): New pattern from single session. Low retrieval priority. Needs corroboration.
- **established**: Corroborated across 2+ sessions. Normal retrieval priority.
- **proven**: 3+ sessions, `helpful_count ≥ 3`, `verification_count ≥ 2`. High retrieval priority.

**Promotion rules (in stop hook, during pattern verification):**
```
if (pattern.maturity === 'candidate' && sessions_seen >= 2) → 'established'
if (pattern.maturity === 'established' && helpful_count >= 3 && verification_count >= 2) → 'proven'
```

**Harmful multiplier:**
- When `harmful_count` increments, add 4× weight: `score -= 4 * harmful_increment`
- When `helpful_count` increments: `score += 1 * helpful_increment`
- Anti-pattern inversion: if `harmful_count > helpful_count + 3`, auto-transform lesson to explicit warning

**Confidence score:**
- `confidence = (helpful_count + 1) / (helpful_count + harmful_count + 2)` (Laplace smoothing)
- Decays by 0.99× per session without corroboration
- Retrieval multiplied by confidence

**Integration:**
- `findMatchingPatternsHybrid()` in experience-patterns.ts filters/weights by maturity
- Assembly sections weight patterns by confidence
- Stop hook handles promotion + harmful scoring

**Tests:**
- New pattern starts as candidate with confidence 0.5
- Pattern corroborated in 2nd session → established
- Pattern marked harmful 4 times → score drops fast, transforms to warning
- Confidence decays without reinforcement

---

## Part 8: Intent Prediction at Session-Start

**Goal:** Predict what the user will need BEFORE their first prompt. The proactive leap.

**Files:**
- `src/adapters/cc-hooks/session-start.ts` — prediction pipeline
- NEW: `src/intelligence/intent-predictor.ts` — prediction engine
- `src/assembly/assembler.ts` — confidence-gated injection

**Layered prediction (strong → weak anticipation):**

**Layer 0 (Strong — coupling, no model):**
- Active thread with unfinished work? → Load thread artifacts (handles ~70% of sessions)
- Active handoff with tasks? → Load handoff context
- This is the default path. Zero prediction needed — data structure coupling.

**Layer 1 (Weak — simple features):**
- Compute: `hours_since_last_session`, `hour_of_day`, `day_of_week`
- If `hours_since_last_session < 2` → high continuation probability
- Query `temporal_profile` for what user typically does at this time/day
- Query `action_transitions` for likely first actions

**Layer 2 (Weak — pattern matching):**
- Cross-session Markov: "after sessions about testing, next is usually implementation"
- Experience pattern triggers matching current project state
- Unfinished threads ranked by recency and importance

**Confidence scoring:**
- Each layer outputs a confidence score [0, 1]
- Layer 0 starts at 0.8 (strong anticipation), Layer 1 at 0.5, Layer 2 at 0.3
- Only inject predictions above threshold (0.4 initially, tuned via feedback)

**Confidence-gated assembly:**
- Predictions above threshold → included in `assembleFullContext()` as "Predicted Context" section
- Below threshold → available via MCP recall but not auto-injected
- Track: was the predicted context actually referenced? → feeds back to calibrate threshold

**Integration:**
- Runs in session-start hook AFTER checkpoint recovery, BEFORE assembly
- Predictions feed into `assembleFullContext()` as a new section type
- Temporal profile and action transitions updated by stop hook (session close)
- Feedback loop: stop hook checks if predicted context was referenced

**Tests:**
- Short gap between sessions → continuation predicted
- Monday morning, user usually plans → planning context injected
- Low confidence prediction → not injected but available via recall
- Prediction accuracy tracked and logged

---

## Dependency Chain

```
Part 1 (Write-Time Dedup)
  ↓ prevents new bloat
Part 2 (Category-Aware Decay)
  ↓ classifies existing observations
Part 3 (Observation Consolidation)     ← depends on Part 1 (dedup) + Part 2 (classification)
  ↓ reduces observation volume
Part 4 (Negative Retrieval Learning)   ← independent, can parallel with 1-3
  ↓ improves retrieval scoring
Part 5 (Artifact Graph)                ← depends on Part 3 (clean data for linking)
  ↓ enables graph-walk retrieval
Part 6 (Intent Classification)         ← independent, can parallel with 5
  ↓ routes retrieval strategy
Part 7 (Pattern Maturity)              ← independent, can parallel with 5-6
  ↓ quality-gates intelligence layer
Part 8 (Intent Prediction)             ← depends on ALL above (the capstone)
```

**Implementation waves:**
- **Wave 1:** Parts 1 + 2 + 4 + 7 (parallel — independent foundations)
- **Wave 2:** Parts 3 + 5 + 6 (parallel — depend on Wave 1)
- **Wave 3:** Part 8 (depends on everything)

---

## Integration Wiring Map

```
Observation Write Path:
  Hook → insertObservation() → [Part 1: dedup check] → SQLite INSERT → Qdrant embed
                                                      → [Part 2: stability classify]

Angel Heartbeat:
  tick → [existing] pattern extraction
       → [Part 3] observation consolidation (batch 50/tick)
       → [Part 5] bulk artifact linking (batch 20/tick)
       → [existing] activation decay
       → [Part 2] continuous category-aware decay

Session Start:
  hook → create session → recover checkpoint
       → [Part 8] intent prediction (Layer 0 → 1 → 2)
       → assembleFullContext() ← [Part 8] confidence-gated injection

User Prompt Submit:
  hook → [Part 6] classify intent
       → hybridSearchAsync() ← [Part 6] intent-aware parameters
                              ← [Part 5] graph walk as 4th RRF channel
                              ← [Part 4] negative learning weights

Stop:
  hook → [Part 4] score was_referenced for surfaced artifacts
       → [Part 7] pattern maturity promotion + harmful multiplier
       → [Part 8] record prediction accuracy → calibrate threshold
       → [Part 2] update temporal_profile + action_transitions
```

---

## Risk Mitigation

| Risk | Anti-Pattern | Defense |
|---|---|---|
| Consolidation loses detail | Memory Compression | Never delete originals. `consumed` flag + `consolidated_into` pointer |
| Intent prediction wrong at session-start | Clippy | Confidence threshold. Below threshold → available via recall, not injected |
| Graph links create cross-project contamination | Context Collapse | Scope all queries by project. No cross-project links |
| Harmful patterns persist | Stale Model | 4× harmful multiplier + maturity demotion + anti-pattern inversion |
| Dedup false positives (different things look similar) | N/A | Require cosine > 0.85 AND same project. Conservative threshold |
| Angel heartbeat overload | N/A | Batch limits per phase. Skip consolidation if pattern extraction active |

---

## Test Strategy

Each part gets:
1. **Unit tests** for new functions
2. **Integration test** verifying wiring between components
3. **Build verification** (92 files clean)
4. **Full test suite** (1714 existing + new tests pass)

After all parts: end-to-end test simulating a multi-session workflow to verify the complete pipeline from observation capture → dedup → decay → consolidation → retrieval → assembly → feedback.
