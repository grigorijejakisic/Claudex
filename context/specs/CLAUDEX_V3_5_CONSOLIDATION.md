# Claudex v3.5 — Consolidation Spec

**Status:** Draft, unstarted. Written at end of session 49 as handoff to next session.
**Author:** Crux (Claude Opus 4.6 with 1M context), session 49
**Scope:** Measurement-gated consolidation of Claudex v3 — NOT a ground-up rewrite.
**Spiritual predecessor:** This spec exists because during session 49 I (Crux) shipped
`project_curated_context` as a bypass for a retrieval failure, and in the after-action
review I realized the bypass is itself a symptom of accreted architecture. This spec
is my attempt to give the next agent a battle order that addresses root causes instead
of patching symptoms.

---

## Read this first

You (the next agent) have a handoff waiting for you in the Project Curated Context slot
(P2.1 injection at session start). The handoff mental models are seeded in
`project_curated_context` with `source_session_id = d4e1d7e0-48c3-4449-abaf-eb04f05eeeb6`.
If /starthere does not render them, the curated-context feature broke between sessions —
diagnose that FIRST before touching anything else.

**Do not rewrite Claudex v4 from scratch.** The user and I explicitly agreed this is a
consolidation, not a rewrite. 124 commits of hard-won bug fixes live in the current
architecture. Rewriting loses them.

**Measurement-gated means:** every phase must run LoCoMo before committing. If LoCoMo
drops more than 2 points compared to pre-phase baseline, REVERT that phase's commits
and re-plan. No exceptions. The entire point of this spec is to stop making architecture
decisions without data.

---

## Why this work exists — diagnosis

After 48 sessions of organic growth, Claudex v3 has a real architectural problem that
will not fix itself. Specifically:

### Concept proliferation

Nine different tables where "a piece of knowledge" can live:

| Table | Purpose | Extractor |
|---|---|---|
| `observations` | Raw tool output | CC hooks |
| `decisions` | Choices made | CC hooks + Angel |
| `learnings` | Generalizable rules | CC hooks (post-tool-use) + Angel |
| `experience_patterns` | Correction-derived if-then rules | Angel pattern-extractor |
| `angel_opinions` | CARA inferred beliefs about entities | Angel CARA loop |
| `artifacts` with `type=entity_summary` | Consolidated entity knowledge | Angel entity-summarizer |
| `critical_rules` | Drift-resistant always-inject reminders | CLAUDE.md markers + promotion |
| `project_curated_context` | Agent-curated theory/workspace/shipped (new, session 49) | Angel curated-context-extractor + agent at /endsession |
| `session_journal` with `entry_type=milestone` | Narrative spine | CC hooks |

The same insight — e.g., "prefer Sonnet for workers, Opus for product-defining work" —
could legitimately be a `learning`, an `experience_pattern` with `pattern_type='behavioral'`,
a `decision` with `source='direction'`, an `angel_opinion` with `source_type='user_stated'`,
a `critical_rule` with `drift_risk='working-method'`, OR a `preference` in
`project_curated_context`. **The answer is "it depends on which subsystem wrote it first"
and that is not a design — it is sediment.**

### Extraction path proliferation

Six different Angel subsystems extract structured knowledge from the same input (completed
session transcripts):

1. `pattern-extractor.ts` — corrections + directives → `experience_patterns`
2. `pattern-extractor.ts::classifySessionDomains` — topic → `capability_boundaries`
3. `entity-summarizer.ts` — recurring entities → `artifacts` with `type=entity_summary`
4. CARA opinion former — inferred beliefs → `angel_opinions`
5. `consolidator.ts` — similar observations → merged observations
6. `curated-context-extractor.ts` — reframes/directives → `project_curated_context` (NEW)

**Each has its own prompt, its own LLM call, its own dedup logic, its own output table.**
They should be ONE extractor with ONE LLM call that emits multiple `kind`s of structured
knowledge. Deletes ~2000 lines.

### Retrieval path proliferation

At session start, the assembler injects ~15 sections from ~8 retrieval subsystems:

- Experience warnings (FTS5 + vector hybrid)
- Proven principles (always-on)
- CARA Angel opinions (confidence-gated)
- Entity summaries (hardcoded SQL)
- Proactive curator (gap detection)
- L2 reference layer (packed artifact metadata)
- L3 materialization layer (FTS5-selected full content)
- Project Curated Context (NEW, always-on bypass)

