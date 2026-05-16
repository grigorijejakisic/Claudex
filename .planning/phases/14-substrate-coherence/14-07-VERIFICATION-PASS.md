---
date: 2026-05-16
verifier: main session (Claude Opus 4.7)
mode: read-only verification of v7.0.0 spec against actual codebase
parent: .planning/phases/14-substrate-coherence/14-07-CONTEXT.md
scope: all 15 docs in 14-07-* + cross-checks against src/, schema, RCA-3
---

# v7.0.0 Spec Verification Pass — Delta Report

This document is the verification-pass output for the v7.0.0 spec authored 2026-05-16. The pass reads the spec's claims against the actual codebase via grep/read; surfaces factual deltas, cross-plan inconsistencies, and design concerns.

**Headline:** the spec has the right SHAPE but multiple LOAD-BEARING DETAILS are wrong. The most serious errors are:
- Wrong file paths for two centerpiece files (hybrid-retrieval, file-ingester).
- Wrong function names in `sections.ts` (the lessons function I called `formatLessonsSection` doesn't exist; the codebase-context formatter is inlined in `assembler.ts`, not in `sections.ts`).
- Wrong schema field mapping (summary→title, content→body, importance→confidence are LOSS-MAPS, not identity-renames as my spec implied).
- Wrong caller distribution (RCA-3 names 15 files with caller sites, not the 7 I clustered into 3 workers).
- A whole-design-concern: the experience-tier "project-scope filter" I specced for 14-07h would KILL the cross-project transfer that is the tier's WHOLE PURPOSE.

The spec is **not throw-away-and-restart bad**, but it needs a re-pass before any worker dispatches.

---

## Section A — Factual deltas (spec_claim → codebase_truth → fix)

### A1. File paths

| Spec said | Codebase has | Where the spec claims it | Fix |
|---|---|---|---|
| `src/intelligence/hybrid-retrieval.ts` | `src/core/hybrid-retrieval.ts` | WAVE1-COORD B1, 14-07b, 14-07e | **Update all references.** Eight different spec docs reference this path. |
| `src/angel/file-ingester.ts` | `src/core/file-ingester.ts` | WAVE1-COORD B2, 14-07b | Same fix. |
| `src/angel/boundary-detector.ts` | `src/angel/boundary/boundary-detector.ts` (subdir) | 14-07f Task 4 | Update reference. Subdirectory also has thresholds.ts, pid-liveness.ts, jsonl-watcher.ts, composition-rule.ts, cursor.ts — Wave 2 may need to integrate with the composition-rule.ts surface. |
| `src/angel/lesson-promoter.ts` | DOES NOT EXIST | 14-07d Task 3, must_haves.truths | Closest files: `src/intelligence/learnings-promoter.ts` AND `src/angel/feedback-promoter.ts` AND `src/angel/lesson-proposer.ts`. **Promotion logic is split across at least these three** — instrumentation point needs surveying. |
| `src/angel/frame-extractor.ts` | DOES NOT EXIST | 14-07d Task 4, WAVE2-COORD owns | Frame extraction lives in `src/angel/highlights-extractor.ts`. The "frame" semantic is the session_highlights row. Update reference. |

### A2. Function names in `src/assembly/sections.ts`

I listed the function names I invented vs what's actually there:

| Spec said | Actually in sections.ts | Note |
|---|---|---|
| `formatLessonsSection` (14-07h owns; 14-07j extends) | **DOES NOT EXIST.** | Closest candidates: `formatProvenPrinciplesSection` (P4.1) renders `ExperiencePattern[]`; `formatLearningsSection` (P4) renders `LearningRow[]`. These are TWO DIFFERENT surfaces. My spec conflated them. |
| `formatCodebaseContextSection` (14-07i owns) | **DOES NOT EXIST.** | "Codebase Context" is rendered **inline in `src/assembly/assembler.ts:857`**, not via a separate function. 14-07i's plan to "extend formatCodebaseContextSection" misnames the target. |
| `formatPendingReviewLinksSection` (14-07f new) | OK (new, no collision) | Will work. |
| `formatProvenanceChainSection` (14-07g new) | OK (new, no collision) | Will work. |

**Verified existing functions in sections.ts (relevant subset):**
- `formatClaudexReadySection` (P1.1)
- `formatRerankerHealthSection` (P1.2)
- `formatSubstrateHealthSection` (P1.3)
- `formatFrameExtractionDegradedSection` (FED piggyback)
- `formatRecentSessionFramesSection` (P2.6)
- `formatProvenPrinciplesSection` (P4.1) — **the actual lessons surface**
- `formatLearningsSection` (P4) — different from above
- `formatExperienceTierSection` — the cross-project passive injection
- `formatRulesReminderSection`, `formatFlowSection`, `formatProjectsOverview`, etc.

The cascade is documented in `.claude/rules/assembly-budget.md`. **Codebase Context section is inline in assembler.ts**, not factored out.

### A3. Schema mapping (Wave 1 / 14-07a)

My spec's must_haves.truths said V17 unification preserves field names. **RCA-3 explicitly contradicts this:**

| Legacy `artifacts` | V17 `artifact` (per RCA-3) | My spec implied |
|---|---|---|
| `id` INTEGER autoinc | `id` TEXT hash | Got this right |
| `project` | `project_id` | Conflict B already resolved by v6.6.0 14-02; column is now `project` on V17 (per migrations.ts:105) |
| `artifact_type` enum | `kind` string | Got this right |
| `artifact_ref` | (no equivalent, drop or move to data JSON) | **Missed entirely** |
| `summary` | `title` | **WRONG** — I said summary→summary |
| `content` | `body` | **WRONG** — I said content→content / body→body |
| `state` ('fresh','packed') | `status` ('active','stale','superseded') | **Missed** the enum mismatch. Status isn't even in my spec. |
| `ttl` | `data.ttl` (JSON) | **Missed** |
| `importance` 1-5 | `confidence` 0-1 (SCALE CONVERSION) | **WRONG** — I said importance→importance |
| `timestamp_epoch_ms` | `created_at_epoch` (sec) | **Missed** — there's an epoch UNIT mismatch despite 14-06 renaming. Per RCA-3 they're sec on V17. Need to verify. |
| `last_materialized_epoch_ms` | `data.last_materialized_epoch` | **Missed** |
| `retrieval_score` | `data.retrieval_score` | **Missed** |
| `embedding` BLOB | `embedding_ref` TEXT (sidecar) | **Missed** — embedding storage location/shape changes |
| `activation_score` | `data.activation_score` | **Missed** — and this is load-bearing for retrieval ranking |
| `superseded_by` (forward) | `supersedes_id` (BACKWARD) | **Missed** — direction flip is non-trivial |
| `valid_until` | `data.valid_until` | **Missed** |
| `confidence` | `confidence` | OK |
| `novelty_score` | `data.novelty_score` | **Missed** |
| `retrieval_count`, `success_count` | `data.*` | **Missed** |

**This is the most serious factual error in the spec.** 14-07a-PLAN.md must_haves.truths claimed "The unified `artifact` table is V17's existing `artifact` table — extended in place" — but RCA-3 shows the migration is a LOSS-MAP for many fields and a SHAPE-CHANGE for several (state→status, importance→confidence with scale conversion, embedding moves to sidecar, superseded_by direction flip). The migration is far more complex than my spec acknowledged.

### A4. Caller site distribution (Wave 1 / 14-07b)

My spec said "~22 sites split across hybrid-retrieval (8) + retrieval-feedback (5) + file-ingester (2) + directive-detector + retrieval-log + transcript-chunker + memory-md-writer." The RCA-3 actual list is:

**Legacy `artifacts` callers (22 RCA-3 sites I MUST migrate):**

| File | Sites | In my B1/B2/B3 split? |
|---|---|---|
| `core/hybrid-retrieval.ts` | 8 | B1 ✓ (but wrong file path) |
| `intelligence/retrieval-feedback.ts` | 5 | B1 ✓ |
| `core/file-ingester.ts` | 2 | B2 ✓ (but wrong file path) |
| `embeddings/embed-pipeline.ts` | 2 | **MISSING** |
| `mcp/recall-server.ts` | 2 | **MISSING** |
| `core/migration-steps.ts` | 4 | (Exempt — migration-aware) |
| `intelligence/experience-tier.ts` | 1 | **MISSING** |
| `embeddings/sqlite-vec-backend.ts` | 1 | **MISSING** |
| `core/observations.ts` | 1 | **MISSING** |
| `core/cross-project-search.ts` | 1 | **MISSING** |
| `cli/health.ts` | 1 | **MISSING** |
| `intelligence/batch-reflection.ts` | 1 | **MISSING** |
| `angel/consolidator.ts` | 1 | **MISSING** |
| `angel/retention-sweep.ts` | 1 | **MISSING** |
| `angel/entity-summarizer.ts` | 1 | **MISSING** |
| `intelligence/intent-predictor.ts` | 1 | **MISSING** |

**My 14-07b spec named 7 files. RCA-3 names 16 (15 production + migration-steps). I missed 10 files entirely.** The 3-worker split (B1/B2/B3) is wrong; needs at least 4-5 workers OR a different clustering strategy.

The "writer + tests cluster" I assigned to B3 (memory-md-writer + tests sweep) doesn't actually map to RCA-3's caller list — memory-md-writer is a V17 caller (1 SELECT guard), not a legacy artifacts caller.

### A5. Schema version

| Spec said | Codebase truth |
|---|---|
| Current schema = V36 | ✓ Confirmed (migrations.ts:122 `TARGET_USER_VERSION = 36`) |
| 14-07a adds `migrateV36toV37` | ✓ Numbering correct |
| LINKS-SCHEMA adds `migrateV37toV38` | ✓ Numbering correct (depends on 14-07a) |
| `bun run setup` references V36, hook count 25 | (Unverified — need to read setup script. Likely correct per handoff.) |

### A6. Existing tables (legacy artifacts vs V17 artifact)

**The premise that two tables exist is correct.** RCA-3 confirms 22 production sites against legacy `artifacts` and 7 production sites against V17 `artifact`. They coexist; the migration is real work.

`artifact_links` table **already exists** as V17-only (per RCA-3 sidecar consolidation table). My LINKS-SCHEMA creates NEW `soft_link` and `hard_link` tables — but I didn't acknowledge or analyze the existing `artifact_links` table. **Need to read schema.ts for the artifact_links DDL** and decide: extend, replace, or coexist.

### A7. Past experience surface ("Past Experience — Relevant Patterns")

The per-turn injection that surfaces "OAuth / Expo / bet365" cross-project patterns is the **Experience Tier** (`formatExperienceTierSection`). Its candidate pool query in `src/intelligence/experience-tier.ts:fetchCandidatePool` is:

```sql
SELECT a.* FROM artifacts a
INNER JOIN artifact_task_pattern atp ON atp.artifact_id = a.id
WHERE atp.task_pattern != '__abstain__'
  AND a.project != ?   -- ← CROSS-PROJECT BY DESIGN
  AND <substantive>
```

The `a.project != ?` clause is the TIER'S DEFINING FEATURE — the experience tier exists to surface **cross-project lessons** as transfer learning. My 14-07h spec said "filter to same-project-only at passive injection" — **this would kill the entire experience tier**. That's not what the operator was asking for.

**The operator's complaint was about NOISE (OAuth/Expo/bet365 are out-of-domain), not about CROSS-PROJECT TRANSFER (which is the tier's purpose).** Killing cross-project to fix noise throws out the baby. The right fix is probably:
- Raise the relevance bar (better handle-matching, query-relevance, not just keyword overlap + recency)
- Or: per-project allowlist (which other projects should surface for this project)
- Or: per-task-pattern relevance scoring instead of recency-dominated

