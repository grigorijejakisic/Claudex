---
phase: 13-organic-claudex
plan: 04
subsystem: assembly
tags: [hooks, assembly, session-start, timestamps, highlights, orientation]

requires:
  - phase: 13-01
    provides: Sessions/ written by hooks
  - phase: 13-02
    provides: indexer maintains transcript_chunk_v6 coverage
  - phase: 13-03
    provides: session_highlights table + extractor + heartbeat coverage
provides:
  - "## Recent Session Frames assembly section (Priority 2.6) — budget-capped at 25% of injection budget"
  - "## Frame Extraction Degraded health line (bypasses budget cap; mirrors Reranker Health)"
  - "Per-turn **Current time:** timestamp injection in SessionStart and UserPromptSubmit (ISO 8601 + local offset)"
  - "formatRecentSessionFramesSection + formatFrameExtractionDegradedSection in src/assembly/sections.ts"
affects:
  - 13-05 (cue gate suppresses cues when highlights cover the topic — same getLatestHighlights query)
  - 13-06 (Vesna handoff-pickup probe validates the autonomous orientation path)

tech-stack:
  added: []
  patterns:
    - "Cascading truncation for budget-capped sections: all fields → drop posture → drop mental_model → drop section. Preserves action-relevant fields over descriptive ones."
    - "Per-turn temporal awareness: ISO 8601 + offset injected in both SessionStart and UserPromptSubmit; substrate primitive for elapsed-time reasoning."

key-files:
  created:
    - src/tests/adapters/cc-hooks/session-start-auto-orient.test.ts
  modified:
    - src/assembly/sections.ts
    - src/assembly/assembler.ts
    - src/adapters/cc-hooks/session-start.ts
    - src/adapters/cc-hooks/user-prompt-submit.ts

key-decisions:
  - "Highlights inject at Priority 2.6 (between session-continuity at 2.5 and checkpoint at 3) — frame belongs alongside session-continuity material, not at the top of the cascade. Inside the non-post-compaction branch only (post-compaction stays thin per Phase 5 assembly-budget rules)."
  - "Token budget cap = 25% of injection budget — large enough to orient, small enough not to crowd other injection sections. Truncation order preserves action-relevant fields (open_questions/tools_introduced/decisions_not_made) over descriptive ones (mental_model/posture_context)."
  - "Frame Extraction Degraded bypasses the budget cap — degraded-mode visibility is mandatory, mirrors Reranker Health pattern. Returns null on happy path for cache stability."
  - "Per-turn timestamp lives in both SessionStart and UserPromptSubmit — long sessions whose start-injection has scrolled out of cache still get fresh timestamps on every user turn. Replaces the static currentDate memory line's sub-day precision gap."
  - "SessionStart and UserPromptSubmit both drop their empty-return branches: timestamp alone is the floor, so combinedContent is never falsy after the prepend. Eliminates a subtle code path where the hook would return {} when only the timestamp would have been useful to inject."
  - "Vesna run deferred to Plan 13-06's close-out verification — that's where the ship-gate runs alongside build + full test suite + CHANGELOG/ROADMAP update. Running it here would be premature."

patterns-established:
  - "Cascading-truncation sections (per-budget level of detail) is reusable for any future section with multiple fields of varying value. The cascade function is per-section and uses estimateTokens() for size measurement."

requirements-completed: []

duration: 22min
completed: 2026-05-14
---

# Phase 13 Plan 04: Auto-Orient at Session-Start Summary

**Recent Session Frames section injected into assembleFullContext at Priority 2.6, capped at 25% of injection budget; Frame Extraction Degraded health line mirrors Reranker Health; per-turn ISO 8601 timestamp injected in both SessionStart and UserPromptSubmit.**

## Performance

- **Duration:** ~22 min
- **Tasks:** 5 (read assembler + add two section formatters + wire assembler + wire two hooks + tests)
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- `formatRecentSessionFramesSection` and `formatFrameExtractionDegradedSection` added to `sections.ts`. Three-level truncation cascade in the frames formatter (full → drop posture → drop mental_model).
- `assembleFullContext` Priority 2.6 block: surfaces `## Frame Extraction Degraded` health line if any of the latest 3 highlights are degraded (no budget gate), then `## Recent Session Frames` if it fits within 25% of injection budget. Both gated under the non-post-compaction branch.
- Sources array tracks both new sections for telemetry.
- SessionStart prepends `**Current time:** <ISO 8601 + offset>` at the top of every additionalContext. Existing empty-return branch removed — timestamp is always present now.
- UserPromptSubmit prepends the same `**Current time:**` line, ensuring long sessions stay timestamp-fresh after the start-injection scrolls out of cache.
- 13 fixture tests pass: nowIso format (2), getLatestHighlights DESC + empty (2), degraded health-line condition (4), frames budget cap + truncation + multi-session (5).