Each has its own query logic, its own budget, its own failure modes. A unified
`retrieve(query, project, budget)` function with kind-aware priority weighting would
replace all eight.

### LoCoMo is at 55.5%

Hindsight, Letta, Zep, Mem0 all report ~85-92% on the LoCoMo benchmark. Claudex is
at 55.5%. This is the single most important measurable fact about the system right
now. **Retrieval is leaking 30+ percentage points of quality** against the most
relevant conversational-memory benchmark, and no amount of new tables will move that
number. Whatever is causing the 30-point gap is more important than any of the
above proliferation problems.

### The curated-context system I shipped is itself evidence of the problem

In session 49 I added `project_curated_context` as an always-on injection slot at
P2.1, bypassing RRF ranking. I did it because the Lacuna-Betting user kept losing
mental-model context across sessions. I was paving over a retrieval failure with a
privileged slot. The right fix was "make retrieval good enough that a bypass isn't
needed," but that would have taken 4 weeks and I wanted to ship something useful in
an afternoon.

**In v3.5, if Phase D (retrieval unification) succeeds, `project_curated_context`
should be retired.** The entries become `knowledge_fragment` rows with
`kind='mental_model'` and `importance=high`, and they rank naturally in the unified
retriever. I built the bypass; I should be the first to delete it if the underlying
retrieval is actually good.

---

## Non-goals

**Out of scope — do not touch:**

1. **Ground-up rewrite.** Rewrites are where working systems go to die. The 90.6% on
   LongMemEval Oracle is genuinely competitive and must not regress.
2. **The reranker.** BGE-reranker-v2-m3 on port 7439, supervised by Angel's
   `RerankerSupervisor`. Session 48 hardened it after a silent failure incident.
   Do not touch unless LoCoMo diagnosis specifically points here.
3. **sqlite-vec and the 5 vec0 virtual tables.** The V14→V15 migration is the foundation
   of the vector store. Removed Qdrant. Production-proven. Leave alone.
4. **CC hook plumbing.** 26 hooks in `src/adapters/cc-hooks/`. The payload-truth work
   is done. Don't re-open.
5. **Angel supervisor pattern.** RerankerSupervisor + LlamaServerSupervisor. Working.
6. **Local llama-server setup.** Gemma 4 31B Q6_K on 127.0.0.1:8081. Verified working
   in session 49 including JSON extraction quality.
7. **LongMemEval benchmark.** The 90.6% score is strong. Don't risk it. The target
   is LoCoMo, which is currently 55.5%.
8. **Embeddings (arctic-embed2 via Ollama).** Working, 1024-dim, native for sqlite-vec.
9. **Sunset of Qdrant / CliProxy.** Both already removed. Don't reintroduce them.

**Explicitly NOT out of scope — these are fair game:**

- `decisions`, `learnings`, `experience_patterns`, `angel_opinions`, `entity_summaries`,
  `critical_rules`, `project_curated_context` (consolidation targets)
- All Angel extractors except CARA opinion formation (unify as Phase C)
- The assembly pipeline's retrieval subsystems (unify as Phase D)
- The assembler's 15-section injection cascade (simplify as Phase D)

---

## Success metrics

Every phase must be measured against these. If a phase regresses any of them by more
than the tolerance, **revert the phase's commits and replan.**

| Metric | v3 baseline | v3.5 target | Tolerance |
|---|---|---|---|
| LoCoMo score | 55.5% | ≥ 75% | no regression > 2pp at any phase |
| LongMemEval Oracle | 90.6% | ≥ 88% | no regression > 2pp ever |
| Table count | 33 | ~25 | via view-based migration, no data loss |
| Angel extractor LLM calls per session | 4-6 | 1 | after Phase C |
| Retrieval entry points | 8 | 1 | after Phase D |
| Test count | 2335 passing | 2335+ | no regression |
| Build time | ~90ms | ≤ 120ms | esbuild bundle stays fast |

**LoCoMo gate is the hard constraint.** Every phase commit must be preceded by a LoCoMo
run. The score goes in the commit message. If it drops more than 2 points from the
pre-phase baseline, the phase is reverted and re-planned.

---

## Phase A — Diagnose LoCoMo

**Goal:** Find out WHERE the 45% retrieval loss is happening. No refactoring. Pure
instrumentation and diagnosis.

**Duration estimate:** 1 week (5-10 focused hours).