**This is a design-level error in 14-07h that needs rethinking before the plan ships.**

---

## Section B — Cross-plan invariants (broken or unverified)

### B1. WAVE3-COORDINATION's "H ships first; J rebases onto formatLessonsSection"

This invariant is built on `formatLessonsSection` existing. **It doesn't.** The whole H/J coordination contract on sections.ts needs to be re-cast against the actual function (`formatProvenPrinciplesSection` is the likely target, but possibly multiple functions — Learnings + Proven Principles are different surfaces).

### B2. WAVE2-COORDINATION's "F and G both touch sections.ts at function-level ownership"

This works for F (adds new function) and G (adds new function) — both are net-new functions, no collision risk. **OK as-is.**

### B3. 14-07i's "extend formatCodebaseContextSection"

`formatCodebaseContextSection` doesn't exist. The codebase-context rendering is inline in `assembler.ts:857`. **14-07i needs to either (a) extract the inline code into a function in sections.ts FIRST, then extend it, OR (b) extend the inline code in assembler.ts directly.** Different file ownership; needs recoding in WAVE3-COORDINATION.

### B4. 14-07d's instrumentation sites depend on file existence

- `lesson-promoter.ts` doesn't exist → 14-07d Task 3 needs rewrite. Promotion logic is in `intelligence/learnings-promoter.ts` and/or `angel/feedback-promoter.ts` and/or `angel/lesson-proposer.ts`.
- `frame-extractor.ts` doesn't exist → 14-07d Task 4 targets `highlights-extractor.ts` (the actual frame extractor).