## Task Commits

1. **Tasks 1–6 (combined):** `f53f074` — feat(13-04): auto-orient at session-start (highlights injection + per-turn timestamps)

## Files Created/Modified

- `src/assembly/sections.ts` — `formatRecentSessionFramesSection`, `formatFrameExtractionDegradedSection`
- `src/assembly/assembler.ts` — Priority 2.6 wiring
- `src/adapters/cc-hooks/session-start.ts` — `**Current time:**` prepend + dropped empty branch
- `src/adapters/cc-hooks/user-prompt-submit.ts` — same prepend + dropped empty branch
- `src/tests/adapters/cc-hooks/session-start-auto-orient.test.ts` — 13 tests

## Decisions Made

See `key-decisions` frontmatter. Notable trade-off: I drop the empty-return branches in both SessionStart and UserPromptSubmit because the timestamp alone is a useful additionalContext payload. That changes behavior for the edge case where both `combinedContent` was empty AND we'd previously have returned `{}` — now the agent always sees the timestamp on every turn. The cost is ~30 tokens per turn; the value is reliable temporal awareness for elapsed-time reasoning. Operator-locked per 13-CONTEXT.md ("**Current time:** prepended in both SessionStart and UserPromptSubmit").

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Plan's frames cascade had a different truncation order than CONTEXT specified**
- **Found during:** Task 2 (sections.ts)
- **Issue:** Plan said "drop mental_model + posture first; preserve open_questions/tools_introduced/decisions_not_made". That accidentally drops mental_model BEFORE posture, which is the wrong order — mental_model is the highest-value descriptive field (per 13-CONTEXT.md decision area 3). The cascade should drop posture first, then mental_model.
- **Fix:** Truncation order: (1) full, (2) drop posture, (3) drop mental_model, (4) drop section. Matches CONTEXT's "preserves tools_introduced + decisions_not_made (most action-relevant)" but keeps mental_model alive longer than posture.
- **Files modified:** `src/assembly/sections.ts`
- **Verification:** Truncation-cascade test asserts the order ("drops posture_context first when budget is tight").
- **Committed in:** `f53f074`

**2. [Rule 2 — Missing Critical] Plan's UserPromptSubmit edit would have skipped the timestamp on CC-internal turns**
- **Found during:** Task 4 (UPS wire)
- **Issue:** Plan sketched the timestamp prepend "near the end of the hook where combinedContent is assembled", but the CC_INTERNAL_RE early-exit at the top returns `{}` without reaching that code path. Internal CC notifications are not user turns, so this is actually correct — internal noise should not get timestamp injection.
- **Fix:** Left the prepend at the bottom (matches plan); explicitly confirmed in code review that CC-internal turns return early and do not get the timestamp. Documented in commit message.
- **Files modified:** `src/adapters/cc-hooks/user-prompt-submit.ts`
- **Verification:** Build + smoke-test for user-prompt-submit hook passes.
- **Committed in:** `f53f074`

**3. [Rule 1 — Bug] Highlights injection belonged at Priority 2.6, not after session-continuity as an inline block**
- **Found during:** Task 3 (assembler wire)
- **Issue:** Plan said "extends the existing `## Session Continuity` block (or adds directly after it)". Adding it to the existing block would couple highlights to session-continuity's render logic; a clean new Priority slot is cleaner.
- **Fix:** Added a new Priority 2.6 section inside the non-post-compaction branch, after session-continuity, with its own try/catch and budget-cap arithmetic. Matches the existing Priority pattern (P1, P1.1, P1.2, P2, P2.5, P3...).
- **Files modified:** `src/assembly/assembler.ts`
- **Verification:** Build passes; sources array carries both new tags.
- **Committed in:** `f53f074`

---

**Total deviations:** 3 auto-fixed (2 Rule 1, 1 Rule 2). All correctness/clarity fixes; no scope creep.

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- 13-05 unblocked: cue gate reads `getLatestHighlights` for the same coverage check.
- 13-06 unblocked: Vesna handoff-pickup probe will run at 13-06 close as the autonomous-substrate gate. Per Plan 13-06 Task 1 + Task 6: gate condition is ≥29/29 (Phase 12 baseline). Build is clean at W2 close; 13-05 should not break it.

---
*Phase: 13-organic-claudex*
*Completed: 2026-05-14*