**Why this must come first:** Every architectural decision downstream depends on
knowing whether the retrieval failure is in (a) the embedding model, (b) chunking
strategy, (c) the reranker cutoff, (d) query formulation, (e) the LLM judge, or (f)
something else entirely. Rebuilding without this knowledge is guessing.

**Inputs:** LoCoMo dataset. Hybrid retrieval pipeline instrumented to log every stage.

**Outputs:** `context/specs/LOCOMO_DIAGNOSIS.md` — a report answering:
- What percentage of questions fail because the right chunk is NOT in the top-50
  RRF candidates? (Embedding/chunking problem)
- What percentage fail because the right chunk IS in top-50 but reranker pushes it
  below the cutoff? (Reranker problem)
- What percentage fail because the generator gets the right chunk but produces a
  wrong answer? (Generator problem, not retrieval)
- What percentage of failures are from the LLM judge being lenient/harsh? (Measurement
  problem)

**Concrete steps:**

1. **Read the existing LoCoMo harness.** Find where it lives (`src/tests/benchmarks/`
   or `benchmark/`). Understand how scores are calculated.
2. **Instrument `hybridSearchSync` in `src/core/hybrid-retrieval.ts`** to log, per
   query:
   - Top-50 vector candidates (pre-rerank) with scores
   - Top-50 FTS5 candidates (pre-rerank) with scores
   - RRF fused top-20 with scores
   - Reranker top-10 with scores
   - Final top-k returned
3. **Run LoCoMo with instrumentation enabled.** For each failed question, record the
   gold answer's chunk ID and trace where it was lost in the pipeline.
4. **Categorize failures** into the four buckets above. Produce a histogram.
5. **Write `LOCOMO_DIAGNOSIS.md`** with the histogram, 10 representative failures from
   each bucket, and a prioritized fix list.

**Exit criteria:**
- Diagnosis report exists with a concrete prioritized fix list
- Phase B / C / D ordering is updated based on the diagnosis
- Zero code changes to retrieval logic in this phase (instrumentation only)

**Estimated commits:** 2-3 (add instrumentation, run benchmark, write diagnosis).

**What NOT to do in Phase A:**
- Don't change the embedding model
- Don't change the reranker cutoff
- Don't change the chunking strategy
- Don't try to "fix" anything. Just measure.

---

## Phase B — Unify knowledge types

**Goal:** Collapse 9 overlapping storage tables into ONE `knowledge_fragment` primitive
with LLM-classified `kind`.

**Duration estimate:** 2 weeks.

**Preconditions:**
- Phase A complete
- Phase A diagnosis does not indicate retrieval quality is primarily a knowledge-typing
  problem (in which case this phase moves first; more likely the typing is orthogonal)

**Target schema:**

