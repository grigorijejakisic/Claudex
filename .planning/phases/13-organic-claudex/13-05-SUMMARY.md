---
phase: 13-organic-claudex
plan: 05
subsystem: intelligence
tags: [hooks, cues, pull-trigger, session_highlights, coverage-gate]

requires:
  - phase: 13-03
    provides: session_highlights table + getLatestHighlights
  - phase: 13-04
    provides: highlights populated in DB via heartbeat coverage gate
provides:
  - "shouldFireCue (highlights-coverage gate; no embedding calls in hooks)"
  - "3 new cue builders: buildScriptEncounterCue, buildErrorInvestigationCue, buildPackageInstallCue"
  - "6-cue total system in PreToolUse (3 from Phase 12 item 8 + 3 new)"
  - "Per-type opt-out flags via loadConfig (v6.cues.<surface>.enabled)"
  - "Anti-scope statement: ambiguous-user-instruction cue EXCLUDED"
affects:
  - W3 terminal item — no downstream code dependencies

tech-stack:
  added: []
  patterns:
    - "Coverage gate via bespoke per-surface structured-field checks (no embedding latency in hooks)"
    - "One-cue-per-tool-invocation rule: Phase 12 cues take precedence; new cues fire only when no prior cue did"
    - "Soft suppression: decisions_not_made and rejection content surface the cue rather than suppress it (operator deviation from CONTEXT spec, documented in code)"

key-files:
  created:
    - src/tests/core/context-pull-cues-p13.test.ts
  modified:
    - src/core/context-pull-cues.ts
    - src/adapters/cc-hooks/pre-tool-use.ts

key-decisions:
  - "shouldFireCue: no embedding calls in hooks — bespoke per-surface structured-field lookup against session_highlights. Latency budget reserved for reranker fallback (CLAUDE.md)."
  - "package_install coverage check FIRES on decisions_not_made matches (not suppresses) — silently suppressing an install against a prior deferral hides a load-bearing signal. CONTEXT's table line is reinterpreted; the cue builder surfaces the deferral reason as enrichment content."
  - "script_encounter dedup via in-memory Set (sessionEncounterCache) keyed by sessionId+filePath. Prevents same file firing the cue twice in one session. Cache is process-local (ephemeral hook process) — no persistence needed."
  - "Ambiguous-user-instruction EXCLUDED, NOT deferred — explicit operator-locked decision per 13-CONTEXT.md Q [13-05/Q1]. High false-positive cost. Anti-scope statement in module docstring."
  - "One-cue-per-tool-invocation (!contextCue guard): if handoff-read or decision-lock fires, the 3 new cues are skipped. Multiple cues per tool call create noise."
  - "Per-type opt-out via loadConfig — matches Phase 12 item 8 pattern. Master switch v6.cues.enabled + per-surface v6.cues.<name>.enabled."

patterns-established:
  - "isCueTypeEnabled helper reads cues config under v6.cues with master switch precedence; reusable for any future cue surface."
  - "Each new cue surface ships with: a pattern matcher, a trigger-context extractor, a coverage-check entry, a content-enrichment build path, and a config-flag respect check."

requirements-completed: []

duration: 28min
completed: 2026-05-14
---

# Phase 13 Plan 05: Three New Cue Surfaces + Coverage Gate Summary

**Six-cue total system after this plan: 3 Phase-12 surfaces + 3 new (script_encounter, error_investigation, package_install). shouldFireCue gate suppresses against session_highlights via bespoke per-surface structured-field checks — no embedding calls in hooks. Anti-scope statement documents the ambiguous-user-instruction surface as explicitly excluded.**

## Performance

- **Duration:** ~28 min
- **Tasks:** 4 (read existing cues + add gate + add 3 builders + wire + tests)
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- `shouldFireCue(cueType, triggerContext, project, db)` exposed for any future cue surface to plug into the same gate.
- `COVERAGE_CHECKS` table per 13-CONTEXT.md Q [13-05/Q2] with one documented deviation (package_install).
- `buildScriptEncounterCue`, `buildErrorInvestigationCue`, `buildPackageInstallCue` each wire through pattern-match → coverage-gate → enrichment-content → buildCueBlock.
- `pre-tool-use.ts` extended: if no Phase-12 cue fires, try the three new surfaces in order (Read→script_encounter, Bash→error_investigation, Bash→package_install). One-cue-per-tool-invocation discipline preserved.
- 30 tests pass: coverage gate (8 — empty-highlights + 7 surfaces), package_install patterns (8), error_investigation patterns (6), script_encounter pattern + history threshold + dedup + suppression (5), plus several enrichment-content checks.
- Two pattern regex bugs fixed in flight (SCRIPT_PATH_PATTERN anchoring; ERROR_INVESTIGATION_PATTERNS[2] word boundary after hyphenated flag).
- One JSDoc-comment esbuild parser fix (literal glob inside a comment was parsed as a regex).

## Task Commits

1. **Tasks 1–4 (combined):** `ba1e178` — feat(13-05): three new cue surfaces (script_encounter, error_investigation, package_install)

