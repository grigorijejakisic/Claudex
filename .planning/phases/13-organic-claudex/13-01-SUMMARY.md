---
phase: 13-organic-claudex
plan: 01
subsystem: infra
tags: [hooks, sessions, fsync, durability]

requires: []
provides:
  - "src/adapters/cc-hooks/session-writer.ts: appendTurnToSessionFile, getSessionFilePath, nowIso"
  - per-turn fsync write path for user/assistant/tool_result turns
  - .gitignore Sessions/ entry (operator opt-in to commit)
affects:
  - 13-02 (indexer reads Sessions/ markdown)
  - 13-03 (highlights extractor reads Sessions/)
  - 13-04 (auto-orient reads session_highlights derived from Sessions/)

tech-stack:
  added: []
  patterns:
    - "per-turn fsync open-append-close — one durable write per turn, no batching"
    - "non-throwing write path returns Error|null — caller emits telemetry, hook never fails"

key-files:
  created:
    - src/adapters/cc-hooks/session-writer.ts
    - src/tests/adapters/cc-hooks/session-writer.test.ts
  modified:
    - src/adapters/cc-hooks/user-prompt-submit.ts
    - src/adapters/cc-hooks/stop.ts
    - src/adapters/cc-hooks/post-tool-use.ts
    - .gitignore

key-decisions:
  - "Per-turn fsync instead of batched write — crash-kill leaves everything up to the killed turn on disk, no batched-ingest commit boundary to cross."
  - "Wrappers preserved at write-time, redacted at extraction-time — Sessions/ is the durable artifact; the retrieval pipeline strips wrappers when chunking (13-02)."
  - "Non-throwing write path — failure emits sessions_write_error telemetry but never blocks the hook's primary output."
  - "Config-gated tool result logging (sessions.log_tool_results) — off by default; operator opts in via config."
  - "File naming stable across midnight rollover — once a filename is chosen for a session-id it never changes (getSessionFilePath looks up by `_<sid>.md` suffix first)."
  - "nowIso() builds local-time components against the local TZ offset rather than slicing toISOString(); produces e.g. 2026-05-14T08:53:24+02:00 even when getTimezoneOffset is nonzero."

patterns-established:
  - "Sessions/ markdown is the durable source of truth; DB tables are derived indexes (13-02 onward)."
  - "Hook-side write path is shared via session-writer module; the three hooks import and call, they do not duplicate logic."

requirements-completed: []

duration: 11min
completed: 2026-05-14
---

# Phase 13 Plan 01: Sessions/ as Source of Truth Summary

**Per-turn fsync writes to `<cwd>/Sessions/<date>_<session-id>.md` from three hooks (UserPromptSubmit, Stop, PostToolUse), with a shared session-writer module proving crash-kill durability via fixture tests.**

## Performance

- **Duration:** ~11 min
- **Tasks:** 6 (1 module + 3 hook wires + .gitignore + tests)
- **Files modified:** 6 (1 created, 5 modified, 1 test file created)

## Accomplishments

- `session-writer.ts` exports `appendTurnToSessionFile`, `getSessionFilePath`, `nowIso` — single import surface for the three hooks.
- UserPromptSubmit writes user turns immediately after CC-internal-RE early-exit (durable even if Angel is down).
- Stop writes assistant turns at hook entry (durable regardless of what follows).
- PostToolUse writes tool result turns only when `sessions.log_tool_results` config flag is true (off by default).
- `.gitignore` adds `Sessions/` with operator opt-in comment.
- 11 fixture tests pass: path determinism (4), clean-session multi-turn (4), crash-resilience simulation (2), nowIso format (1).

## Task Commits

1. **Tasks 1–6 (combined):** `bcae27e` — feat(13-01): per-turn Sessions/ markdown writer with fsync

(Combined into one feat commit because the three hook wires share the same import and are coupled to the same module landing; separating them would have produced commits that didn't independently build.)

## Files Created/Modified

- `src/adapters/cc-hooks/session-writer.ts` — shared per-turn writer
- `src/adapters/cc-hooks/user-prompt-submit.ts` — user-turn write call after CC_INTERNAL early-exit
- `src/adapters/cc-hooks/stop.ts` — assistant-turn write call at hook entry
- `src/adapters/cc-hooks/post-tool-use.ts` — config-gated tool_result write call
- `src/tests/adapters/cc-hooks/session-writer.test.ts` — 11 fixture tests
- `.gitignore` — `Sessions/` entry under explanatory comment

## Decisions Made

See `key-decisions` frontmatter. Notable: `nowIso()` was implemented to build local-time components explicitly rather than the more naive slice-of-`toISOString()` approach the plan sketched — that approach would produce UTC-of-now with a local offset suffix, which is wrong.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `nowIso()` implementation correctness**
- **Found during:** Task 1 (writing session-writer.ts)
- **Issue:** Plan's sketch used `d.toISOString().replace('Z', offsetSuffix)` — this concatenates UTC time with a local offset, which represents a wrong instant by `offset` minutes.
- **Fix:** Build local time components via `getFullYear/getMonth/getDate/getHours/getMinutes/getSeconds`, then append the computed `±HH:MM` offset. ISO 8601 with timezone offset, correct local instant.
- **Files modified:** `src/adapters/cc-hooks/session-writer.ts`
- **Verification:** `nowIso` test asserts the format and absence of trailing `Z`.
- **Committed in:** `bcae27e`

**2. [Rule 1 — Bug] `todayLocalIsoDate` for filename prefix**
- **Found during:** Task 1 (path derivation)
- **Issue:** Plan used `new Date().toISOString().slice(0, 10)` for the date prefix — at local-midnight near a UTC boundary this picks the wrong date.
- **Fix:** Added `todayLocalIsoDate()` building YYYY-MM-DD from local components.
- **Files modified:** `src/adapters/cc-hooks/session-writer.ts`
- **Verification:** "creates a new path with today's local-date prefix when no file exists" test passes.
- **Committed in:** `bcae27e`

**3. [Rule 3 — Blocking] PostToolUse tool_response is an object, not a string**
- **Found during:** Task 4 (wiring PostToolUse)
- **Issue:** Existing code extracts `tool_response` as `Record<string, unknown>` (see post-tool-use.ts:35). Plan sketched it as `(input.tool_response as string)`, which would have produced `"[object Object]"` in Sessions/.
- **Fix:** When opting in, serialize via `JSON.stringify(toolOutput)` if not already a string. Skipped when `toolResponse` is empty.
- **Files modified:** `src/adapters/cc-hooks/post-tool-use.ts`
- **Verification:** Build passes; smoke-test for post-tool-use hook passes.
- **Committed in:** `bcae27e`

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs in plan sketch correctness, 1 Rule 3 blocking field-shape mismatch).
**Impact on plan:** Plan executed as scoped; deviations were corrections to plan sketches that would have produced wrong behavior on the timestamp and tool_response surfaces.

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- 13-02 unblocked: Sessions/ markdown is being written by the hooks; the Angel indexer can stat()-scan and re-chunk those files.
- 13-03 unblocked: the highlights extractor will read Sessions/ markdown via the same path.
- 13-04 unblocked: per-turn timestamp injection imports `nowIso` from this module.

---
*Phase: 13-organic-claudex*
*Completed: 2026-05-14*