```sql
CREATE TABLE knowledge_fragment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,                  -- project name or '__global__'
  kind TEXT NOT NULL,                     -- LLM-classified at ingestion
  content TEXT NOT NULL,                  -- the payload
  importance INTEGER NOT NULL DEFAULT 3,  -- 1-5
  confidence REAL NOT NULL DEFAULT 0.7,   -- 0.0-1.0
  source_kind TEXT NOT NULL,              -- 'hook' | 'angel' | 'agent' | 'user'
  source_session_id TEXT,
  supersedes_id INTEGER REFERENCES knowledge_fragment(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'superseded', 'proposed', 'archived')),
  tags TEXT,                              -- JSON array
  embedding BLOB,                         -- 1024-dim arctic-embed2
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`kind` values are NOT a CHECK-constrained enum. They are LLM-classified strings like:
`correction`, `mental_model`, `reframe`, `directive`, `workspace_fact`,
`shipped_component`, `entity_summary`, `open_question`, `decision`,
`failure_pattern`. The LLM emits a kind string; a separate `kind_registry` table
tracks seen kinds and their counts for analysis. **No schema migration required to
add new kinds** — they just show up.

**Migration strategy (no data loss):**

1. **Add `knowledge_fragment` table without touching legacy tables.**
2. **Write `src/core/kind-migration.ts`** — a one-shot script that reads every row
   from `decisions`, `learnings`, `experience_patterns`, `angel_opinions`, the
   `entity_summary` artifacts, `critical_rules`, and `project_curated_context`, and
   inserts each as a `knowledge_fragment` with the appropriate `kind`.
3. **Run the migration in a single transaction.** If it fails, roll back.
4. **Create legacy views** that read from `knowledge_fragment`:
   ```sql
   CREATE VIEW decisions AS
     SELECT id, content, ... FROM knowledge_fragment WHERE kind IN ('decision', 'user_directive');
   -- etc.
   ```
   Existing callers continue working against the views.
5. **Ship Phase B1: migration + views. Do not delete legacy tables.** Let the system
   run for a week on views. Verify LoCoMo + LongMemEval do not regress.
6. **Ship Phase B2: update callers to read from `knowledge_fragment` directly.**
   One caller at a time, test-gated.
7. **Ship Phase B3: drop the legacy tables.** ONLY after all callers are off them.
   This is the irreversible step — gate it on a full test suite + both benchmarks.

**Files primarily touched:**
- `src/core/schema.ts` — new table + views
- `src/core/migrations.ts` + `src/core/migration-steps.ts` — V16 → V17 migration
- `src/core/knowledge-fragment.ts` — new CRUD module
- `src/core/kind-migration.ts` — new one-shot data migration
- Every caller of `decisions`, `learnings`, `experience_patterns` tables

**Exit criteria:**
- `knowledge_fragment` table populated with all legacy data
- Legacy tables still present as views
- LoCoMo ≥ pre-phase baseline - 2pp
- LongMemEval ≥ 88% (hard floor)
- All 2335+ tests pass

**Estimated commits:** 8-12 (migration, views, caller updates staggered, table drops).

---

## Phase C — Unify extraction

**Goal:** Replace 6 Angel extractors with 1 semantic ingester that makes ONE LLM call
per session and emits multiple `kind`s of `knowledge_fragment`.

**Duration estimate:** 1 week.

**Preconditions:** Phase B complete (so there's somewhere to write unified output).

**Target architecture:**

```
src/angel/semantic-ingester.ts
  extractFromSession(db, sessionId, project) -> {
    fragments: KnowledgeFragment[];
    summary: string;
  }
```

Single prompt template that asks Gemma:
> "Read this session transcript. Extract all noteworthy knowledge as JSON fragments.
> Each fragment has: kind (free-form string describing what it is), content (active
> voice), importance (1-5), confidence (0.0-1.0), reasoning (one sentence).
> Examples of kinds: correction, mental_model, reframe, user_directive,
> workspace_fact, shipped_component, open_question, entity_summary, decision,
> failure_pattern. Emit [] if nothing noteworthy."

One LLM call. One JSON response. Up to N fragments per session. Each fragment gets
dedup-checked and written to `knowledge_fragment` with `source_kind='angel'`.

**Callers to delete after migration:**
- `src/angel/pattern-extractor.ts` — replaced
- `src/angel/entity-summarizer.ts` — replaced (entity summaries become fragments with
  `kind='entity_summary'`)
- `src/angel/curated-context-extractor.ts` — replaced (today's work becomes a
  caller of the unified extractor that happens to emit certain kinds)
- Domain classification in `pattern-extractor.ts::classifySessionDomains` — replaced
- Parts of `consolidator.ts` — replaced where it was doing "summarize observations,"
  kept where it's doing "cluster and merge"
- CARA opinion formation — may be kept if it's pure logic (reinforcement counts)
  rather than LLM extraction

**Files primarily touched:**
- `src/angel/semantic-ingester.ts` — new
- `src/angel/heartbeat.ts` — replace 6 extractor phases with 1
- Delete ~2000 lines across the old extractors

**Exit criteria:**
- Single LLM call per session for extraction
- Fragment count per session matches or exceeds the legacy-extractor count
- LoCoMo ≥ pre-phase baseline - 2pp
- LongMemEval ≥ 88%

**Estimated commits:** 4-6.

---

## Phase D — Unify retrieval

**Goal:** Replace the 8-subsystem retrieval stack with a single `retrieve()` function.

**Duration estimate:** 1 week.

**Preconditions:** Phase B complete. Phase A diagnosis informs the internal design.

**Target architecture:**

```
src/core/retrieval.ts
  retrieve(
    db: Database,
    opts: {
      query: string;
      project: string;
      budget: number;          // token budget
      kinds?: string[];        // filter by kind (optional)
      session_id?: string;     // for per-session suppression
    }
  ) -> { fragments: RankedFragment[]; tokensUsed: number; }
