---
phase: 14-substrate-coherence
sub_phase: 14-07
wave: 3
role: PM coordination doc — read by all Wave 3 /auto-orchestrate workers
created_by: PM (Claude Opus 4.7) on 2026-05-16
parent_context: .planning/phases/14-substrate-coherence/14-07-CONTEXT.md
depends_on_wave: 2
---

# v7.0.0 Wave 3 Coordination Manifest — Session-Start Coherence

This document is the PM-level contract that every Wave 3
/auto-orchestrate worker MUST honor. Wave 3 is the **user-facing
payoff** of v7.0.0 — substrate unification (Wave 1) and the
knowledge graph (Wave 2) become visible through three changes to
session-start:

1. **14-07h** — MEMORY.md regenerator fix + lesson trigger-style
   frontmatter + experience-pattern project-scoping filter.
2. **14-07i** — codebase-context annotation (each surfaced file gets
   a retrieval-reason annotation).
3. **14-07j** — link-aware lesson inline-expansion (top 2–3 lessons
   by trigger match or link-distance to the current pivot get their
   full body inlined; rest stay as pointers).

The pattern is **no pre-fanout schema** (Wave 3 plans don't share a
table) but **three workers all touch `src/assembly/sections.ts`**
— function-level ownership is enforced below to prevent collision.

Critically: **14-07j depends on Wave 2's link graph being populated**.
14-07h and 14-07i have no Wave 2 dependency and could in principle
run earlier — BUT per CONTEXT Locked Decision 7, execution is
strict-sequential by wave. Wave 3 starts after Wave 2 ships.

---

## Wave 3 entry gate (must be true before this wave starts)

- Wave 2 fully shipped (LINKS-SCHEMA + 14-07d + 14-07e + 14-07f +
  14-07g all merged).
- Soft-link autonomous writers (14-07d) are firing in production.
- Hard-link proposer UX simulation (14-07f) reviewed by operator;
  decision recorded for whether `CLAUDEX_HARD_LINK_PROPOSER` flag
  is enabled or held.
- Provenance Chain section (14-07g) verified rendering correctly
  for synthetic decisions.
- claudex_trace MCP tool (14-07e) responsive.
- `bun run setup` reports V38.

---

## Workers + plans

| Worker | Plan | Branch | Sequence |
|---|---|---|---|
| H | 14-07h (regenerator + lessons + experience scoping) | `phase-14-07/h-lessons-regen` | parallel start |
| I | 14-07i (codebase-context annotation) | `phase-14-07/i-codebase-annot` | parallel start |
| J | 14-07j (link-aware lesson inline-expansion) | `phase-14-07/j-link-aware` | parallel start (Wave 2 link graph already live) |

Sequencing:
```
H, I, J  (all parallel from wave start)
```

No pre-fanout block. All three workers start together. File-ownership
table below enforces non-collision in `src/assembly/sections.ts`.

---

## File ownership table

PM (me) is the only authority for resolving boundary disputes.

### Plan 14-07h (Worker H — regenerator + lessons + experience) owns

- `src/angel/memory-md-writer.ts` — the regenerator. Fix the
  2026-05-14 wipe regression; preserve User Notes section
  byte-equivalent across regenerations; render lessons using
  `trigger:` frontmatter.
- `src/angel/lesson-writer.ts` — add `trigger` field to lesson
  frontmatter on write (additive; existing lessons get a
  back-fill migration).
- `src/scripts/migrate-lesson-trigger.ts` (NEW) — operator-runnable
  migration tool to add `trigger:` field to existing lesson files
  via inference from body OR explicit operator-supplied trigger.
- `src/intelligence/experience-tier.ts` — add project-scope filter
  to the passive injection path. Cross-project patterns no longer
  surface in passive injection (still queryable via claudex_search).
- `src/assembly/sections/lessons.ts` — H touches the **lessons section
  formatters**: `formatProvenPrinciplesSection` and/or `formatLearningsSection`.
  H surveys during authoring and decides which function(s) to extend for
  trigger-style rendering. H owns these functions ONLY. (Wave 0 w0d split
  moved them here from the monolithic sections.ts; they are re-exported from
  sections.ts for backwards compat.)
- `src/tests/angel/memory-md-writer.test.ts` — extend with
  regenerator round-trip test (10 regens preserve User Notes +
  Lessons index).
- `src/tests/angel/lesson-writer.test.ts` — extend with `trigger:`
  field emission tests.
