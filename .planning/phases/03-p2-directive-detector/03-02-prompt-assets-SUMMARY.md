---
phase: 03-p2-directive-detector
plan: 02
subsystem: intelligence
tags: [directive-detector, prompts, few-shot, assets]

requires:
  - phase: 03-p2-directive-detector
    provides: detector core with `loadPromptAssets()` stub (Plan 03-01)
provides:
  - File-backed swappable prompt assets under `src/intelligence/directive-detector-prompts/`
  - `confirmation-system-prompt.md` + `confirmation-few-shot.json` (9 positive 3:3:3 + 3 negative at ship-time)
  - `scope-rubric-system-prompt.md` + `scope-rubric-few-shot.json` (9 examples 3:3:3, reserved for split-prompt use)
  - `loadPromptAssets()` with src/dist path resolution, `{{FEW_SHOT}}` substitution, result caching
  - `DIRECTIVE_DETECTOR_RELOAD_PROMPTS=1` / `reload=true` cache bypass for iteration
  - Fallback to inline minimal prompts on read failure (degrades precision, does not disable extraction)
affects: [03-06 calibration — few-shot examples were tuned across 3 cycles]

tech-stack:
  added: []
  patterns:
    - External prompt assets enable fast iteration without rebuild when paired with the reload flag
    - Read-failure falls back rather than errors — extraction continues at lower precision

key-files:
  created:
    - src/intelligence/directive-detector-prompts/confirmation-system-prompt.md
    - src/intelligence/directive-detector-prompts/confirmation-few-shot.json
    - src/intelligence/directive-detector-prompts/scope-rubric-system-prompt.md
    - src/intelligence/directive-detector-prompts/scope-rubric-few-shot.json
    - src/tests/intelligence/directive-detector-prompts.test.ts
  modified:
    - src/intelligence/directive-detector.ts

key-decisions:
  - "Fallback to inline minimal prompts on read failure — keep detector alive rather than hard-fail"
  - "Path resolution handles source (src/...) and bundled (dist/...) runs via relative discovery"
  - "{{FEW_SHOT}} is a literal placeholder — no templating engine, just string.replace"

patterns-established:
  - "Swappable prompt asset pattern: MD system prompt + JSON few-shot, loaded at call site, cached"
  - "Iteration ergonomics: env-var cache bypass for tuning without rebuild"

requirements-completed:
  - EXTR-01
  - EXTR-02

duration: ~30min (after detector core)
completed: 2026-04-20
---

# Plan 03-02: Prompt Fixture Assets Summary

**Swappable MD + JSON prompt assets with file-backed loader. Replaces detector core's inline prompt stubs with iteration-friendly externals. Enables Plan 03-06's 3-cycle prompt tuning without rebuild.**

## Performance

- **Completed:** 2026-04-20
- **Tasks:** 5 (confirmation few-shot, scope rubric few-shot, confirmation system, scope system, loader + tests)
- **Files created:** 5
- **Files modified:** 1 (detector.ts replaced stub with loader)
- **New tests:** 12 (60/60 directive-detector tests pass)

## Accomplishments

- Confirmation few-shot built to 3:3:3 scope balance (3 session, 3 project, 3 universal) plus 3 negatives — drawn from CLAUDE.md + `memory/feedback_*.md` + session logs.
- Scope-rubric few-shot in parallel structure (reserved for split prompts; unused at ship but available).
- Loader handles both source-tree and bundled-dist layouts via path discovery.
- `{{FEW_SHOT}}` substitution is plain string replace; no templating dependency.
- Cache keyed on file paths; `DIRECTIVE_DETECTOR_RELOAD_PROMPTS=1` or `reload=true` opt-arg bypass.
- Schema test validates JSON shape + 3:3:3 scope coverage.

## Task Commits

1. **All 5 tasks** — `afb9078` (feat: prompt fixture assets + file-backed loader)

## Files Created/Modified

- `src/intelligence/directive-detector-prompts/confirmation-system-prompt.md` — static system prompt with `{{FEW_SHOT}}` placeholder
- `src/intelligence/directive-detector-prompts/confirmation-few-shot.json` — 9 positive (3:3:3) + 3 negative examples at ship (later grew to 15 during calibration)
- `src/intelligence/directive-detector-prompts/scope-rubric-system-prompt.md` — reserved split-prompt system text
- `src/intelligence/directive-detector-prompts/scope-rubric-few-shot.json` — 9 scope-only examples (3:3:3)
- `src/tests/intelligence/directive-detector-prompts.test.ts` — loader + schema tests
- `src/intelligence/directive-detector.ts` — loader integration (+158 lines net)

## Decisions Made

- Read-failure fallback is deliberate: detector continues with inline minimal prompts rather than hard-failing. Surfaced via warn-log so monitoring catches it.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- Detector now uses external assets. Plan 03-06 calibration cycles 2–3 tuned these prompts without rebuilding the detector.
- Plan 03-03 (fixture corpus) + 03-05 (precision harness) consume the shipped prompts for measurement.

---
*Phase: 03-p2-directive-detector*
*Completed: 2026-04-20*
