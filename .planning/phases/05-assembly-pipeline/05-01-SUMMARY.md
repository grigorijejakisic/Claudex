---
phase: 05-assembly-pipeline
plan: 01
status: complete
duration: 3min
tasks_completed: 2
files_created:
  - src/assembly/token-estimator.ts
  - src/assembly/sections.ts
  - src/tests/assembly/token-estimator.test.ts
  - src/tests/assembly/sections.test.ts
tests_passed: 48
---

## Summary

Token estimator re-exports shared `estimateTokens` (Math.ceil(text.length / 4)) for clean assembly module boundaries. All 10 stateless section formatters implemented as pure functions: identity, project, checkpoint, learnings, hot files, GSD, FTS5, recent, gauge, and topic pivot. Each takes pre-fetched data, returns formatted markdown or null, and is non-throwing.

## Decisions

- Token estimator re-exports from shared/text-utils.ts (no code duplication)
- formatHotFilesSection filters by 0.851 threshold inside the formatter
- formatFts5Section supports both full and reference mode via boolean parameter
- formatGaugeSection defaults to 0.70 threshold, accepts custom override
- formatTopicPivotSection caps learnings at 3 items
- formatRelativeTime internal helper for human-readable timestamps