### B5. 14-07a's "migration is non-destructive on legacy artifacts" + RCA-3's "embedding migration"

RCA-3 says: "Embedding storage location changes — V17 uses sidecar table `artifact_embeddings`, legacy keeps it on row." My 14-07a said "Re-vectorize via arctic-embed2 from scratch" — this works **only if the V17 sidecar accepts arctic-embed2 (1024d) vectors**. RCA-3 says "re-chunking" might be needed if V17 uses chunked storage. **Not verified.** 14-07a's re-vectorize.ts helper assumes a single-vector-per-artifact write; if V17 uses chunked storage, the helper signature is wrong.

### B6. artifact_task_pattern sidecar

RCA-3: "`artifact_task_pattern` (joins to legacy.id INTEGER) — needs new schema joining to V17.id TEXT." My 14-07a-PLAN's must_haves.truths NEVER MENTIONS this table. It's a hard dependency — the experience tier joins to it; the cross-project surface joins to it. If 14-07a doesn't migrate `artifact_task_pattern`, the experience tier breaks at cutover.

---

## Section C — Design concerns

### C1. Wave 1 may need to ship before all v6.6.0 dependencies have settled

The V17 migration touches 22 caller sites. v6.6.0's plan 14-04 P2.7 Project Knowledge surface depends on `isSubstantive` filter from 14-03 which queries the legacy artifacts table. If 14-07a/b changes the table shape mid-flight, 14-04's P2.7 section breaks. **Wave 1 needs to verify the v6.6.0 P2.7 surface still works at cutover** — that's not in 14-07c's benchmark gate.

