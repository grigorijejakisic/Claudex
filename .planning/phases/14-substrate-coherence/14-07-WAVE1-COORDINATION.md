---
phase: 14-substrate-coherence
sub_phase: 14-07
wave: 1
role: PM coordination doc — read by all Wave 1 /auto-orchestrate workers
created_by: PM (Claude Opus 4.7) on 2026-05-16
parent_context: .planning/phases/14-substrate-coherence/14-07-CONTEXT.md
---

# v7.0.0 Wave 1 Coordination Manifest — Substrate Unification

This document is the PM-level contract that every Wave 1
/auto-orchestrate worker MUST honor. Wave 1 collapses the V17 and
legacy `artifacts` substrates into one source of truth. The pattern
is **schema-first → parallel workers → gate**: 14-07a lands the
unified schema solo, 14-07b fans out three workers across ~22 caller
sites in parallel, 14-07c runs the cutover + benchmark gate solo.

Without explicit ownership + merge order, the parallel 14-07b
workers will produce git conflicts on shared helpers / test fixtures.

**Worker structure restored per VERIFICATION-PASS (2026-05-16 afternoon) — 5-worker split based on RCA-3 inventory of 15 production caller files across legacy `artifacts`.** Previous 3-worker spec was structurally wrong: missed 10 caller files entirely, and misidentified `directive-detector.ts` / `retrieval-log.ts` / `transcript-chunker.ts` as legacy callers when RCA-3 classifies them as V17 callers (no migration needed).

---

## Workers + plans

| Worker | Plan | Cluster | Branch | Sequence |
|---|---|---|---|---|
| A  | 14-07a (schema unification + artifact_id_map + re-vectorize helper) | substrate | `phase-14-07/a-schema` | first — blocks everything |
| W1 | 14-07b worker 1 — retrieval | `hybrid-retrieval` + `retrieval-feedback` + `experience-tier` (query shape) | `phase-14-07/w1-retrieval` | parallel after A lands |
| W2 | 14-07b worker 2 — ingestion/embedding | `file-ingester` + `embed-pipeline` + `sqlite-vec-backend` | `phase-14-07/w2-embedding` | parallel after A lands |
| W3 | 14-07b worker 3 — query-surface | `mcp/recall-server` + `cross-project-search` + `observations` | `phase-14-07/w3-query-surface` | parallel after A lands |
| W4 | 14-07b worker 4 — Angel writers | `consolidator` + `retention-sweep` + `entity-summarizer` + `intent-predictor` + `batch-reflection` | `phase-14-07/w4-angel-writers` | parallel after A lands |
| W5 | 14-07b worker 5 — CLI + tests | `cli/health` + shared fixture helper + test fixture sweep | `phase-14-07/w5-cli-tests` | parallel after A lands |
| C  | 14-07c (cutover + benchmark gate) | gate | `phase-14-07/c-cutover` | last — runs after all of W1-W5 lands |

Sequencing:
```
A  (solo, blocks)
   └─→ W1, W2, W3, W4, W5  (parallel)
                          └─→ C  (solo, gates ship)
```

A is single-worker because it defines the unified schema + the
`artifact_id_map` mapping table + the arctic-embed2 re-vectorization
helper. Every W worker depends on A's output; running A in parallel
with anything else is a race condition.

C is single-worker because it runs the cutover (legacy → V17 read
flip + legacy table demotion to read-only mirror) AND the benchmark
gate (Vesna + LongMemEval + LoCoMo + cross-project hit rate). It
cannot start until all of W1-W5 has merged.

---

## File ownership table

PM (me) is the only authority for resolving boundary disputes. Every
worker reads this table before touching a file. If a file isn't
listed here, normal `git add` behavior applies.

### Plan 14-07a (Worker A) owns

- `src/core/migration-steps.ts` — **adds** `migrateV36toV37` (the
  unified-substrate migration step). No edits to prior steps.
- `src/core/migration/v17-runner.ts` — schema-shape extensions for
  the unified artifact table.
- `src/core/migration/v17-triggers.ts` — FTS5 + vec0 trigger updates
  for the unified shape.
- `src/core/artifact-id-map.ts` (NEW) — mapping helpers (legacy
  INTEGER ↔ V17 TEXT hash). Single-source-of-truth for transitional
  ID lookups.
- `src/core/re-vectorize.ts` (NEW) — arctic-embed2 re-vectorization
  helper. Called by 14-07c at cutover, but the helper itself ships
  in 14-07a so test fixtures can exercise it.
- `src/tests/core/migration/v17-unified.test.ts` (NEW) — schema
  migration tests.