- `src/tests/scripts/migrate-lesson-trigger.test.ts` (NEW).
- `src/tests/intelligence/experience-tier-project-scope.test.ts`
  (NEW).

### Plan 14-07i (Worker I — codebase-context annotation) owns

- `src/assembly/sections/codebase-context.ts` — touches
  `formatCodebaseContextSection`. I owns ONLY this function.
  (Wave 0 w0d split extracted it from assembler.ts:857 and placed it here.
  It is re-exported from sections.ts for backwards compat.)
- `src/core/hybrid-retrieval.ts` — surface the retrieval
  query + score in the returned candidate metadata so the assembler
  can render the reason. Additive; existing return shape extended,
  not replaced.
- `src/tests/assembly/codebase-context-annotation.test.ts` (NEW).
- `src/tests/intelligence/hybrid-retrieval-metadata.test.ts` (NEW).

### Plan 14-07j (Worker J — link-aware lesson inline-expansion) owns

- `src/assembly/sections/lessons.ts` — touches the **lessons section
  formatters** that H also touches. **CRITICAL coordination point:**
  J extends H's lessons section to inline-expand top-K lessons by
  trigger match + link distance. PM enforces: H ships first; J
  rebases onto H's landed lessons-section function in
  `sections/lessons.ts` and ADDS the inline-expansion behavior as
  additional functionality, not a rewrite.
- `src/intelligence/lesson-relevance.ts` (NEW) — computes
  "relevance score" per lesson = function of trigger match strength
  + link distance to current pivot. Reads link graph via Wave 2
  claudex_trace internals.
- `src/tests/intelligence/lesson-relevance.test.ts` (NEW).
- `src/tests/assembly/lesson-inline-expansion.test.ts` (NEW).

---

## File-level ownership (post-Wave-0 w0d split)

**Wave 0 (w0d) split the monolithic `sections.ts` into:**
- `src/assembly/sections/lessons.ts` — lessons formatters (H + J)
- `src/assembly/sections/codebase-context.ts` — codebase context formatter (I)
- `src/assembly/sections/links.ts` — link formatters (Wave 2 F + G)
- `src/assembly/sections.ts` — residual (unchanged by Wave 3)

H, I, and J now touch **different files** — collision risk is lower
than the original spec claimed. The table below reflects actual file ownership.

| Function | File | Owner | Notes |
|---|---|---|---|
| `formatProvenPrinciplesSection` | `sections/lessons.ts` | H surveys; H or J may extend | H ships first; J adds inline-expansion behavior |
| `formatLearningsSection` | `sections/lessons.ts` | H surveys; H or J may extend | Same as above |
| `formatCodebaseContextSection` | `sections/codebase-context.ts` | I | Fully isolated; no overlap with H or J |
| All other functions in sections.ts | `sections.ts` | UNTOUCHED by Wave 3 | |

Critical constraints:

1. **H ships first.** Merge order: H → I → J. H establishes the
   lessons-section function shape that J extends.
2. **I is independent.** I touches only `sections/codebase-context.ts`.
   No overlap with H or J; I can merge in parallel with H.
3. **J rebases onto H's branch.** After H lands, J rebases onto
   integration branch and adds inline-expansion to the lessons
   functions in `sections/lessons.ts`.
4. **No worker modifies `sections.ts` (the residual file).** All
   Wave 3 changes land in the modular sub-files.
5. **Each worker adds their re-export to `sections/index.ts`** if
   they add a new function, so it surfaces at `assembly/sections.js`.

---

## Merge order

1. **H first.** Touches memory-md-writer + lesson-writer + new
   migrate-lesson-trigger script + experience-tier filter + lessons
   functions in `sections/lessons.ts`.
2. **I second.** Touches `formatCodebaseContextSection` in
   `sections/codebase-context.ts` + hybrid-retrieval metadata surface.
   No overlap with H.
3. **J third.** Rebases onto integration branch (post-H). Adds
   inline-expansion to H's lessons functions in `sections/lessons.ts`
   + new lesson-relevance.ts.

