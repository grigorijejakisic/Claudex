---
phase: 03-p2-directive-detector
plan: 04
subsystem: intelligence
tags: [angel, heartbeat, directive-detector, system-tag-stripping, injection-isolation]

requires:
  - phase: 03-p2-directive-detector
    provides: extractDirectivesFromSession (Plan 03-01); regex families + stripCodeBlocks (Plan 03-01)
provides:
  - Heartbeat Phase-2 completed-sessions loop now runs the directive detector BEFORE `extractPatternsFromSession` for the same session
  - Isolated try/catch in heartbeat — directive-path throws do NOT block pattern extraction
  - `TickResult.directives_extracted` / `directives_errors` optional counters
  - System-tag stripping: `<system-reminder>`, `<task-notification>`, `<command-*>`, `<local-command-*>` wrapped content removed before regex pre-filter
  - Static-grep guard test confirming detector modules don't import from `src/assembler/`, `src/hooks/`, `src/core/sections.ts` (P4/P6 blast-radius firewall)
affects: [03-06 integration-confirm step (03-06-08); phase-5 kill-legacy-injection guard]

tech-stack:
  added: []
  patterns:
    - Additive heartbeat hook: new pipeline step runs alongside existing pattern-extractor; failure isolated so neither blocks the other
    - Injection-isolation guard as a unit test (static grep) — fails fast if a future edit crosses the firewall
    - System-tag stripping inside stripCodeBlocks — keeps regex pre-filter honest when agents inject control-plane text into user_text

key-files:
  created:
    - src/tests/intelligence/directive-detector-integration.test.ts
    - src/tests/intelligence/directive-injection-isolation.test.ts
  modified:
    - src/angel/heartbeat.ts
    - src/intelligence/directive-detector-regex.ts
    - src/tests/intelligence/directive-detector.test.ts

key-decisions:
  - "Directive extraction runs BEFORE pattern extraction in the same completed-session loop iteration (RESEARCH §1.1 order)"
  - "markSessionProcessed stays with pattern-extractor — P2 is additive, never gates session processing"
  - "System-tag stripping elevated from 03-03 labeling review where `<system-reminder>` wrappers caused >5 false positives"

patterns-established:
  - "Heartbeat hook isolation: independent try/catch per subsystem; counters on TickResult for observability"
  - "Injection-path firewall is a static test, not a runtime check — stops the import at review time"

requirements-completed:
  - EXTR-02

duration: ~30min
completed: 2026-04-20
---

# Plan 03-04: Angel Heartbeat Wiring Summary

**Directive detector wired into heartbeat Phase-2 completed-sessions loop. Runs before pattern-extractor, isolated try/catch. System-tag stripping fixes the labeling-review false-positive class. Static import-guard prevents accidental injection-path coupling.**

## Performance

- **Completed:** 2026-04-20
- **Tasks:** 3 (heartbeat wiring, system-tag stripping, integration + isolation tests)
- **Files created:** 2
- **Files modified:** 3
- **Tests:** 78/78 directive-tests pass (from 60 at 03-02)

## Accomplishments

- `extractDirectivesFromSession` called inside heartbeat's completed-sessions loop, before pattern extraction, with isolated exception handling.
- `TickResult` carries optional directive counters — observability without coupling.
- System tags (`<system-reminder>`, `<task-notification>`, `<command-*>`, `<local-command-*>`) now stripped alongside code blocks, eliminating the >5-false-positive class from the 03-03 labeling review.
- Integration tests: 2 directives written + 1 rejected end-to-end; directive throw does not block pattern-extractor; call order asserted.
- Injection-isolation test: static grep confirms detector modules don't import from assembler / hooks / sections (P4/P6 firewall).

## Task Commits

1. **Heartbeat wire + tag strip + tests** — `7048a26` (feat: wire detector into Angel heartbeat + system-tag stripping)

## Files Created/Modified

- `src/angel/heartbeat.ts` — +25 lines (new Phase-2 step)
- `src/intelligence/directive-detector-regex.ts` — +39 lines (system-tag strip)
- `src/tests/intelligence/directive-detector-integration.test.ts` — 213 lines, 3 end-to-end tests
- `src/tests/intelligence/directive-injection-isolation.test.ts` — 46 lines, static import guard
- `src/tests/intelligence/directive-detector.test.ts` — +20 lines for tag-strip cases

## Decisions Made

- System-tag strip promoted from "nice to have" to "must" after 03-03 labeling review exposed it as the dominant FP source (>5 out of 14 reviewed).
- `markSessionProcessed` stays with pattern-extractor. P2 is additive: directive extraction succeeds or fails, but does not gate the session's processed-flag.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- Heartbeat runs detector on real sessions as of ship.
- Plan 03-06-08 will confirm via `SELECT COUNT(*) FROM artifact WHERE kind='directive_rule'` > 0 after a live tick.

---
*Phase: 03-p2-directive-detector*
*Completed: 2026-04-20*
