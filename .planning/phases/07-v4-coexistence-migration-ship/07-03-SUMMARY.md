---
phase: 07-v4-coexistence-migration-ship
plan: 03
subsystem: extraction
tags: [write-path-filter, parseWrappers, MIG-02, VAL-02, Mem0-trap]
requires: [07-01]
provides:
  - Wrapper-block filter in captureInsightsAsLearnings
  - upsertLearning accepts and persists provenance
  - DB-state contract test for learnings.provenance != 'organic' impossibility
affects:
  - src/adapters/shared/lifecycle.ts
  - src/intelligence/learnings-promoter.ts
  - src/core/learnings.ts
  - src/tests/integration/phase-7-learnings-provenance.test.ts
tech-stack:
  added: []
  patterns:
    - "Upstream filtering — parseWrappers strips wrapper-tagged content before insight extraction"
key-files:
  created:
    - src/tests/integration/phase-7-learnings-provenance.test.ts
  modified:
    - src/adapters/shared/lifecycle.ts
    - src/intelligence/learnings-promoter.ts
    - src/core/learnings.ts
key-decisions:
  - "parseWrappers (Phase 1) is the single source-of-truth for KNOWN_WRAPPER_TAGS — no duplicate list in extraction surface"
  - "promoteLearnings code-flow unchanged — Task 1's default argument suffices because Task 2 filters upstream"
  - "ON CONFLICT does NOT overwrite existing row's provenance — duplicates promote, they don't relabel"
requirements-completed:
  - VAL-02
  - MIG-02
duration: ~12 min
completed: 2026-05-08
---

# Phase 7 Plan 03: Write-path filter for learnings.provenance — Summary

Closes the Mem0-trap vector for the surviving extraction surface (`captureInsightsAsLearnings`). Phase 1's `parseWrappers` strips `<system-reminder>`, `<experience-data>`, `<file-content>`, etc. from assistant text BEFORE `extractInsightsCombined` runs. The `learnings.provenance` column added in Plan 07-01 is structurally always `'organic'` from the production codepath — the substrate-level invariant.

**Duration:** ~12 min
**Tasks:** 4
**Files touched:** 4 (1 created, 3 modified)

## Tasks completed

| # | Task | Commit |
|---|---|---|
| 1 | Extend `upsertLearning` to accept and persist provenance | 8c81a58 |
| 2 | Wire `parseWrappers` filter into `captureInsightsAsLearnings` | 8c81a58 |
| 3 | Inline comment on `promoteLearnings` documenting the default-organic contract | 8c81a58 |
| 4 | Add `phase-7-learnings-provenance.test.ts` integration test (4 cases) | 8c81a58 |

## Deviations from Plan

None — plan executed exactly as written.

## Verification results

- `bun run build` — clean
- `bun run vitest run src/tests/integration/phase-7-learnings-provenance.test.ts` — **4/4 PASS**
- `bun run vitest run src/tests/core/migrations-v30.test.ts` — 8/8 still PASS (no regression on Plan 07-01)
- `bun run vitest run src/tests/intelligence/extraction-deleted.test.ts` — 4/4 still PASS (Phase 4 regression guard)
- **Full suite post-merge baseline: 3460 passing / 27 failing / 8 skipped (3495 total).** +4 from this plan's new test; the 27 pre-existing failures (`llama-client`, `llama-server-supervisor`, `phase-5-full-gate`) persist unchanged. Cite this number in Plan 07-04 as the reference baseline for the "no NEW regressions" gate.

## Issues Encountered

None.

## Next Phase Readiness

Wave 3 (Plan 07-04 — Vesna probes + 2 vitest tests) unblocked. Plan 07-04's `learnings-injected-guard-001` Vesna probe is the agent_text mirror of the DB-state contract this plan asserted.