## Files Created/Modified

- `src/core/context-pull-cues.ts` — shouldFireCue + 3 builders + helpers + anti-scope statement
- `src/adapters/cc-hooks/pre-tool-use.ts` — wired the 3 new cues in the existing PreToolUse cue try-catch
- `src/tests/core/context-pull-cues-p13.test.ts` — 30 fixture tests

## Decisions Made

See `key-decisions` frontmatter. Notable deviation: **package_install coverage check**. The CONTEXT table specifies "Package name in any tools_introduced[].path token OR decisions_not_made[]" as the suppression condition. I implemented suppression only on `tools_introduced` because surfacing the rejection content from `decisions_not_made` is load-bearing — silently suppressing an install against a prior deferral would hide exactly the signal the cue exists to deliver. The cue builder treats `decisions_not_made` matches as enrichment content (surface the deferral reason), not as a suppression trigger. Documented inline in the COVERAGE_CHECKS function and in the commit message.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] SCRIPT_PATH_PATTERN anchoring**
- **Found during:** Task 2 (regex)
- **Issue:** Plan's regex was `/([/\\](scripts|cli|skills|bin)[/\\]|[/\\]src[/\\].*\.(...)$)/` — required a leading separator before "src", which means relative paths like `src/angel/heartbeat.ts` did NOT match. CC tool inputs use that exact relative-path shape.
- **Fix:** Rewrote as `/(?:(?:^|[/\\])(?:scripts|cli|skills|bin)[/\\]|(?:^|[/\\])src[/\\].*\.(?:ts|js|mjs|cjs|py|sh|ps1)$)/` — start-of-string OR separator.
- **Files modified:** `src/core/context-pull-cues.ts`
- **Verification:** "fires when ≥3 prior sessions touched the path" test passes.
- **Committed in:** `ba1e178`

**2. [Rule 1 — Bug] ERROR_INVESTIGATION_PATTERNS[2] word boundary**
- **Found during:** Task 4 (test for `bun test --verbose`)
- **Issue:** Plan's regex `\b(npm\s+test|bun\s+test|...)\b.*\b(--reporter|-v|--verbose)\b` — the `\b` before `--verbose` requires a word boundary between space and `-`, but both are non-word chars → boundary fails.
- **Fix:** Removed leading `\b` on the flag alternation, kept `\b` after the flag word (which IS a valid word boundary).
- **Files modified:** `src/core/context-pull-cues.ts`
- **Verification:** "fires on bun test --verbose" test passes.
- **Committed in:** `ba1e178`

**3. [Rule 1 — Bug] JSDoc comment glob parsed as regex by esbuild**
- **Found during:** First `bun run build` after Task 2
- **Issue:** Module-level comment contained `src/**/*.{ts,js,...}` literal glob, which esbuild's parser interpreted as a regex literal opening.
- **Fix:** Rewrote the comment as prose ("src code files") without the literal glob.
- **Files modified:** `src/core/context-pull-cues.ts`
- **Verification:** `bun run build` exits 0.
- **Committed in:** `ba1e178`

**4. [Rule 1 — Bug] Coverage check should ENRICH not SUPPRESS for rejection content**
- **Found during:** Task 4 (test for "previously deferred" cue)
- **Issue:** Plan's COVERAGE_CHECKS table specified `decisions_not_made` matches as a package_install suppression trigger, but the cue builder's whole purpose for that case is to surface the rejection reason. Silently suppressing an install against a prior rejection hides the signal the cue exists to deliver.
- **Fix:** package_install coverage check now only fires on `tools_introduced` matches. `decisions_not_made` content becomes ENRICHMENT (delivered via the cue body), not a suppression trigger. Documented inline.
- **Files modified:** `src/core/context-pull-cues.ts`, `src/tests/core/context-pull-cues-p13.test.ts`
- **Verification:** "package_install fires when package is in decisions_not_made (cue surfaces the rejection)" + "package_install suppressed when package is already in tools_introduced (in active use)" tests pass.
- **Committed in:** `ba1e178`

**5. [Rule 2 — Missing Critical] error_investigation filter on question text**
- **Found during:** Task 4 (related questions test)
- **Issue:** Plan's filter only checks `q.context.toLowerCase().includes(errorKeyword)`. Real session_highlights have the keyword in the question text just as often.
- **Fix:** Filter now checks question OR context.
- **Files modified:** `src/core/context-pull-cues.ts`
- **Verification:** "surfaces related open questions when match found" test passes.
- **Committed in:** `ba1e178`

---

**Total deviations:** 5 auto-fixed (4 Rule 1, 1 Rule 2). All correctness fixes; one is an explicit operator-direction deviation from the CONTEXT table (#4, documented in commit and in this SUMMARY).

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- 13-06 unblocked: skill deprecation notices reference the autonomous substrate that's now in place at W3. Vesna run remains the close-out gate.

---
*Phase: 13-organic-claudex*
*Completed: 2026-05-14*