- `src/tests/core/artifact-id-map.test.ts` (NEW) — mapping
  round-trip tests.
- `src/tests/core/re-vectorize.test.ts` (NEW) — re-vectorization
  determinism tests (same input ↔ same vector output).
- DDL for legacy `artifacts` table: **read-only mirror flag** added
  by 14-07a; flag flipped to enforced by 14-07c at cutover.

### Plan 14-07b worker W1 (retrieval cluster) owns

- `src/core/hybrid-retrieval.ts` — 8 call sites against legacy
  `artifacts` API → V17 unified API (L3 retrieval centerpiece;
  activation_score reads move to `data` JSON path).
- `src/intelligence/retrieval-feedback.ts` — 5 call sites
  (activation_score lifecycle moves to V17 `data` JSON).
- `src/intelligence/experience-tier.ts` — 1 site (candidate pool
  query). **Note: FILTER semantics are rewritten in 14-07h (Wave 3
  option C). This plan only migrates the QUERY SHAPE.**
- `src/tests/core/hybrid-retrieval.test.ts` — fixture updates for
  V17 unified shape (only fixtures called by W1's files).
- `src/tests/intelligence/retrieval-feedback.test.ts` — same.
- `src/tests/intelligence/experience-tier.test.ts` — same.

### Plan 14-07b worker W2 (ingestion/embedding cluster) owns

- `src/core/file-ingester.ts` — 2 sites (INSERT memory_file /
  session_log / handoff / entity_summary).
- `src/embeddings/embed-pipeline.ts` — 2 sites (UPDATE embedding;
  storage shape changes from legacy single-BLOB to V17
  `artifact_embeddings` sidecar).
- `src/embeddings/sqlite-vec-backend.ts` — 1 site (JOIN to vec
  sidecar).
- `src/tests/core/file-ingester.test.ts` — fixture updates.
- `src/tests/embeddings/embed-pipeline.test.ts` — same.
- `src/tests/embeddings/sqlite-vec-backend.test.ts` — same.

### Plan 14-07b worker W3 (query-surface cluster) owns

- `src/mcp/recall-server.ts` — 2 sites (SELECT by id /
  artifact_ref; exposed via `claudex_recall`).
- `src/core/cross-project-search.ts` — 1 site (SELECT
  cross-project; `claudex_search` expansion).
- `src/core/observations.ts` — 1 site (SELECT artifact_ref).
- `src/tests/mcp/recall-server.test.ts` — fixture updates.
- `src/tests/core/cross-project-search.test.ts` — same.
- `src/tests/core/observations.test.ts` — same (if exists; else
  fixture updates colocated with caller).

### Plan 14-07b worker W4 (Angel writers cluster) owns

- `src/angel/consolidator.ts` — 1 site (UPDATE consolidated_into).
- `src/angel/retention-sweep.ts` — 1 site (DELETE / UPDATE for TTL
  enforcement). **Note: V17 status enum ('active','stale','superseded')
  differs from legacy state enum ('fresh','packed','materialized') —
  TTL semantics may need adjusting per 14-07a's field mapping.**
- `src/angel/entity-summarizer.ts` — 1 site (INSERT entity_summary,
  kind='entity_summary').
- `src/intelligence/intent-predictor.ts` — 1 site (per-turn
  prediction SELECT).
- `src/intelligence/batch-reflection.ts` — 1 site (dedup SELECT for
  learning promotion).
- `src/tests/angel/consolidator.test.ts` — fixture updates.
- `src/tests/angel/retention-sweep.test.ts` — same.
- `src/tests/angel/entity-summarizer.test.ts` — same.
- `src/tests/intelligence/intent-predictor.test.ts` — same.
- `src/tests/intelligence/batch-reflection.test.ts` — same.

### Plan 14-07b worker W5 (CLI + tests cluster) owns

- `src/cli/health.ts` — 1 site (INSERT test fixture).
- `src/tests/helpers/v7-unified-schema.ts` (NEW) — shared fixture
  helper for the post-Wave-1 unified schema. W1-W4 consume; only W5
  modifies.
- `src/tests/cli/health.test.ts` — fixture updates.
- General sweep across `src/tests/**` for fixtures that reference
  legacy `artifacts` schema and need migration to V17 unified shape.
  W5 is the only worker that does test-fixture sweeps outside its
  own caller's tests.

### Files NOT in 14-07b (V17 callers per RCA-3 — no migration needed)

These appeared in the original 3-worker spec but per RCA-3 are
already V17 callers (or have no legacy `artifacts` reference):

- `src/intelligence/directive-detector.ts` — V17 caller
  (`kind='directive_rule'`).
- `src/intelligence/retrieval-log.ts` — V17 caller
  (`kind='transcript_chunk'`).
- `src/angel/transcript-chunker.ts` — V17 caller (INSERT against
  V17 directly).
- `src/angel/memory-md-writer.ts` — V17 caller (1 SELECT guard
  against V17). **Not in this plan.**

If any worker discovers a legacy `artifacts` reference in one of
these files during their sweep, they STOP, file to PM via integration
branch comment, and the file is added to whichever cluster's worker
fits best.

### Plan 14-07c (Worker C) owns

- `src/scripts/cutover-v7.ts` (NEW) — the cutover script
  (idempotent, dry-run by default, operator-runnable).
- `src/scripts/run-wave1-benchmarks.ts` (NEW) — orchestrates Vesna
  + LongMemEval + LoCoMo + cross-project hit rate against the
  post-migration state.
- `src/core/migration-steps.ts` — **adds** the read-only-enforcement
  flag flip for legacy `artifacts` (post-B merge).
- `src/tests/scripts/cutover-v7.test.ts` (NEW) — cutover idempotency
  + dry-run tests.
- `.planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md`
  (NEW) — PM-maintained, records benchmark outputs against the gate
  thresholds.

---

## Merge order

PM merges in this order:

1. **14-07a (Worker A) first** — schema migration is additive. No
   conflict possible because W1-W5 and C haven't started yet.
2. **W1, W2, W3, W4, W5 in parallel** after A lands. Each commits to
   its own feature branch. PM merges in alphabetical order
   (W1 → W2 → W3 → W4 → W5) — they own non-overlapping files, so
   merge order is semantic-equivalent. The only shared surface is
   `src/tests/helpers/v7-unified-schema.ts` (W5-owned; consumed by
   others via import); if W1-W4 reference it before W5 lands, their
   tests fail until W5 merges — acceptable, fix-on-merge.
3. **14-07c (Worker C) last** — runs the cutover script + benchmark
   gate. Cannot start until all of W1-W5 is merged AND the integration
   branch passes `bun run build` and `bun run test`.

---

## Cross-plan invariants

Contracts that span multiple plans within Wave 1. PM enforces;
workers honor.

1. **artifact_id_map is single-writer.** Only 14-07a populates it
   during initial schema migration. Workers in 14-07b read from it
   but do not modify the table or its schema.

2. **Re-vectorization helper is single-owned by 14-07a.** Workers in
   14-07b call `re-vectorize.ts` helpers but do not reimplement.
   14-07c invokes the helper at cutover time.

3. **memory-md-writer.ts is owned by B3 only.** If B1 or B2 discover
   a memory-md-writer call site during their caller sweep, they
   STOP, file the site to B3 via integration branch comment, and
   wait for B3 to handle it.

4. **No worker introduces net-new caller sites.** 14-07b is a
   *migration* of existing sites. If a worker finds a caller site
   missed by RCA-3's inventory, they add it to 14-07b-PLAN.md's
   site list and migrate it — they do NOT add new code paths.

5. **No production-shape changes to retrieval ranking math.** Per
   CONTEXT out-of-scope. If a worker is tempted to "improve"
   ranking weights, hybrid-retrieval scoring, or reranker logic
   during their migration, they STOP and surface to PM. Same-family
   blind spots apply (`memory/feedback_same_family_teammates_blind_spots.md`).

6. **No worker changes embedder model, reranker model, or vector
   dimensions.** arctic-embed2 (1024d) + BGE-v2-m3 stay. The
   re-vectorization in 14-07a uses the same arctic-embed2 model
   applied to the unified shape; it is not a model swap.

7. **Test fixture schema:** any test that creates a fresh DB and
   seeds rows must use the post-Wave-1 schema (post-V37). W5's
   shared fixture helper at `src/tests/helpers/v7-unified-schema.ts`
   is the canonical seed. W1-W4 consume it; only W5 modifies it.

8. **No worker emits link-write helpers.** Soft/hard link tables
   don't exist until Wave 2. Any code that writes "this artifact
   links to that artifact" belongs to Wave 2 / 14-07-LINKS-SCHEMA.
   If a worker finds a place that "wants" linking semantics, they
   leave a TODO comment referencing `14-07-LINKS-SCHEMA` and move
   on.

---

## Anti-scope for the wave

Plans in Wave 1 must NOT:

- Touch link tables (Wave 2 / `14-07-LINKS-SCHEMA-PLAN.md` territory).
  Tables don't exist yet anyway.
- Touch session-start assembler section ordering, lesson surface,
  or codebase-context annotation (Wave 3 territory: 14-07h / 14-07i
  / 14-07j).
- Refactor adjacent code "for cleanup." Per
  `memory/feedback_same_family_teammates_blind_spots.md`, same-family
  blind spots cause silent scope creep. Operator surfaces if cleanup
  needed; workers do not improve silently.
- Add new retrieval features, new candidate sources, or new query
  expansion logic.
- Modify the project-scope filter for experience-tier (14-07h
  territory).
- Change `bun run setup` hook registration (Phase 14 v6.6.0 wave
  already shipped 25 hooks for V36 schema; Wave 1 ships V37, hook
  registration update goes in 14-07a as part of the migration step).
- Change the `~/.claudex/db/claudex.db` file path or DB instance
  topology.

---

## Worker → PM escalation

Workers ask the PM (me) when they hit:

- A file that isn't in their ownership column AND isn't in another
  plan's ownership column (judgment call — PM decides).
- A schema decision not covered in their PLAN.md or this manifest.
- A test that fails for a reason outside their plan's scope (the
  failure may be uncovering a real bug elsewhere).
