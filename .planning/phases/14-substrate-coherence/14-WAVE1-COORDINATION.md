---
phase: 14-substrate-coherence
wave: 1
role: PM coordination doc — read by all Wave 1 /auto-orchestrate workers
created_by: PM (Claude Opus 4.7) on 2026-05-15
---

# Wave 1 Coordination Manifest

This document is the PM-level contract that every Wave 1
/auto-orchestrate worker MUST honor. It exists because four
plans run concurrently with overlapping file footprints; without
explicit ownership + merge order, parallel execution will produce
git conflicts.

## Workers + plans

| Worker | Plan | Branch | Sequence |
|---|---|---|---|
| A | 14-01 (handoff schema + migration tool) | `phase-14/01-handoff-schema` | parallel start |
| B | 14-08 (multi-agent ACTIVE.md) | `phase-14/08-multi-agent-active` | parallel start |
| C | 14-02 (project naming column) | `phase-14/02-project-naming` | parallel start |
| D | 14-06 (epoch ms canonicalization) | `phase-14/06-epoch-ms` | starts after C lands |

Worker D is sequenced behind Worker C because they both touch
`src/core/migration-steps.ts` and several caller files (notably
`src/angel/memory-md-writer.ts` and `src/intelligence/directive-detector.ts`).
Running them simultaneously will produce non-trivial git conflicts.
Worker C's blast radius is smaller; worker D rebases onto C's
landed work.

## File ownership table

The PM (me) is the only authority for resolving boundary disputes.
Every worker reads this table before touching a file. If a file
isn't listed here, normal `git add` behavior applies.

### Plan 14-01 owns
- `src/scripts/migrate-handoff.ts` (NEW)
- `src/angel/handoff-writer.ts` (telemetry hook addition only)
- `src/tests/scripts/migrate-handoff.test.ts` (NEW)
- `src/tests/angel/handoff-writer.test.ts` (extend, do not rewrite)

### Plan 14-08 owns
- `src/assembly/sections.ts` — **only** `renderSessionContinuity`
  and any helpers it directly calls
- `src/tests/assembly/sections.test.ts` — only the
  `renderSessionContinuity` test block

### Plan 14-02 owns
- `src/core/migration-steps.ts` — **adds** `migrateV33toV34`
  (no edits to prior steps)
- `src/core/migration/v17-runner.ts`
- `src/core/migration/v17-triggers.ts`
- `src/intelligence/directive-detector.ts` — only `project_id`
  references
- `src/intelligence/retrieval-log.ts` — only `project_id` references
- `src/angel/transcript-chunker.ts` — only `project_id` references
- `src/angel/memory-md-writer.ts` — only `project_id` references
  (NOT epoch fields)
- All test fixtures referencing `project_id` on V17 schemas
- DDL constraint update on `artifact.kind` enum is OUT OF SCOPE
  for 14-02

### Plan 14-06 owns
- `src/core/epoch.ts` (NEW)
- `src/core/migration-steps.ts` — **adds** `migrateV34toV35`
  (after 14-02's migrateV33toV34 lands)
- `src/scripts/migrate-lesson-frontmatter.ts` (NEW)
- Every `*_epoch` column rename + caller sweep across:
  `sessions`, `observations`, `learnings`, `checkpoint_meta`,
  `artifact`, `episodic_events`, `telemetry`, `pressure_scores`
- `src/angel/memory-md-writer.ts` — epoch fields only
  (NOT `project_id` rename — that's 14-02's scope)
- `src/angel/lesson-writer.ts` — `created_at_epoch` rename
- `src/tests/core/epoch.test.ts` (NEW)
- All test fixtures referencing `*_epoch` columns

## Merge order

PM merges in this order to minimize conflict resolution:
1. **14-08** first — smallest diff, no schema changes, isolated to one
   function in `sections.ts`. Lands without conflict.
2. **14-01** second — only touches `handoff-writer.ts` (additive
   telemetry) plus brand-new files (`migrate-handoff.ts`). No
   conflict possible.
3. **14-02** third — schema migration is additive; caller sweep
   touches files no other Wave 1 plan owns (except shared
   `memory-md-writer.ts` which is split by `project_id` vs
   `*_epoch` lines).
4. **14-06** last — depends on 14-02's `migrateV33toV34` landing
   so its `migrateV34toV35` is the next step. Caller sweep across
   epoch fields. Worker D explicitly rebases onto 14-02's branch
   before starting work.

## Cross-plan invariants

These contracts span multiple plans. PM enforces; workers honor.

1. **Schema migration numbering:** 14-02 = `migrateV33toV34`.
   14-06 = `migrateV34toV35`. Both increment `PRAGMA user_version`
   by 1 and add a row to `schema_versions`. Reverse migrations
   present.

2. **File-section ownership:** when 14-02 and 14-06 both touch
   `memory-md-writer.ts`, they touch **different lines**. 14-02
   touches `project_id` column references; 14-06 touches `*_epoch`
   field references. Workers MUST use targeted `Edit` calls (not
   full file rewrites) so the diffs don't overlap textually even
   when the same file is edited.

3. **Test fixture schema:** any test that creates a fresh DB and
   seeds rows must use the post-Wave-1 schema (post-V35). PM
   provides a shared fixture helper at
   `src/tests/helpers/wave1-schema.ts` if needed.

4. **No `project_id` regressions in 14-06.** Worker D rebasing onto
   14-02 must NOT re-introduce `project_id` references in the
   epoch caller sweep.

5. **No `_epoch` regressions in 14-02.** Worker C's caller sweep
   for `project_id` rename must NOT touch `_epoch` field names.

## Worker → PM escalation

Workers ask the PM (me) when they hit:
- A file that isn't in their ownership column AND isn't in
  another plan's ownership column either (judgment call —
  PM decides).
- A schema decision not covered in their PLAN.md or this manifest.
- A test that fails for a reason outside their plan's scope (the
  failure may be uncovering a real bug elsewhere).
- A spec ambiguity in their PLAN.md.

Workers do NOT escalate for:
- Standard implementation choices (variable naming, function
  signature minor variations, test structure within their plan's
  test files).
- Build / test re-run mechanics.
- Anything explicitly listed in their plan's `must_haves.truths`.

## PM → PO escalation

I (PM) escalate to the PO (operator) when:
- A worker reports a fundamental contradiction between two plan
  ACs.
- A schema decision proposed by a worker would change the
  contract matrix.
- The merge order produces an unresolvable conflict.
- A worker's external review (Codex / Gemini) returns NO-SIGNOFF
  with a load-bearing concern.

## SIGNOFF + ship

Each plan ships its own commit with:
- Plan ACs verified
- Tests pass within the plan's scope
- Cross-family external review (Codex + Gemini) SIGNOFF
- PM merge after order check
- Updated `14-WAVE1-STATUS.md` (PM-maintained) noting completion

After all 4 land, PM kicks off Wave 2 by writing
`14-WAVE2-COORDINATION.md` against the actual landed state.

## What this is NOT

- Not a replacement for the per-plan PLAN.mds — it's the
  inter-plan coordination layer above them.
- Not a substitute for git's actual conflict resolution. If
  collision happens despite this doc, PM resolves manually.
- Not authority for scope changes. Plans + this manifest define
  scope; changes require PO sign-off.