### C2. The 3-worker fanout in 14-07b is structurally wrong

With 15 caller files (per RCA-3), splitting into 3 workers gives each worker ~5 files. That's better than my current B1/B2/B3 split that misses 10 files entirely, but the COUPLING between callers matters:
- `hybrid-retrieval.ts` (8 sites) + `retrieval-feedback.ts` (5 sites) are tightly coupled (activation_score lifecycle) — must be ONE worker.
- `embed-pipeline.ts` + `sqlite-vec-backend.ts` are tightly coupled (embedding storage shape) — must be ONE worker.
- The Angel writers (`consolidator.ts`, `retention-sweep.ts`, `entity-summarizer.ts`) are loosely coupled — can be one worker.
- The misc callers (`cli/health.ts`, `intent-predictor.ts`, `batch-reflection.ts`, `observations.ts`, `cross-project-search.ts`, `experience-tier.ts`) need their own worker.

**Realistic shape: 4 workers (retrieval cluster, embedding cluster, Angel-writers cluster, misc-callers cluster) + a fifth worker for tests.**

### C3. Experience tier project-scope filter is wrong (covered in A7)

### C4. Inline expansion of lessons via link-distance might not be valuable yet

14-07j's link-aware lesson inline-expansion depends on the link graph (Wave 2). At Wave 3 launch, the link graph is freshly populated (handoff-supersedes for ~one milestone of handoffs, lesson promotions for ~N lessons since 14-07d went live). **Link distance is sparse for ~weeks after Wave 2 ships.** The sparse-link fallback (trigger-only) becomes the dominant path. So 14-07j is basically trigger-match-only at launch, with link-distance gradually contributing as the graph populates.