- A spec ambiguity in their PLAN.md.
- A caller site that, when migrated, would change the *behavior*
  (not just the shape) of the call — this is a scope question.

Workers do NOT escalate for:

- Standard implementation choices (variable naming, function
  signature minor variations, test structure within their plan's
  test files).
- Build / test re-run mechanics.
- Anything explicitly listed in their plan's `must_haves.truths` or
  in this manifest's invariants.

---

## PM → PO escalation

I (PM) escalate to the PO (operator) when:

- A worker reports a fundamental contradiction between two plan ACs.
- A schema decision proposed by a worker would change the contract
  matrix from 14-CONTEXT.md.
- The merge order produces an unresolvable conflict.
- A worker's external review (Codex / Gemini) returns NO-SIGNOFF
  with a load-bearing concern.
- Benchmarks at 14-07c gate fail (any regression in Vesna /
  LongMemEval / LoCoMo / cross-project hit rate). **Critical:** PM
  does NOT auto-rollback. PM surfaces, operator decides whether to
  hold the cutover or accept the regression with documented
  rationale.

---

## SIGNOFF + ship per plan

Each plan ships its own commit with:

- All AC from the plan green
- Tests pass within the plan's scope (`bun run test` filtered)
- Cross-family external review (Codex + Gemini) SIGNOFF
- PM merge after order check
- Updated `.planning/phases/14-substrate-coherence/14-07-WAVE1-STATUS.md`
  (PM-maintained) noting completion

