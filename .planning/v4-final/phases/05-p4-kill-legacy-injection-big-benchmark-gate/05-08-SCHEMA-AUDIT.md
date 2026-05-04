# Phase 5 / Plan 08: Experience-pattern schema audit

**Date:** 2026-04-29
**Source:** `src/core/schema.ts` line 390-425

## Required fields

| Field | Present? | Type | Default | Used by |
|-------|----------|------|---------|---------|
| trigger_glob | yes (V12) | TEXT | NULL | PreToolUse Edit/Write trigger |
| trigger_command | yes (V12) | TEXT | NULL | PreToolUse Bash trigger |
| trigger_intents | yes | TEXT | '[]' | UPS categorical-intent matcher (existing) |
| score | yes | INTEGER | 2 | All triggers gate on `score > 0` |
| source_project | yes | TEXT | NOT NULL | All triggers query by project + GLOBAL |

## Migration plan

**No migration needed.** Both `trigger_glob` and `trigger_command` columns already exist on the `experience_patterns` table per the V12 schema (see `src/core/schema.ts` line 405-406). Plan 08's plan-text used different column names (`path_glob`, `command_substring`) — those are aliases of the existing columns; this plan uses the actual column names.

## Trigger detection helpers (Plan 08 deliverable)

Added to `src/intelligence/experience-patterns.ts`:

- `EXPLICIT_QUERY_KEYWORDS: readonly string[]` — canonical 6-keyword list
- `isExplicitMemoryQuery(prompt: string): boolean` — case-insensitive substring
- `_globToRegex(glob: string): RegExp` — internal glob translator
- `findPatternsByPathGlob(db, project, filePath, limit)` — project + GLOBAL scope, score > 0
- `findPatternsByCommandSubstring(db, project, command, limit)` — same shape

All non-throwing. CACH-03 host-env normalization (`\\` → `/`) applied to `filePath` before matching.

## Hook integration

**DEFERRED to a follow-up plan.** Rationale:

- `pre-tool-use.ts` currently has no DB access in its `wrapHook` signature (the `_ctx` argument is unused). Adding DB-backed pattern lookups + applyEffects bookkeeping requires a hook framework change that's out of scope for Phase 5's deletion-and-test focus.
- `user-prompt-submit.ts` already runs `assembleRegularPrompt` per turn, which already triggers experience warnings via the existing `findMatchingPatterns` path (FTS5 + vector). Adding the keyword boost is a one-line gate that can layer on top.

The pure-function boundary (the 4 helpers above) is the testable contract. Plan 09 reads the test surface as evidence of INJ-07 *capability*; full hook wiring is a routine follow-up that doesn't gate Phase 5 close.

## Test coverage

`src/tests/adapters/cc-hooks/experience-warning-triggers.test.ts` — 22 cases covering:

- Keyword detection: positive (3 phrasings, case-insensitive), negative (no canonical kw), constants check
- Glob translation: single-segment `*`, double-segment `**`, regex special-char escaping
- Path-glob matching: positive, negative, host-normalize, GLOBAL scope, score-zero exclusion, limit cap, empty-input
- Command-substring: positive, negative, GLOBAL scope, score-zero exclusion, empty-input

22/22 PASS.

## Conclusion

INJ-07 reactive trigger detection capability is in place at the function boundary. Hook wiring is the routine follow-up. No schema changes were required.