If H fails review, I and J still land (I is fully independent; J
can be held until H is fixed, OR J can land without the link-aware
behavior if H's lessons section function shape allows).

---

## Cross-plan invariants

1. **MEMORY.md User Notes section is sacred.** No worker modifies
   it. H's regenerator preserves byte-equivalent; I and J don't
   touch MEMORY.md at all.

2. **Lesson frontmatter `trigger:` field is single-writer by H.**
   J reads it for relevance scoring; J does NOT modify lesson
   files.

3. **Wave 2 link graph is read-only for Wave 3.** J consumes via
   claudex_trace internals; H and I don't touch links.

4. **Experience-tier project-scope filter is single-writer by H.**
   No worker bypasses to surface cross-project patterns in passive
   injection.

5. **Codebase-context annotation surface (I) does not modify the
   retrieval pipeline ranking.** I extends the returned metadata;
   the ranking math stays.

6. **Lesson inline-expansion budget cap (J)** is locked at: inline
   the top 3 lessons by relevance, budget 400 tokens TOTAL across
   the 3 (~130 tokens per inlined lesson). Rest of lessons stay as
   pointers per H's regenerator output. Coordinate with H on the
   shared lessons section budget.

7. **Heuristic-gated sections (provenance from G; J's inline-
   expansion) share a discipline:** budget spent only when
   relevant. J's inline-expansion is ALWAYS-ON because lessons are
   load-bearing every session; relevance scoring controls *which*
   lessons are inlined.

8. **Anti-scope for Wave 3 (every worker must NOT):**
   - Modify Wave 1's V17 schema or caller migration.
   - Modify Wave 2's link tables or link-writer.ts.
   - Modify hybrid-retrieval scoring math beyond surfacing query+
     score metadata (I's only retrieval change).
   - Change reranker / embedder / vector dimensions.
   - Add new MCP tools.
   - Change the assembler cascade order (P-numbers locked).

---

## Worker → PM escalation

Workers ask the PM when they hit:
- A function in `sections.ts` whose ownership isn't clear from this
  manifest's table.
- A test failure outside their plan's scope.
- A migration tool (H's migrate-lesson-trigger.ts) that needs
  operator input on existing lesson files.
- A spec ambiguity in their PLAN.md.
- A scope question about the lessons-section function shape (H/J
  coordination point).

Workers do NOT escalate for:
- Standard implementation choices.
- Build / test re-run mechanics.
- Anything listed in their plan's `must_haves.truths` or this
  manifest's invariants.

---

## PM → PO escalation

PM escalates to PO (operator) when:
- A worker reports a fundamental contradiction between two plan ACs.
- The behavioral disposition test on big-mozzy-v2 / claudex-v3
  surfaces a regression in "does session-start feel remembered?"
  (the qualitative gate per CONTEXT).
- H's regenerator fix needs operator review of the migrate-lesson-
  trigger.ts CLI behavior before running on real lesson files.
- I's codebase-context annotation reveals retrieval-quality issues
  not anticipated.
- J's lesson inline-expansion budget is too restrictive / too
  generous in operator's view.
- Cross-family external review (Codex + Gemini) returns NO-SIGNOFF
  on the v7.0.0 ship.

---

## SIGNOFF + ship per plan

Each plan ships its own commit with:
- All AC from the plan green.
- Tests pass within plan's scope.
- Cross-family external review (Codex + Gemini) SIGNOFF.
- PM merge after order check.
- Updated `14-07-WAVE3-STATUS.md`.

After all 3 plans land, PM runs the **v7.0.0 final ship gate**:

1. All AC green across Wave 1 + Wave 2 + Wave 3.
2. Vesna 18/18 PASS against post-Wave-3 state.
3. LongMemEval ≥ v6.6.0 baseline.
4. LoCoMo ≥ v6.6.0 baseline.
5. Cross-project candidate hit rate non-regressed.
6. MEMORY.md regenerator round-trip preserves all artifacts.
7. Codebase-context section includes annotated reasons.
8. Link-aware inline-expansion surfaces correct lessons for
   synthetic pivots.
9. Operator-confirmed disposition test on big-mozzy AND claudex-v3:
   does session-start carry the right context?
10. **Operator confirmation that session-start feels "remembered"
    not "read"** — the qualitative gate per CONTEXT.

If all gates pass: tag `v7.0.0` annotated. Push remains operator-
gated.

---

## What this is NOT

- Not a replacement for per-plan PLAN.mds.
- Not a substitute for git's conflict resolution.
- Not authority for scope changes — plans + CONTEXT + this manifest
  define scope.
- Not a UX redesign — the assembler cascade structure (P-numbers,
  budgets, ordering) is locked. v7.0.0 sharpens content, not
  structure.
- Not a benchmark-improvement project — gates are non-regression.
- Not optional. The qualitative gate (operator confirms session-
  start feels remembered) is what v7.0.0 ships *for*.