After all of A + B1/B2/B3 + C land, PM kicks off Wave 2 by writing
the wave-2 status entry against the actual landed state. The Wave 2
coordination doc (`14-07-WAVE2-COORDINATION.md`) is already authored
during spec writing, but it gets a per-execution status appended at
Wave 2 entry.

---

## Wave 1 gate handoff to Wave 2

When Wave 1 exits cleanly:

- All A + B + C ACs green.
- Vesna 18/18 PASS against post-migration state.
- LongMemEval ≥ v6.6.0 baseline (90.6% Oracle).
- LoCoMo ≥ v6.6.0 baseline (55.5% Sonnet 4.6).
- Cross-project candidate hit rate non-regressed (currently 18%
  noise post-14-03).
- `artifact_id_map` populated for 100% of rows in legacy `artifacts`.
- Legacy `artifacts` table is read-only mirror (writes refused at
  DDL level via 14-07c's enforcement flag flip).
- Re-vectorized embeddings in V17 unified vector store
  (`vec_artifact_v17`).
- All 22+ caller sites read from V17 unified API.
- WAVE2-COORDINATION dispatch unblocked (link tables can now
  reference unified artifact IDs).

**No tag is created at wave boundary.** Tags only fire at v7.0.0
ship. The integration branch `phase-14-07/wave1-integration` merges
into the longer-lived `v7.0.0-rc` branch after Wave 1 exit.

---

## What this is NOT

- Not a replacement for the per-plan PLAN.mds — this is the
  inter-plan coordination layer above them. Plans define what
  changes; this doc defines who changes what and when.
- Not a substitute for git's actual conflict resolution. If
  collision happens despite this doc, PM resolves manually.
- Not authority for scope changes. Plans + this manifest + CONTEXT
  define scope; changes require PO (operator) sign-off.
- Not a benchmark gate definition — that lives in 14-07c-PLAN.md.
  This manifest only enforces that the gate runs and that PM does
  not auto-rollback on regression.