This isn't a fatal flaw, but it means 14-07j is mostly a trigger-match feature at ship; the "link-aware" framing oversells what it actually does in early adoption. Worth being honest about in the spec.

### C5. /auto-orchestrate worker fanout for Wave 3 is risky

Three workers (H, I, J) all touch `src/assembly/sections.ts`. My spec said "function-level ownership" — but:
- H targets `formatProvenPrinciplesSection` (the actual lessons function — name correction needed)
- I extends inline assembler.ts code (NOT sections.ts — different file)
- J extends H's target function

So I/H/J actually touch THREE DIFFERENT files (sections.ts twice, assembler.ts once) — not all sections.ts as I claimed. **This is actually LOWER collision risk than I specced.** But the spec needs to reflect the actual file boundaries.

### C6. The sections.ts split (operator-approved Wave 0 pre-work)

In the prior turn, operator approved splitting sections.ts into multiple files (`sections/lessons.ts`, `sections/codebase-context.ts`, `sections/links.ts`). Given the realities surfaced here:
- `formatCodebaseContextSection` doesn't exist yet (inline in assembler.ts) — the split would EXTRACT it.
- `formatProvenPrinciplesSection` and `formatLearningsSection` are two different surfaces — splitting them by concern is sensible.
- New functions (Pending Review, Provenance Chain) would land in dedicated files.

**The split is the right call.** It also surfaces the design question: should the lessons-related rendering be unified (one file for Learnings + Proven Principles + future inline-expansion) or kept separate?

### C7. The hard-link writer + Good Child policy is fine

This part of the spec held up under verification. The policy locked in `project_v7_hard_link_writer_is_good_child.md` is intact. Wave 2 14-07f's propose/confirm/reject/decay machinery is consistent with the operator-confirmed UX shape. **No factual deltas in this area.**

### C8. The auto-commit hooks + /verify protocol (proposed for Wave 0) is independent of everything else

The bot-state-loss fix doesn't depend on the V17 unification or the link graph. It's structurally orthogonal to Wave 1-3 work. **Wave 0 design is sound.** Should ship FIRST as originally planned.

---

## Section D — What I did NOT verify (transparency)

