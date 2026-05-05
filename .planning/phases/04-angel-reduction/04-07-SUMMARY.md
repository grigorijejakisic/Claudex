---
phase: 04-angel-reduction
plan: 07
subsystem: vesna
tags: [vesna, probe, sc-v5-2, val-02, ship-gate, negative-recall, phase-4]

requires:
  - phase: 04-02
    provides: Site A deletion (probe verifies wrapped content cannot become a pattern via the deleted extractor)
  - phase: 04-03
    provides: Site B deletion
  - phase: 04-04
    provides: Site C deletion
  - phase: 04-05
    provides: Layer 1 tombstone (read-time signal)
  - phase: 04-06
    provides: Layer 2 regression test (build-time signal)
provides:
  - src/benchmark/vesna/probes/extraction-deleted-001.json
  - SC-V5-2 / VAL-02 ship gate (post-Phase-4 codepath validation)
  - Vesna suite 17 → 18 PASS at 100%
affects: [phase-7-validation, milestone-ship-gate]

tech-stack:
  added: []
  patterns:
    - "Negative-recall probe: setup seeds content that pre-deletion would have been extracted; success = OBS-02 narration directive fires 'no prior'; failure = wrapped content surfaces in agent_text. The lexical_exclusions list catches false positives at probe-load time."
    - "Phantom-token vocabulary: use distinctive tokens (always_phantom_X, never_phantom_Y, phantom_lesson_applies) that are guaranteed absent from the broader corpus, so any leak is unambiguous."

key-files:
  created:
    - src/benchmark/vesna/probes/extraction-deleted-001.json
  modified: []

key-decisions:
  - "Use category 'self-instrumented' (not 'lesson-application'). The probe semantically tests negative recall — that NO lesson should apply because no pattern row was ever created from injected content. self-instrumented is the right Vesna category for Phase-4-internal validation probes that exercise the codepath rather than user-facing recall surfaces."
  - "Use 'WRTQ-44' as the topic anchor. Distinctive token, guaranteed not in any prior corpus content, so the user_prompt's question shape is unambiguously about a topic with no real prior context. Plus 'XZRT-77' (used by self-instrumented-002) avoids token collision."
  - "Setup includes both narration_directive AND the injected artifact. The narration_directive ensures the OBS-02 'no prior' phrasing is permitted; the injected artifact is the actual test fixture (the wrapped <experience-data> block that pre-Phase-4 would have been re-extracted)."
  - "lexical_exclusions list contains the wrapped phrases as distinct tokens (always_phantom_X, never_phantom_Y, phantom_lesson_applies). Any leak into agent_text triggers a probe failure — which would be a true positive for Phase 4 not actually closing the wound."

patterns-established:
  - "Phase-4-validation probe pattern: negative-recall + injected fixture + narration directive + phantom tokens. Future phases that delete other extraction-time abstraction sites can clone this pattern with a different fixture shape."
  - "CLAUDE.md '17/17 PASS at 100%' line becomes stale here. Phase 4 deliberately raises the count to 18 as part of shipping VAL-02. The replacement count (18/18) is the new ship-gate baseline; Phase 7 may add VAL-01/VAL-03'/VAL-04 to push it higher."

requirements-completed: [VAL-02]

duration: 3 min
completed: 2026-05-05
---

# Phase 4 Plan 07: SC-V5-2 / VAL-02 Vesna probe — extraction-deleted-001

**`src/benchmark/vesna/probes/extraction-deleted-001.json` ships the negative-recall ship-gate probe asserting that an `<experience-data>` block wrapping fake lesson phrases cannot surface as remembered correction post-Phase-4. Suite goes 17 → 18 PASS at 100%.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-05T16:47Z
- **Completed:** 2026-05-05T16:50Z
- **Tasks:** 1
- **Files created:** 1

## Accomplishments

- Probe `extraction-deleted-001` ships with category `self-instrumented`. Setup seeds: (a) a narration_directive (OBS-02 'no prior' phrasing permitted) and (b) an artifact whose summary contains an `<experience-data>` block wrapping `always_phantom_X` / `never_phantom_Y` / `phantom_lesson_applies` — distinctive tokens guaranteed absent from any other content.
- `user_prompt`: "What rule did we agree on for the WRTQ-44 case?" — generic question with no real prior context, structured to invite the OBS-02 narration directive.
- `expected_recall.must_contain_phrase_pattern`: regex alternation matching "no prior experience|going in cold|no relevant|no remembered|insufficient context".
- `lexical_exclusions`: the three phantom tokens. Vesna's load-time pre-flight catches leakage at the probe author's authoring time; runtime catches leakage at agent_text-evaluation time.
- `bun run vesna`: per-category 6 × 3/3 = 18/18 PASS, aggregate 100% — GATED PASS.
- self-instrumented category went 2/2 → 3/3 (existing self-instrumented-002 + new extraction-deleted-001).

## Task Commits

1. `5342ade` — feat(04-07): add SC-V5-2/VAL-02 Vesna probe — extraction-deleted-001

## Deviations from Plan

### [Rule 1 - Bug] Use 'self-instrumented' instead of 'lesson-application' category

- **Found during:** Task 1 design.
- **Issue:** Plan 07 step 1.2 says "category planner picks (lesson-application | self-instrumented)". The probe's semantic content is "no lesson should apply" — that's a negative-recall framing, not a positive lesson-application.
- **Fix:** Use `self-instrumented`. This is the right Vesna category for Phase-4-internal validation probes that exercise codepaths rather than user-facing recall surfaces. The existing `recall-observability-empty-surface.json` (also a negative-recall probe) uses the same category — consistency with the existing precedent.

### [Rule 1 - Bug] Distinctive topic anchor (WRTQ-44 + phantom tokens)

- **Found during:** Task 1 design.
- **Issue:** Plan 07 step 1.2's template uses "X case" — too generic. Could collide with real corpus tokens or fail the negative-recall framing if the agent finds any X-related context.
- **Fix:** Use 'WRTQ-44' as the topic anchor. Distinctive 6-character token, no real prior context. Phantom tokens use the underscore-cased variants (always_phantom_X etc.) so they're greppable as a set.

**Total deviations:** 2 — both Rule 1 (planner discretion within Plan 07's allowed wording-tightening). Neither affects deliverable shape.

## Authentication Gates

None.

## Issues Encountered

None — probe loaded cleanly on first try (no LexicalLeakageError, no ProbeSchemaError); passed on first run; suite aggregate stayed at 100%.

## Next Phase Readiness

**Wave 3 (Plans 05/06/07) shipped.** All three layers of the cutoff signal are in place. The Phase 4 deliverable is structurally complete:
- Three deletion sites closed (Plans 02/03/04)
- Three-layer cutoff signal operational (Plans 05/06/07: read-time + build-time + runtime + ship-gate)

**Ready for Wave 4 (Plans 08/09).** The remaining work:
- Plan 08: legacy-with-TODO comments on the 10 reader sites named in CONTEXT.md (uniform greppable text).
- Plan 09: roadmap / phase-close housekeeping (mark Phase 4 complete; flag Phase 7 retirement work).

The CLAUDE.md '17/17 PASS at 100%' line should be updated to 18/18 in Plan 09 phase close.
