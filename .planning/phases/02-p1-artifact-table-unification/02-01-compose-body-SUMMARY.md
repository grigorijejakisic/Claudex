---
phase: 02-p1-artifact-table-unification
plan: 02-01
subsystem: database
tags: [migration, v17, kind-mapping, compose-body, vitest]

requires:
  - phase: 01-p0-crystallization
    provides: locked CONTEXT + AMENDMENT (6-kind scope, legacy_id_map, FTS5 retirement)

provides:
  - KIND_MAPPING source-of-truth for 6 P1 kinds
  - composeBody() pure function used by Phase A pre-embed + Phase B INSERT
  - 18 Vitest cases locking per-kind composition shape

affects:
  - 02-04-v17-ddl-and-triggers (trigger generator consumes KIND_MAPPING)
  - 02-05-migration-runner (Phase A staging calls composeBody)

tech-stack:
  added: []
  patterns:
    - "Pure composer: no DB/FS/clock. Safe for worker threads."
    - "Single source of truth for legacy → kernel + data JSON mapping."

key-files:
  created:
    - src/core/migration/kind-mapping.ts
    - src/core/migration/v17-compose.ts
    - src/tests/core/migration/v17-compose.test.ts
  modified: []

key-decisions:
  - "KIND_MAPPING structured as Record<LegacyTable, KindMapping> — each entry carries kind, legacyIdType, ordered column list, and a pure compose() function. Trigger generator (Plan 02-04) will consume the same structure."
  - "mental_model composer stashes legacy integer supersedes_id in data._legacy_supersedes_id so Pass 2 of Phase B can resolve it via legacy_id_map (per Amendment 2)."
  - "experience_pattern body composed as lesson + '\\n\\nWhat went wrong: ' + anti_pattern only when anti_pattern is non-null. Matches RESEARCH.md §2.1."
  - "confidence kernel col normalization: trust_tier 1..3 → 0.33..1.0 for mental_model; experience_pattern and angel_opinion pass through; others null."

patterns-established:
  - "Compose functions return {title, body, data, scope, status, confidence, session_id, project_id} — the full kernel payload minus id/kind/embedding_ref/supersedes_id/created_at/updated_at (those are set by the migration runner or triggers)."
  - "Column specs declare storage kind: 'kernel' | 'data' | 'legacy_id_map' | 'computed'. Generator uses this to emit view projections + INSTEAD OF trigger bodies."

requirements-completed:
  - STOR-01
  - STOR-02

duration: 5 min
completed: 2026-04-20
---

# Phase 2 Plan 02-01: composeBody + KIND_MAPPING Summary

**Shared pure-function substrate mapping 6 legacy v3 tables onto the unified artifact kernel — consumed by both Phase A pre-embed staging and Phase B atomic INSERT so vec0 embeddings stay aligned with FTS5 title+body text.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-20T09:34:24Z
- **Completed:** 2026-04-20T09:39:42Z
- **Tasks:** 4
- **Files modified:** 3 (all created)

## Accomplishments

- `KIND_MAPPING` defined for all 6 P1 kinds with exact v3 column ordering (learnings, decisions, experience_patterns, angel_opinions, critical_rules, project_curated_context → learning, decision, experience_pattern, angel_opinion, critical_rule, mental_model).
- Per-kind `compose(row)` functions produce the Composed payload with kernel fill rules + kind-specific data JSON shape per 02-RESEARCH.md §2.1 and 02-CONTEXT.md Decision 1.
- `composeBody(kind, row)` pure entry point; no DB, no FS, no clock — safe for worker threads and deterministic re-runs.
- 18 Vitest cases green: per-kind positive, per-kind null/missing-field, experience_pattern anti_pattern suffix rule, mental_model `_legacy_supersedes_id` stash for Pass 2 resolution, critical_rule 80-char truncation, angel_opinion title synth, structural invariants (6 kinds not 7 — Amendment 1 enforced).

## Task Commits

1. **Tasks 01-01-01 + 01-01-02 + 01-01-03** (kind-mapping + composeBody + tests, bundled as tightly-coupled TDD-adjacent unit) — `a3f2f8d` (feat)
2. **Task 01-01-04** (build + test verification — no file changes) — covered by a3f2f8d's CI-equivalent

**Plan metadata:** (pending — committed with SUMMARY.md)

## Files Created/Modified

- `src/core/migration/kind-mapping.ts` — 430 lines. `KIND_MAPPING` record + `KindMapping` interface + per-kind `compose()` functions + `P1_KINDS` constant + helpers.
- `src/core/migration/v17-compose.ts` — 43 lines. Thin dispatcher that looks up the mapping and calls its compose(). Exports the Composed type.
- `src/tests/core/migration/v17-compose.test.ts` — 222 lines. 18 test cases organized by kind + structural invariants block.

## Decisions Made

- Bundled tasks 01-01-01 through 01-01-03 into a single `feat` commit rather than 3 separate ones. Rationale: the three files are mutually dependent (kind-mapping has no public API without compose; compose is untestable without tests), and splitting them would create 2 broken-intermediate commits that can't pass `bun run build`. The git-integration.md rule "commit outcomes" is better served by one atomic shipping unit than 3 half-wired intermediates.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `KIND_MAPPING` structure is the contract for Plan 02-04's trigger generator — generator can iterate `KIND_MAPPING[tbl].columns` to emit view projections + INSTEAD OF triggers. All storage kinds (kernel / data / legacy_id_map / computed) are enumerated.
- `composeBody` signature matches the one required by Plan 02-05's embedding stager (`stageEmbeddings`) and by Phase B INSERT logic. Both paths import from the same module — drift impossible.
- Next plan in Wave 1 is independent (02-02 backup verifier, 02-03 stale review). Wave 2 (02-04, 02-05, 02-06) blocked on this plan — now unblocked.

## Self-Check

- File on disk: `[ -f .planning/phases/02-p1-artifact-table-unification/02-01-compose-body-SUMMARY.md ]` — verified post-write.
- Git commit present: `git log --grep="02-01"` returns `a3f2f8d feat(02-01): composeBody + KIND_MAPPING shared migration substrate`.
- All 18 tests pass: `bun run test -- v17-compose` green.
- Build clean: `bun run build` green.

## Self-Check: PASSED

---
*Phase: 02-p1-artifact-table-unification*
*Completed: 2026-04-20*
