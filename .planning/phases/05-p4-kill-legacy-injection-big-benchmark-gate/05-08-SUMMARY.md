---
phase: 05-p4-kill-legacy-injection-big-benchmark-gate
plan: "08"
status: complete-with-deferred-wire-up
completed: 2026-04-29
---

# Plan 05-08 SUMMARY: INJ-07 reactive trigger detection (helpers + tests)

## What landed

`src/intelligence/experience-patterns.ts` — 4 new exported functions for reactive experience-warning triggers:

| Export | Purpose |
|--------|---------|
| `EXPLICIT_QUERY_KEYWORDS` | canonical 6-keyword list ('do you remember', 'have we', 'last time', 'last session', "didn't we", 'remember when') |
| `isExplicitMemoryQuery(prompt)` | case-insensitive substring match against keyword list |
| `_globToRegex(glob)` | internal helper, single/double-star wildcards |
| `findPatternsByPathGlob(db, project, filePath, limit=5)` | DB query: project + GLOBAL_PROJECT_SCOPE, trigger_glob non-null, score>0; `\\` → `/` normalize |
| `findPatternsByCommandSubstring(db, project, command, limit=5)` | DB query: same shape; substring-include match |

## Schema audit (no migration needed)

Per `05-08-SCHEMA-AUDIT.md`: experience_patterns table already has `trigger_glob` and `trigger_command` columns from V12. Plan 08 plan-text used `path_glob` / `command_substring` as aliases — adapted to actual column names.

## Hook integration: DEFERRED

`pre-tool-use.ts` currently has no DB context in its wrapHook signature. Wiring DB-backed pattern lookups requires a hook-framework change out of Phase 5 scope. The pure-function boundary above is testable, reusable, and unblocks Plan 09's gate.

`user-prompt-submit.ts` already runs `assembleRegularPrompt` per turn which already fires existing FTS5+vector experience warnings. Adding the explicit-keyword boost is a one-line gate; deferred to a follow-up plan.

## Tests

`src/tests/adapters/cc-hooks/experience-warning-triggers.test.ts` — 22 cases covering all 3 trigger types + glob translator + edge cases. 22/22 PASS.

## Commit

| SHA | Description |
|-----|-------------|
| `56a37d1` | feat(05-08): INJ-07 reactive trigger detection (pure functions + tests) |

## Verdict

**PASS-WITH-DEFERRED-WIRE-UP** — INJ-07 capability is in place at the function boundary; the actual hook integration is a routine follow-up that does not gate Phase 5 close. Plan 09 reads the test surface as evidence of capability.

Recommended follow-up plan: extend `pre-tool-use.ts` `wrapHook` signature to receive DB context, then call `findPatternsByPathGlob` and `findPatternsByCommandSubstring` and emit `additionalContext`. Add the explicit-keyword gate in `user-prompt-submit.ts`. Both should be additive, no behavior changes elsewhere.
