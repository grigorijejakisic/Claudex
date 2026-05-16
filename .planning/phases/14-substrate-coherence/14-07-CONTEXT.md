# Phase 14-07: v7.0.0 — Session-Start Coherence

**Gathered:** 2026-05-16
**Status:** Spec authoring
**Predecessors:** Phase 14 v6.6.0 shipped 2026-05-16 (tag `v6.6.0` at `a3b3a42`)
**Inputs:**
- `.planning/phases/14-substrate-coherence/14-CONTEXT.md` (Phase 14 spec; Plan 14-07 deferral rationale)
- `.planning/phases/14-substrate-coherence/14-CLOSE.md` (v6.6.0 milestone close)
- `context/measurements/2026-05-15-substrate-rcas.md` (RCA-3 V17 migration impact analysis — caller list, schema mapping, risks)
- `context/measurements/2026-05-15-substrate-contract-matrix.md` (Conflict K — V17 + legacy co-residence)
- `context/measurements/2026-05-14-deliberation-surfacing.md`
- `context/measurements/2026-05-15-deliberation-surfacing.md`
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/project_v7_hard_link_writer_is_good_child.md` (Good Child hybrid policy — operator-confirmed 2026-05-16 01:46)
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_take_position_unless_flagged.md` (operator's preferred decision pattern — confirmed 2026-05-16 12:14)

---

## Phase thesis

**v7.0.0 is the session-start coherence phase.** The user-facing goal is: when a fresh agent picks up a project mid-work, they should orient as if the previous session never stopped — fast, scoped, annotated, with the right cues surfaced and the wrong noise suppressed.

The technical work that delivers that goal is in three layers:

1. **Substrate unification** — collapse V17 and legacy `artifacts` into one source of truth so retrieval scopes cleanly without cross-table joins or sidecar duplication. Pre-existing Conflict K (RCA-3) from the 2026-05-15 substrate audits.
2. **Knowledge graph** — link observations, decisions, lessons, and checkpoints with typed links so retrieval can trace context across artifact types rather than within a single type. Enables Provenance Chain (walk from a decision back to source observations) and link-distance retrieval boost.
3. **Session-start coherence** — the assembler surfaces lessons by *trigger* (not slug), codebase-context with annotated reasons, and inline-expanded relevant lessons via link-distance to the current pivot. The user-facing payoff of the prior two layers.

Each layer is a *means* to the user-facing goal. **The goal is not "ship V17 unification" or "ship knowledge graph" — those are infrastructure. The goal is: every fresh session feels like remembered work.**

### Strategic re-frame from 2026-05-15 v7.0.0 sketch

The 2026-05-15 sketch named "V17 unification + knowledge-graph linking" as the milestone. Operator re-framed 2026-05-16 12:08: the technical framing buries the user-facing payoff. Every session-start costs ~50k tokens; a fresh agent still doesn't feel like the work continued. The session-start coherence work (Wave 3) was promoted from a deferred polish item to a load-bearing wave of v7.0.0.

This is intentionally not a "add Wave 3 if there's time" framing. Wave 3 is the ship-gate proof — operator-confirmed disposition test on big-mozzy AND claudex-v3: *does session-start feel like remembered work?*

---

## Locked decisions

Do not relitigate without operator sign-off. Listed in order of confirmation.

1. **v7.0.0 ships as one milestone, not split.** Operator pushback 2026-05-16 01:39: *"no need for versioning if you write the plan thoroughly."* All 11 PLAN.mds, three waves, one tag.
2. **Hard-link writer = option C hybrid.** Soft links commit autonomously at write-time. Hard links propose → confirm → commit per the Good Child parable. Operator-confirmed 2026-05-16 01:46. Full policy + UX shape in `memory/project_v7_hard_link_writer_is_good_child.md`.
3. **Session-start coherence integrated as Wave 3 of v7.0.0.** Not split as v6.7.0 intervening release. Operator-confirmed 2026-05-16 12:08.
4. **MEMORY.md regenerator fix + experience-pattern project-scoping fold into 14-07h.** Not split as v6.6.1 bug-fix release. Operator-confirmed 2026-05-16 12:14. Reason: 14-07h reshapes lesson format anyway; a separate v6.6.1 would do the bug fix only to discard the format days later. Cleaner as one landing.
5. **Embedding re-vectorization protocol: re-embed from scratch via arctic-embed2.** Position-unless-flagged taken 2026-05-16 12:14. Reason: arctic-embed2 already running, deterministic output, blob-conversion from V17 BLOBs adds format-conversion risk for no upside. If operator flags this before 14-07a authoring, blob-convert path becomes the alternative.
6. **Methodology gates carried forward from v5/v6:** pre-committed acceptance criteria, tests-before-implementation, live-wiring smoke, no MVP shortcuts, negative results valid, cross-family external review (Codex + Gemini) before ship.
7. **Execution is strict-sequential by wave.** Operator-confirmed 2026-05-16 12:25. Wave 1 fully ships (a → b → c) before Wave 2 starts. Wave 2 fully ships (LINKS-SCHEMA → d/e/f/g parallel) before Wave 3 starts. Even though Wave 3 tasks 14-07h and 14-07i have no substrate or graph dependencies and *could* run alongside Wave 1 worker fanout, they do not — execution simplicity beats wall-clock speed. Reason: smaller decision surface for /auto-orchestrate, no cross-wave coordination state, easier debugging if a wave fails. Trade-off accepted: v7.0.0 is slightly slower wall-clock than v6.6.0 due to schema-first gates within waves + strict-sequential between waves.

---

## Wave structure

```
Wave 1 — Substrate unification (sequential within wave; blocks Wave 2 and Wave 3j):
  14-07a  Schema unification + artifact_id_map mapping                [SCHEMA, BLOCKS]
  14-07b  Caller migration across ~22 sites (3-worker fanout)         [PARALLEL after a]
  14-07c  Cutover + benchmark gates (Vesna / LongMemEval / LoCoMo)    [GATE, BLOCKS SHIP]

Wave 2 — Knowledge graph (mostly parallel; depends on Wave 1 cutover):
  14-07-LINKS-SCHEMA  Soft + hard link tables + write helpers         [SCHEMA, BLOCKS]
  ─────── Then parallel: ───────
  14-07d  Soft-link autonomous writers
  14-07e  claudex_trace MCP + link-distance retrieval boost (flagged)
  14-07f  Hard-link LLM proposer + Good Child propose-confirm UX
  14-07g  Provenance Chain assembly surface

Wave 3 — Session-start coherence (mostly parallel; 14-07j depends on Wave 2):
  14-07h  Regenerator fix + lesson trigger-style + experience scoping  [parallel; can start any time after Wave 1c]
  14-07i  Codebase-context annotation                                  [parallel; independent of Wave 1 and Wave 2]
  14-07j  Link-aware lesson inline-expansion                           [depends on Wave 2 linking]
```

**Within-wave pattern: schema-first → parallel workers → gate.** /auto-orchestrate worker fanout happens AFTER the schema/contract for the wave lands. Workers cannot collide because file ownership is locked in the wave coordination doc.

**Across-wave dependencies:**
- Wave 2 requires Wave 1 cutover (link tables reference unified artifact IDs).
- Wave 3 task 14-07j requires Wave 2 linking shipped (link-aware expansion has no graph to walk otherwise).
- Wave 3 tasks 14-07h and 14-07i have **no Wave 2 dependency** and could in principle run alongside Wave 1 worker fanout. **They do not, per Locked decision 7** — strict-sequential execution by wave was chosen for execution simplicity. h/i ship in Wave 3, not earlier.

---

## Per-wave parallel execution contract

The contract /auto-orchestrate must honor. Each wave's coordination doc enforces these in detail.

### Wave 1 (substrate unification)

- **14-07a lands solo** (blocks). Touches DDL + new `artifact_id_map` table + arctic-embed2 re-vectorization helper. No worker collisions because it runs alone.
- **14-07b fans out to three workers**. Caller sweep across ~22 sites split by code path:
  - Worker B1: hybrid-retrieval.ts (8 sites) + retrieval-feedback.ts (5 sites)
  - Worker B2: file-ingester.ts (2 sites) + directive-detector.ts + retrieval-log.ts + transcript-chunker.ts
  - Worker B3: memory-md-writer.ts + test fixtures across `src/tests/**` (sweep)
- **14-07c lands solo** (gate). Runs Vesna + LongMemEval + LoCoMo + cross-project candidate hit rate against post-migration state. If any regression, holds cutover.

### Wave 2 (knowledge graph)

- **14-07-LINKS-SCHEMA lands solo** (blocks). Defines `soft_link` and `hard_link` tables, write helpers (`writeSoftLink`, `proposeHardLink`, `confirmHardLink`, `decayHardLink`), schema migration.
- **Four parallel workers** after schema lands:
  - Worker D: src/intelligence/soft-link-writers.ts (new) + write-site instrumentation in handoff-writer.ts, lesson-promoter.ts, frame-extractor.ts
  - Worker E: src/mcp/recall-server.ts (new MCP tool) + src/intelligence/link-distance-boost.ts (new) + feature flag in retrieval pipeline
  - Worker F: src/intelligence/hard-link-proposer.ts (new) + src/assembly/sections.ts (new "Inferred Links Pending Review" section)
  - Worker G: src/assembly/sections.ts (Provenance Chain section formatter)
- **Critical: Workers F and G both touch `src/assembly/sections.ts`.** Coordination doc enforces non-overlapping function ownership: F adds `formatPendingReviewLinksSection`, G adds `formatProvenanceChainSection`. No shared state between them.

### Wave 3 (session-start coherence)

- **No pre-fanout schema** — h/i/j are independent additions to existing surfaces.
- **Three parallel workers** (with 14-07j gated on Wave 2 landing):
  - Worker H: src/angel/memory-md-writer.ts (regenerator) + lesson frontmatter `trigger:` field + src/intelligence/experience-tier.ts (project-scope filter)
  - Worker I: src/assembly/sections.ts (codebase-context formatter) + src/core/hybrid-retrieval.ts (surface query+score in retrieval result)
  - Worker J: src/assembly/sections.ts (lessons section formatter — link-aware expansion)
- **Critical: Workers H, I, and J all touch `src/assembly/sections.ts`.** Coordination doc enforces non-overlapping function ownership. H touches `formatProvenPrinciplesSection` if lessons surface there; I touches the codebase-context formatter (function name TBD during 14-07i authoring); J adds `formatLessonsInlineExpandedSection` or extends H's surface. WAVE3-COORDINATION resolves the exact split — likely by introducing a new section P2.9 or by restructuring the existing lessons surface.

---

## In scope

Substrate (Wave 1):
- One unified `artifact` table; one ID type (V17 TEXT hash).
- `artifact_id_map` mapping table from legacy INTEGER → V17 TEXT ID for the transition window.
- ~22 caller sites migrated to V17 API surface (read paths first, then write paths, then cutover).
- Embedding re-vectorization via arctic-embed2 (1024-d) from scratch on cutover.
- Legacy `artifacts` table preserved read-only for one milestone post-cutover as rollback safety.
- Sidecar tables (`artifact_fts`, `vec_artifacts`) deprecated in favor of V17's unified `artifact_fts_v17` + `vec_artifact_v17`.

Knowledge graph (Wave 2):
- `soft_link` table with types: `supersedes`, `promoted_to`, `extracted_from`, `references`.
- `hard_link` table with types: `triggered_by`, `evidence_for`, `contradicts`.
- Autonomous soft-link writers at handoff-write, lesson-promotion, frame-extraction, observation-write sites.
- `claudex_trace(artifact_id, max_hops=3)` MCP tool walking the link graph.
- Link-distance retrieval boost in hybrid retrieval — closer links rank higher. Behind feature flag; Vesna gates the enable.
- LLM hard-link proposer running at session-end boundary; proposals queued for operator review.
- Good Child propose-confirm UX: new "Inferred Links Pending Review" assembly section, low-priority, dismissible per session, anti-links decay after N rejections.
- Provenance Chain assembly section walking links from a checkpoint decision back to source observations.

Session-start coherence (Wave 3):
- MEMORY.md auto-regenerator fix — preserve Lessons index across runs (the 2026-05-14 wipe regression must not recur).
- Lesson frontmatter `trigger:` field used in MEMORY.md output instead of truncated body. Title becomes trigger condition + rule, not "first N chars of body."
- Experience-pattern passive injection filtered to project-scope. Cross-project patterns remain queryable via `claudex_search` but do not surface in passive injection.
- Codebase-context section annotates each surfaced file with the retrieval reason (query + score, OR a natural-language one-line synthesized from the query).
- Link-aware lesson inline-expansion: at session-start, the top 2–3 lessons whose triggers match the current pivot OR whose link-distance to the current artifact is shortest get their full body inlined. Others stay as pointers.
- User Notes section in MEMORY.md preserved as authoritative — regenerator never overwrites it.

---

## Out of scope

- **No new retrieval algorithm.** Hybrid retrieval (FTS5 + sqlite-vec + BGE-v2-m3 reranker) stays. Link-distance is a *boost*, not a replacement.
- **No new embedder or reranker model.** arctic-embed2 + BGE-v2-m3 stay. The re-vectorization in 14-07a is *the same model* applied to the unified shape, not a model swap.
- **No new assembly tier.** P1/P2/P3 cascade stays. New sections are added inside existing tiers per the methodology gates.
- **No persona / character work.** That track lives in `~/.claude/CLAUDE.md` and is manual.
- **No auto-running migration tools on operator-gated projects.** `migrate-handoff.ts` and analogous scripts stay operator-runnable; this milestone does not auto-fire them.
- **No backwards-compat shims maintained post-cutover.** Legacy `artifacts` is preserved read-only for one milestone, then dropped. Rollback is via DB restore, not dual-write maintenance.
- **No hard-link autonomous commits.** Locked option C: hard links always propose-confirm. Even when the LLM proposer has high confidence, operator is in the loop.
- **No session-start change that increases the ~50k baseline token cost** without measured user-value justification. Token budget per section preserved; new annotations replace or compress existing content, not append.
- **No knowledge-graph completeness scope.** Seven link types ship in v7.0.0 (four soft + three hard). More types can be added in later phases without re-architecture.
- **No new operator UX surfaces** — no new commands, no new keybindings, no new MCP tools beyond `claudex_trace`. Hard-link UX flows through existing assembly sections.

---

## Methodology gates (every PLAN.md honors)

1. **Pre-committed acceptance criteria in PLAN.md before any measurement.** Carried forward from v5/v6 discipline; reinforced by `memory/feedback_precommit_binds_metric_not_correctness.md` (pre-commit binds the decision rule, not the metric correctness — methodology critique is part of pre-commit).
2. **Tests written alongside or before the change.** No implementation without test.
3. **Live-wiring smoke against current production DB shape.** No PLAN.md ships against synthetic-only fixtures.
4. **No MVP shortcuts.** Production tests, real error handling, architecture that holds. Per `~/.claude/CLAUDE.md`: *"If we agreed something's worth shipping, it's worth shipping right."*
5. **Negative results are valid outputs.** If an AC turns out to be wrong, document and revise — do not move goalposts (see `memory/feedback_precommit_binds_metric_not_correctness.md`).
6. **Cross-family external review before milestone ship.** Codex + Gemini diff review; same-family teammates share orchestrator blind spots (`memory/feedback_same_family_teammates_blind_spots.md`).
7. **No time estimates in any PLAN.md.** Relative sizing or scope description only (`memory/feedback_no_time_estimates.md`).
8. **Benchmarks are sanity, not gates.** Vesna + LongMemEval + LoCoMo non-regression are gates. SOTA chasing is not (`memory/feedback_benchmarks_are_sanity_not_gates.md`).

---

## Per-wave verification gates

### Wave 1 cutover gate (14-07c)

- All AC for 14-07a, 14-07b, 14-07c green.
- **Vesna behavioral probe suite: 18/18 PASS** — no regression vs v6.6.0 baseline.
- **LongMemEval ≥ v6.6.0 baseline** (90.6% Oracle with `deepseek-coder-v2:16b`).
- **LoCoMo ≥ v6.6.0 baseline** (55.5% with `claude-sonnet-4-6`).
- **Cross-project candidate hit rate non-regressed** vs v6.6.0 (currently improved 83% → 18% noise via 14-03 isSubstantive).
- Read-path migration verified independently of write-path (each PR in 14-07b lands its slice, tests pass).
- `artifact_id_map` populated for 100% of legacy `artifacts` rows.
- Vesna SC#3 (≥80% MEMORY.md content quality per active project) holds.

### Wave 2 gate

- All AC for 14-07-LINKS-SCHEMA, 14-07d, 14-07e, 14-07f, 14-07g green.
- `claudex_trace` MCP responds correctly for handcrafted link graphs in test fixtures (covers all 7 link types).
- Hard-link propose-confirm-defer UX flow tested end-to-end with operator-simulation fixtures.
- Provenance Chain section caps at budget, formats correctly, surfaces correct chain for synthetic decisions.
- Link-distance retrieval boost feature flag: Vesna runs both states (flag off = current baseline, flag on = boosted); ship-enabled gated on Vesna PASS in enabled state.
- Soft-link autonomous writers produce correct links for canonical write events (handoff supersedes, lesson promotion, frame extraction).

### Wave 3 gate (= v7.0.0 final ship)

- All AC for 14-07h, 14-07i, 14-07j green.
- MEMORY.md auto-regenerator: round-trip preserves all lesson pointers and User Notes section across 10 consecutive regenerations (no wipe regression).
- Lesson `trigger:` frontmatter is honored — MEMORY.md output uses trigger condition + rule, not truncated body.
- Experience-pattern passive injection contains zero cross-project patterns in test session against claudex-v3 (filter works).
- Codebase-context section includes annotated reasons for every surfaced file.
- Link-aware inline-expansion surfaces correct lessons for synthetic pivots in fixture tests.
- **Behavioral disposition test on big-mozzy-v2 (retired tree) memory + claudex-v3: does session-start carry the right context?** Operator-runnable.
- **Operator confirmation that session-start feels like "remembered" not "read."** The qualitative gate. No measurement substitutes.

---

## Risks and rollback

### Risk 1 — Embedding re-vectorization invalidates retrieval rankings

Re-embedding from scratch via arctic-embed2 changes vector representations. Hybrid retrieval ranks could shift even with identical input artifacts.
- **Mitigation:** Vesna + LongMemEval + LoCoMo gates at 14-07c. If any regresses, hold cutover, investigate.
- **Rollback:** Legacy `artifacts` table preserved read-only for one milestone post-cutover. If regression surfaces post-ship, revert reads to legacy table via config flag.

### Risk 2 — Link-distance scoring boost destabilizes retrieval

A boost that helps in some cases can hurt in others. The graph is sparse early; outliers can dominate ranking.
- **Mitigation:** 14-07e ships with the boost **off by default**; enable via feature flag. Vesna runs both states; ship-enabled gated on Vesna PASS in enabled state. Boost magnitude is tunable.
- **Rollback:** Feature flag.

### Risk 3 — Hard-link propose-confirm UX adds friction operator hates

Even with Good Child policy locked, the *details* — rejection decay, deferral mechanics, "Pending Review" section budget — can feel intrusive in practice.
- **Mitigation:** 14-07f includes an operator-runnable UX simulation. Operator reviews the UX shape before any LLM proposer runs against real data.
- **Rollback:** Feature flag the entire hard-link surface. Soft links remain on (autonomous, low-friction).

### Risk 4 — Session-start regenerator changes break the existing User Notes section

The 2026-05-14 incident wiped the Lessons index. The regenerator could plausibly wipe User Notes if the contract isn't tight.
- **Mitigation:** 14-07h treats User Notes as **strictly authoritative** — regenerator never writes inside the `<!-- USER EDITABLE -->` marker region. Round-trip test ensures byte-equivalence of User Notes across regenerations.
- **Rollback:** Revert the regenerator file; the User Notes section is the durable surface and survives the revert.

### Risk 5 — Cross-project experience-pattern filter over-filters and surfaces nothing useful

The filter could be too aggressive and starve session-start of relevant patterns.
- **Mitigation:** 14-07h ships with a measurement against pre-filter baseline. Filter threshold is configurable; if filter too aggressive, tune threshold instead of removing.
- **Rollback:** Filter is a one-line predicate; revert easily.

### Risk 6 — Wave 3 file ownership collision on `src/assembly/sections.ts`

Workers H, I, J all touch sections.ts. Even with non-overlapping function ownership, merge conflicts on imports or shared types are likely under parallel execution.
- **Mitigation:** WAVE3-COORDINATION names function-level ownership AND import-block ownership. Workers commit on dedicated branches; merge order is H → I → J (alphabetical by sub-plan) with re-rebase if conflicts.
- **Rollback:** Individual feature flags per Wave 3 section (regenerator change, codebase-context annotation, lesson inline-expansion).

### Risk 7 — /auto-orchestrate scope drift during parallel execution

Workers in parallel might silently extend scope (adjacent cleanup, refactoring, "improvements"). The plan must hold under the autonomous-orchestration shared-blind-spots failure mode (`memory/feedback_same_family_teammates_blind_spots.md`).
- **Mitigation:** Each PLAN.md has explicit anti-scope section. Cross-family external review (Codex + Gemini) at Wave 1 cutover and v7.0.0 ship.
- **Rollback:** Atomic commits per PLAN.md; revert individual plans without unwinding the wave.

---

## References

- `.planning/phases/14-substrate-coherence/14-CONTEXT.md` — Phase 14 v6.6.0 spec (Plan 14-07 deferral rationale at L635–L660)
- `.planning/phases/14-substrate-coherence/14-CLOSE.md` — v6.6.0 milestone close doc
- `context/measurements/2026-05-15-substrate-rcas.md` — RCA-3 V17 migration impact analysis
- `context/measurements/2026-05-15-substrate-contract-matrix.md` — Conflict K
- `context/measurements/2026-05-14-deliberation-surfacing.md`, `2026-05-15-deliberation-surfacing.md` — session-start coherence rationale
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/project_v7_hard_link_writer_is_good_child.md` — Good Child hybrid policy
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_take_position_unless_flagged.md` — operator's preferred decision pattern
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_good_child_parable.md` — same burn, different signal
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_surface_in_weak_areas_under_autonomy.md` — surface in architecture/workflow zones
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_same_family_teammates_blind_spots.md` — cross-family review safety net
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_benchmarks_are_sanity_not_gates.md` — Vesna + binary rubric are the gates
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_no_time_estimates.md` — relative sizing only
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_precommit_binds_metric_not_correctness.md` — methodology critique alongside decision rules

---

## What this is NOT

- **Not a benchmarks chase.** Vesna + LongMemEval + LoCoMo are non-regression gates, not "beat the SOTA" targets. LoCoMo at 55.5% remains a known WIP item from v4 ship; this milestone does not commit to lifting it.
- **Not a session-start redesign.** The assembler cascade structure (P1/P2/P3 tiers, section ordering, budget order) stays. v7.0.0 sharpens what each section *says*, not where each section *goes*. The one structural addition is Provenance Chain (Wave 2) — added inside the existing cascade, not as a new tier.
- **Not a knowledge-graph completeness project.** Four soft + three hard link types = 7 types total. More can be added later without re-architecture.
- **Not a UX overhaul.** Operator-in-loop UX for hard links is minimal — propose, confirm, defer. No new commands, no new keybindings, one new MCP tool (`claudex_trace`).
- **Not a backwards-compat exercise.** Legacy `artifacts` stays read-only for one milestone post-cutover, then drops. No dual-write maintenance, no shim layer indefinitely.
- **Not optional.** The 2026-05-16 session that produced this spec is the same session where I (the agent) said "session-start feels like reading, not remembering" — that is the gap v7.0.0 closes. Without Wave 3 specifically, the substrate work in Waves 1–2 is invisible to the user.

---

## Ship sequencing

```
v7.0.0 ship gate (in order):

1. Wave 1 lands.
   - 14-07a schema migration applied to dev DB.
   - 14-07b caller migration: B1 → B2 → B3 merged to feature branch (parallel within wave; merge order alphabetical).
   - 14-07c cutover dry-run on dev DB; full benchmark suite runs; gate passes.
   - Cutover applied to production DB; legacy `artifacts` becomes read-only mirror.

2. Wave 2 lands.
   - 14-07-LINKS-SCHEMA migration applied.
   - 14-07d / 14-07e / 14-07f / 14-07g merge in parallel (file ownership locked).
   - Operator review of Hard-Link UX (14-07f) — required gate; flag stays off until operator signs off.
   - Wave 2 gate passes.

3. Wave 3 lands.
   - 14-07h / 14-07i / 14-07j merge in parallel (file ownership locked; merge order alphabetical).
   - Wave 3 gate passes — including the operator-confirmation qualitative gate.

4. Cross-family external review (Codex + Gemini) of the entire diff.

5. Tag v7.0.0. Operator-gated push.

6. One milestone post-ship: drop legacy `artifacts` table. Confirmed via DB sweep that no caller references it.
```

**Position-unless-flagged on link-distance boost ship state:** I lean *ship Wave 2 with feature flag OFF by default*, enable via operator decision after one week of telemetry observation. Reason: ranking-quality regressions are hard to detect from inside; better to let real usage surface them. Tell me if you want it on at ship.

**Position-unless-flagged on `migrate-handoff.ts` runs on lacuna-betting / oracle / nexus:** Out of scope for v7.0.0. Those carry over to a separate operator-runnable surface. Reason: each is a per-project judgment call; bundling them with the milestone ship couples unrelated risks.

---

## Hand-off to wave coordination + plan authoring

After operator sign-off on this CONTEXT, the next deliverables are produced in this order:

1. **14-07-WAVE1-COORDINATION.md** — file-ownership table for 14-07a/b/c, branch strategy for B1/B2/B3 fanout, merge order.
2. **14-07a-PLAN.md**, **14-07b-PLAN.md**, **14-07c-PLAN.md** — Wave 1 plans.
3. **14-07-WAVE2-COORDINATION.md** + Wave 2 plans (LINKS-SCHEMA, d, e, f, g).
4. **14-07-WAVE3-COORDINATION.md** + Wave 3 plans (h, i, j).

Each PLAN.md uses the existing project convention: **Problem · Goal · Acceptance Criteria · Implementation · Tests · Migration/rollback · Anti-scope · Sizing**. Anti-scope is new vs the v6.6.0 PLAN.md convention — added specifically to hold parallel /auto-orchestrate workers to the contract.