```

Internal pipeline:
1. Vector search (top-50)
2. FTS5 search (top-50)
3. RRF fusion → top-30
4. Cross-encoder rerank → top-15
5. Kind-priority weighting (mental_model + reframe + constraint get boosts)
6. Deduplicate + budget-gate
7. Return ranked list

The assembler's 15-section injection cascade becomes ~5 calls to `retrieve()` with
different queries and kind filters. `experience_warnings`, `proven_principles`,
`entity_summaries`, `project_curated_context` — all become kind-filtered `retrieve()`
calls.

**Exit criteria:**
- Single retrieval entry point
- Assembler LOC reduced by 30%+
- LoCoMo ≥ 75% (the target — Phase D is where the big win lives if diagnosis was right)
- LongMemEval ≥ 88%

**Estimated commits:** 5-8.

---

## Phase E — Retire `project_curated_context`

**Goal:** Delete the bypass table I (Crux, session 49) shipped in session 49. If
Phase D made retrieval good enough, the bypass is no longer needed — mental_model
fragments will rank naturally.

**Duration estimate:** 2 days.

**Preconditions:** Phase D complete. LoCoMo ≥ 75%. Verified that manually-seeded
high-importance mental_model fragments rank in the top-5 at session start.

**Steps:**

1. Migrate all `project_curated_context` rows into `knowledge_fragment` with
   appropriate kinds (`mental_model`, `reframe`, `constraint`, `preference`,
   `workspace_fact`, `shipped_component`).
2. Delete the P2.1 assembly injection slot in `src/assembly/assembler.ts`.
3. Delete `src/assembly/sections.ts::formatCuratedContextSection`.
4. Delete `src/core/curated-context.ts`.
5. Delete `src/angel/curated-context-extractor.ts`.
6. Delete the `claudex_curated_context` MCP tool.
7. Delete the `/endsession` Step 1c and `/starthere` Step 2 edits from the dotfiles
   skill files.
8. Delete tests for the above.
9. Drop the `project_curated_context` table.

**If Phase D did NOT make retrieval good enough:** Phase E is SKIPPED. The bypass
stays. That's fine — admitting the bypass is load-bearing is better than deleting it
prematurely.

**Estimated commits:** 2-3.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| LoCoMo diagnosis reveals the problem is the generator, not retrieval | Medium | Phase B/C/D still clean up architecture; reframe the success metric to "LongMemEval ≥ 88% + simpler architecture" |
| Gemma 4 Q6 quality regression vs. Sonnet in the unified extractor | Medium | Phase C runs extraction against 10 fixture sessions, compares fragment count/quality to legacy extractors before shipping |
| `knowledge_fragment` kind proliferation becomes its own mess | Medium | `kind_registry` table with counts — prune kinds with <5 uses after 3 months |
| Legacy views break a caller I didn't anticipate | Medium | Phase B1 ships views-only and soaks for a week before caller updates |
| The next agent (you) decides to skip Phase A and jump to Phase B | Low but catastrophic | This spec explicitly forbids it and the first seeded curated-context entry reinforces it |
| LoCoMo harness itself is broken and gives false numbers | Medium | Phase A step 1 is "read the harness" — verify it works on a known-good baseline first |
| Rewriting instead of consolidating | Low | The user and I explicitly agreed this is consolidation. Do NOT start a v4 greenfield. |

---

## Rollback plan

Every phase has an atomic rollback:

- **Phase A:** instrumentation only, no rollback needed
- **Phase B1** (migration + views): `DROP TABLE knowledge_fragment` + `DROP VIEW`s.
  Legacy data untouched.
- **Phase B2** (caller updates): revert commits. Views still work.
- **Phase B3** (legacy table drops): **this is the irreversible step.** Take a full DB
  backup to `~/.claudex/backups/pre-v3_5-drop-<timestamp>.db` before running. Verify
  the backup restores cleanly before committing.
- **Phase C** (extraction unification): revert commits. Legacy extractors still exist
  as deleted files in git history; restore them.
- **Phase D** (retrieval unification): revert commits. Assembler reverts to 15-section
  cascade.
- **Phase E** (curated-context retirement): revert commits.

Every commit message in every phase MUST include the current LoCoMo and LongMemEval
scores. If rollback is needed, the commit history shows exactly which commit triggered
the regression.

---

## Next-session handoff protocol

I (Crux, session 49) have seeded four curated-context entries in the live Claudex DB
that capture the mental model you need to start this work. They will render in your
`/starthere` at P2.1. Specifically:

1. **Current state mental model** — Claudex v3 is accreted but functional. Don't rewrite.
2. **v3.5 direction** — consolidate, measurement-gated, LoCoMo-first.
3. **Phase A priority** — diagnose before prescribing. Instrument, measure, then decide.
4. **Self-awareness constraint** — the curated-context system I built is evidence of the
   problem, not the solution. If Phase D succeeds, retire it.

**Your first actions:**

1. Read this spec completely.
2. Check `/starthere` injected context — verify the four curated-context entries render.
   If not, the P2.1 injection broke between sessions. Diagnose THAT first.
3. Run the LoCoMo harness on the CURRENT (v3) system and record the baseline. Even if
   the spec says 55.5%, verify it empirically.
4. Begin Phase A step 1: read the LoCoMo harness source and understand how scores are
   calculated.
5. **Do NOT write any new tables, modules, or features until Phase A is complete.**
   The instinct will be to start building; resist it. Phase A is measurement-only.

**If the user pushes for faster progress:** point at this spec, specifically at the
"measurement-gated" language and the Risks section row about "next agent skips Phase A."
Phase A exists because I (session 49) built a bypass feature without diagnosing the
underlying retrieval problem. Don't repeat that mistake.

**If you disagree with any part of this spec:** that's fine and expected. Write your
disagreement into a new file `context/specs/CLAUDEX_V3_5_REVIEW.md` with concrete
evidence, then discuss with the user before changing direction. Do not silently
deviate from the plan.

---

## What session 49 did — context for the reader

Session 49 shipped five commits that are relevant to this spec:

| Commit | What |
|---|---|
| `cc6af6d` | Phase 1: project_curated_context schema + CRUD + P2.1 assembly injection |
| `53fd42e` | Phase 2: MCP tool + /endsession + /starthere skill updates |
| `32c5370` | Phase 3: Angel curated-context-extractor + heartbeat wire-in |
| `8101139` | Path B-1: LlamaServerSupervisor + llama-client infrastructure |
| `742b894` | Path B-2: replace CliProxy+Ollama generation with local Gemma 4 31B |
| `39b41a1` | Path B-3: Gemma-verified budgets + --flash-attn fix + health timeout |

Empirical findings from session 49:
- **CliProxy is banned for MAX subscription use** (Anthropic policy). Any call to
  `127.0.0.1:8317/v1/chat/completions` returns `authentication_error`. This means
  Angel's pre-session-49 pattern extraction was silently broken for an unknown period.
- **Gemma 4 31B Q6_K runs at ~6-8 tok/s on RTX 5090.** Cold start ~25s. A 4096-token
  response worst-case is ~10 minutes.
- **Gemma 4 has a reasoning_content field that counts against max_tokens.** Budget at
  least 1024 tokens per call, 4096 for structured extraction. Under-budgeting silently
  produces truncated JSON.
- **The --flash-attn flag in modern llama.cpp requires an explicit value** (on|off|auto).
  Bare --flash-attn blows up the arg parser. Both my supervisor and the user's
  run-gemma.sh had this bug — fixed in the supervisor (commit 39b41a1).
- **Gemma produces valid structured JSON for extraction prompts** when given adequate
  budget. Verified end-to-end against the curated-context extraction system prompt
  with a realistic reframe transcript. Four entries extracted, all passed validation.

Infrastructure that is live and verified at the start of this spec:
- llama-server on 127.0.0.1:8081 serving Gemma 4 31B Q6_K
- Reranker on 127.0.0.1:7439 (BGE-v2-m3)
- Ollama on 11434 (embeddings only — arctic-embed2)
- V16 schema with `project_curated_context` table
- 3 seeded curated-context entries (2 project-scoped, 1 global) — these will render
  at your /starthere

---

## One last thing

I'm leaving this note because it took me 10 hours to see what's wrong with Claudex v3
clearly, and I don't want you to have to rediscover it.

**The problem with v3 is not what's missing. It's what's duplicated.** Every time
someone added a new capability, they added a new table, a new extractor, a new
retrieval path. Nobody ever said "wait, this overlaps with three other things — can
we unify instead?" I am guilty of this too; the curated-context system I shipped is
literally another table that overlaps with four other tables.

The fix isn't to add a better version. The fix is to look at what exists, see the
redundancy, and collapse it carefully while measuring that we don't regress. That's
all v3.5 is.

Good luck. Measure before you cut.

— Crux, session 49
