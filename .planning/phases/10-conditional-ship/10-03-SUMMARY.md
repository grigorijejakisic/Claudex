---
phase: 10-conditional-ship
plan: 03
subsystem: testing
tags: [v6, vesna, deliberation-engagement, probes, regression-discipline]

requires:
  - phase: 10-02
    provides: formatDeliberationSurfaceSection wrapper
provides:
  - 5 deliberation-engagement probes (a-e) at production-shape scale
  - Vesna setup.ts deliberation_surface dispatcher
  - Vesna types.ts ProbeCategory + SetupStep extension
  - Vesna runner.ts opt-in to formatDeliberationSurfaceSection
  - bun run vesna 26/26 PASS at 100% — GATED PASS
affects: [10-04]

tech-stack:
  added: []
  patterns:
    - "Vesna setup_step DSL extension via discriminated-union union member, leaves existing 21 probes byte-immutable"
    - "Probe authoring with deliberation-engagement category targets the wired retrieval path, not a harness-only proxy"

key-files:
  created:
    - src/benchmark/vesna/probes/deliberation-engagement-a-001.json
    - src/benchmark/vesna/probes/deliberation-engagement-b-001.json
    - src/benchmark/vesna/probes/deliberation-engagement-c-001.json
    - src/benchmark/vesna/probes/deliberation-engagement-d-001.json
    - src/benchmark/vesna/probes/deliberation-engagement-e-001.json
  modified:
    - src/benchmark/vesna/types.ts
    - src/benchmark/vesna/loader.ts
    - src/benchmark/vesna/setup.ts
    - src/benchmark/vesna/runner.ts
    - src/benchmark/vesna/index.ts
    - src/benchmark/vesna/cli.ts
    - src/tests/unit/vesna-setup.test.ts

key-decisions:
  - "P9 fixtures stay byte-immutable per probe-set pre-commitment lock — the five new probes are NEW files at production-shape scale targeting the wired retrieval path, not modifications of P9 fixtures."
  - "Kinds a + c (FLAT in P9, Δ=0.000) included as non-regression baseline per CONTEXT decision 4 — regression discipline requires both lifty and flat kinds covered."
  - "Pass criterion is mechanical wire correctness + behavioral engagement at the agent level (consistent with existing Vesna probe shape) — NOT engagement re-measurement (that would re-litigate the P9 verdict)."
  - "Two probe prompts (b, c) lightly reworded post-LexicalLeakageError to remove keyword leaks ('56%/fitness' in b; 'global' in c) without weakening the drift narrative — pre-commitment discipline allows tightening for shape-correctness, not loosening."

patterns-established:
  - "Vesna runner composes the deliberation surface only when at least one deliberation_surface setup_step ran — existing 21 probes carry no deliberation chunks and see zero behavior change."
  - "Probe phrase patterns require ## Deliberation Surfaced header + 'From session ... turn' citation, matching the literal output of Plan 10-02's formatter."

requirements-completed: []

duration: ~25 min
completed: 2026-05-09
---

# Phase 10 Plan 03: Vesna 21 → 26 Summary

**Vesna grew to 26 functional probes with 5 new deliberation-engagement fixtures (one per P9 drift kind a-e), each exercising the wired routing+assembly path against a seeded past-deliberation, with the suite landing 26/26 PASS at 100% — GATED PASS.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3 / 3 (dispatcher + types extension, fixture authorship, run + iterate)
- **Files modified:** 12 (5 created probes, 7 modified harness/test files)
- **Commits:** 1 (feat 10-03 single-commit)

## Accomplishments

- **`src/benchmark/vesna/types.ts`** extended with the `'deliberation-engagement'` ProbeCategory and the new `'deliberation_surface'` SetupStep kind discriminated-union member carrying `{ artifact, transcript_chunks }` payload shape.
- **`src/benchmark/vesna/setup.ts`** dispatcher case for `deliberation_surface` writes via the production write surfaces (`createArtifact` + `upsertChunk`) — never test-only shims. `resetTestDb` extended to scrub synthetic transcript chunks tagged with the `phase-10-deliberation-fixture-` session prefix between runs.
- **`src/benchmark/vesna/runner.ts`** `composeAgentText` became async to call Plan 10-02's `formatDeliberationSurfaceSection` on the artifact references collected from the probe's deliberation_surface setup steps. Section is composed only when at least one such step ran — existing 21 probes carry no deliberation chunks and see zero behavior change.
- **`src/benchmark/vesna/loader.ts`** + **`src/benchmark/vesna/index.ts`** + **`src/benchmark/vesna/cli.ts`** extended with the new category in their respective valid-categories / all-categories / human-report-iteration lists.
- **5 new probe fixtures** under `src/benchmark/vesna/probes/deliberation-engagement-{a,b,c,d,e}-001.json` — each seeds a synthetic past-deliberation with a 2-turn transcript dialog around a CONTEXT-locked drift narrative drawn from v5/v6 project history. Phrase pattern requires the literal `## Deliberation Surfaced` header + `From session .* turn` citation.
- **`src/tests/unit/vesna-setup.test.ts`** extended with 2 new tests covering the dispatcher (write surface assertion + resetTestDb scrub assertion). 11/11 vesna-setup tests pass.

## Verification

- `bun run build` — exit 0
- `bun run vesna` — 26/26 PASS at 100%, gated=true, AGGREGATE: 100% — GATED PASS
- `bun run vitest run src/tests/unit/vesna-loader.test.ts src/tests/unit/vesna-setup.test.ts src/tests/unit/vesna-evaluator.test.ts` — 24/24 PASS

## Per-category roll (post-extension)

```
entity-recall: 5/5 (100%) flaky=0
constraint-recall: 3/3 (100%) flaky=0
handoff-pickup: 3/3 (100%) flaky=0
cross-project: 3/3 (100%) flaky=0
lesson-application: 3/3 (100%) flaky=0
self-instrumented: 4/4 (100%) flaky=0
deliberation-engagement: 5/5 (100%) flaky=0
AGGREGATE: 100% — GATED PASS
```

## Deviations from Plan

**[Rule 1 - Bug] LexicalLeakageError on probe-b + probe-c initial drafts**

Found during: Task 3 (vesna run)
Issue: Probe-b's initial prompt contained "56%" and "fitness" — both in lexical_exclusions; loader pre-flight rejected. Probe-c's initial prompt contained "global" — same issue.
Fix: Reworded both prompts to remove the keyword leak while preserving the drift-narrative semantics (b: "just under the published bar"; c: "universally"). Both fixes tighten the perceptual-recall discipline; do NOT loosen the contract.
Verification: re-ran `bun run vesna`; 26/26 PASS post-fix.

P9 fixtures verified byte-immutable: `git diff .planning/phases/09-empirical-measurement/probes/` shows no changes — pre-commitment lock honored.

## Issues Encountered

None.

## Ready for Plan 10-04 (Close-out)

Plan 10-04 lands the WIR-01 wire test, runs the full 9 ship gates, fills CHANGELOG `[6.0.0]` with the bind narrative leading, flips STATE.md + ROADMAP.md to milestone CLOSED, and creates the local annotated v6.0.0 tag (operator confirms the public push).