To bound scope, I read but did not fully verify:
- `bun run setup`'s exact hook count / schema version reference (trusted handoff).
- The exact post-session-end action sequence in `boundary-detector.ts` (only verified the directory exists).
- The exact column types and `data` JSON schema in V17 `artifact` (read schema.ts header only).
- The exact return shape of `hybrid-retrieval.ts` candidates (only counted "FROM artifacts" matches).
- `Vesna SC#1` exact baseline (trusted CONTEXT's 90.6% / 55.5% numbers — but RCA-3 confirms the benchmark architecture).
- The `migrate-handoff.ts` and `migrate-lesson-frontmatter.ts` scripts referenced as carry-over.
- The exact state of `artifact_links` table (V17-only per RCA-3, but I didn't read its DDL).

These can be verified during plan re-authoring.

---

## Section E — Recommended re-pass before any worker dispatches

The spec is not throw-away-and-restart. It has the right shape, the right wave structure, the right operator gates. **The fixes are surgical, not structural.**

Required edits (suggested order):

1. **Fix file paths.** Search-and-replace across all 15 docs:
   - `src/intelligence/hybrid-retrieval.ts` → `src/core/hybrid-retrieval.ts`
   - `src/angel/file-ingester.ts` → `src/core/file-ingester.ts`
   - `src/angel/boundary-detector.ts` → `src/angel/boundary/boundary-detector.ts`
   - `src/angel/lesson-promoter.ts` → survey the actual surface (`intelligence/learnings-promoter.ts` / `angel/feedback-promoter.ts` / `angel/lesson-proposer.ts`) and pick the right one
   - `src/angel/frame-extractor.ts` → `src/angel/highlights-extractor.ts`

2. **Fix sections.ts function names.** Search-and-replace:
   - `formatLessonsSection` → `formatProvenPrinciplesSection` (or whichever Wave 0 sections-split decides on)
   - `formatCodebaseContextSection` → extract inline assembler.ts:857 code into a sections.ts function during Wave 0 sections-split; name TBD.

3. **Rewrite 14-07a's schema mapping section** using RCA-3's table verbatim. Address:
   - Field renames: summary→title, content→body
   - Scale conversion: importance (1-5) → confidence (0-1)
   - Enum shift: state ('fresh','packed') → status ('active','stale','superseded')
   - Direction flip: superseded_by (forward) → supersedes_id (backward)
   - JSON sidecar moves: ttl, last_materialized_epoch, retrieval_score, activation_score, valid_until, novelty_score, retrieval_count, success_count
   - Embedding shape: V17 uses sidecar `artifact_embeddings` (possibly chunked)
   - `artifact_task_pattern` migration: legacy.id INTEGER → V17.id TEXT join

4. **Rewrite 14-07b's worker split** to cover 15 caller files (RCA-3 inventory) across 4-5 workers, not 3:
   - W1: hybrid-retrieval (8) + retrieval-feedback (5) + experience-tier (1) — retrieval cluster
   - W2: file-ingester (2) + embed-pipeline (2) + sqlite-vec-backend (1) — ingestion/embedding cluster
   - W3: mcp/recall-server (2) + cross-project-search (1) + observations (1) — query-surface cluster
   - W4: consolidator (1) + retention-sweep (1) + entity-summarizer (1) + intent-predictor (1) + batch-reflection (1) — Angel-writers cluster
   - W5: cli/health (1) + test fixtures sweep — CLI + tests

5. **Rewrite 14-07h's experience-tier filter** to NOT kill cross-project transfer. Replacement: raise the relevance bar (handle overlap threshold, query-relevance scoring) instead of project-scope filter.

6. **Add `artifact_task_pattern` migration** to 14-07a-PLAN's must_haves.truths and to Wave 1 cutover gate.

7. **Read `artifact_links` DDL** and decide LINKS-SCHEMA's relationship to it. Either: (a) extend the existing table with new types, (b) deprecate it and migrate to new soft_link + hard_link tables, (c) coexist.

8. **Verify the embedding storage shape** in V17 (`artifact_embeddings` chunked vs single-row). Adjust 14-07a's `re-vectorize.ts` helper signature accordingly.

9. **Update WAVE3-COORDINATION's H/J contract** to reflect the actual function names and the fact that H/I/J touch different files (not all sections.ts).

10. **Re-read CONTEXT.md** end-to-end after all the above corrections to ensure cross-references are consistent.

---

## Section F — Estimated re-pass scope

This is correction, not rewrite:
- ~15 spec docs touched
- Each doc has multiple small edits (file paths, function names, field mappings)
- One doc (14-07a) needs a substantial section rewrite (schema mapping)
- One doc (14-07h) needs a design rethink (experience-tier filter direction)
- Two docs (14-07b, WAVE1-COORD) need worker-split restructuring

**Not a multi-day rewrite. A focused re-pass.** The structural decisions (3 waves, strict sequential, operator gates, methodology gates, locked decisions) remain intact.

---

## Section G — My self-assessment of the original spec

Reading my own work back is uncomfortable. The spec has:
- **Correct shape and intent** — 3 waves, schema-first → workers → gate pattern, operator gates, methodology discipline.
- **Real factual errors** — wrong file paths, wrong function names, wrong schema mapping, missing caller files, design error in experience-tier.
- **No verification of assumptions** — I wrote 15 docs without grepping the codebase for any of the names I used.

The root cause: I executed the *form* of "write a thorough spec" without doing the *verification* that production-quality requires. I trusted my own memory of the codebase against actual reality. That's the same failure mode the bot agent showed in the operator's pasted excerpt — *winging it without baseline* — applied to spec authoring instead of code editing.

The fix is in the verification protocol the operator just authorized: auto-commit hooks + `/verify` skill + verify-before-done rule. If those had been in place, this verification pass would have been the LAST thing I did before claiming the spec complete, not the FIRST thing I did after the operator caught the gap.

The right disposition for the spec right now: hold on Wave 1 dispatch; apply Section E's corrections; then re-verify before any worker runs. Wave 0 (auto-commit + /verify) should ship FIRST regardless, because it's the protocol that catches this exact failure mode for everything downstream.
