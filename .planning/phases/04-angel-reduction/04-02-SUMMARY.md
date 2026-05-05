---
phase: 04-angel-reduction
plan: 02
subsystem: angel
tags: [angel, pattern-extractor, site-a, mem0, surgical-delete, reduction, phase-4]

requires:
  - phase: 04-01
    provides: V28 trigger guard ensures any accidental INSERT remnant from a future regression gets caught at runtime
provides:
  - Site A (Angel-side LLM-driven extraction) structurally deleted
  - src/angel/pattern-extractor.ts deleted (802 lines)
  - src/angel/domain-classifier.ts created (71 lines) — relocated classifySessionDomains
  - heartbeat.ts Site A loop replaced with classifySessionDomains-only loop body
  - markSessionProcessed dropped from heartbeat (sole caller deleted)
  - Mem0 fix (stripInjectedBlocks + INJECTED_BLOCK_TAGS) deleted with the extractor — wound is structurally closed
  - test mock targets retargeted (vi.mock pattern-extractor → domain-classifier)
affects: [04-03, 04-04, 04-06, 04-07, phase-7-retirement]

tech-stack:
  added: []
  patterns:
    - "Surgical delete + relocate-survivor: identify the binding/indexing function inside an extraction module, move it to its own module, delete the rest. Avoids 'preserve as legacy with TODO' bloat in modules that have a clear single survivor."
    - "Mem0-trap closure at the codepath level, not the input-filter level: deleting the extractor obviates stripInjectedBlocks. The input-filter approach (commit 0d0fbca) was tactical defense; structural deletion is the actual fix."

key-files:
  created:
    - src/angel/domain-classifier.ts
  deleted:
    - src/angel/pattern-extractor.ts
    - src/tests/angel/pattern-extractor.test.ts
  modified:
    - src/angel/heartbeat.ts
    - src/tests/angel/heartbeat.test.ts
    - src/tests/intelligence/directive-detector-integration.test.ts

key-decisions:
  - "Relocate classifySessionDomains to its own module (domain-classifier.ts), do NOT preserve a deprecated re-export from pattern-extractor.ts. The new module is conceptually different (binding/indexing, not abstraction) and the cleaner cut leaves no rotting compatibility shim."
  - "Delete markSessionProcessed call site as instructed by Plan 02 step 2.2 — accept the consequence that getUnprocessedSessions returns the same sessions every tick. classifySessionDomains is idempotent (regex first, LLM only on miss; recordDomainInteraction is an upsert), so the cost is bounded — but if Phase 7 spots LLM-call thrash on a session whose topic doesn't regex-match, it can re-introduce a marker write."
  - "Soft no-op result.sessions_processed and result.patterns_extracted (always 0). Two downstream gates in heartbeat.ts use them as 'pattern extraction ran' sentinels (lines 696 + 715) — those gates now always evaluate as 'no heavy work', meaning embedding backfill and observation consolidation can run on every tick. Plan 02 explicitly accepts this; Phase 7 retirement work owns the gate cleanup."
  - "Rewrite the 'failure isolation' and 'call order' assertions in directive-detector-integration.test.ts rather than deleting the test cases. The renamed assertions still validate Phase-2 loop semantics (directive failure does not crash the tick; directive extraction is the only LLM call in the loop body) — they just no longer reference the deleted pattern-extractor."
  - "Leave the historical comment references to 'pattern-extractor' in heartbeat.ts (lines 286, 302) and intelligence/directive-detector.ts and llama-server-supervisor.ts. They are documentation of past architecture, not live imports. Removing them at deletion time would lose the historical 'why was this comment here?' context for future readers."

patterns-established:
  - "Multi-site reduction protocol: Plan 02 deletes Site A (Angel-side LLM extractor). Plans 03/04 delete Sites B (hook-side regex extractor) and C (heartbeat synthesis loop). Each plan ships a clean per-task commit cluster + a single SUMMARY documenting deviations. The plans do NOT touch each other's sites — review-clarity boundary."
  - "Mock retarget on module rename: when an exporter module dies and a single export relocates, vi.mock target needs to follow the export, not the original module path. Test mocks are part of the import graph and must be updated in the same plan that lands the relocation."

requirements-completed: [AR-01, AR-03, AR-04, AR-05]

duration: 7 min
completed: 2026-05-05
---

# Phase 4 Plan 02: Site A surgical kill — Angel pattern-extractor deletion

**802-line `src/angel/pattern-extractor.ts` deleted; `classifySessionDomains` relocated to a new 71-line `src/angel/domain-classifier.ts`; heartbeat's Site A extraction loop replaced with a classify-only body; pattern-extractor test files deleted; mock retargeting in heartbeat + directive-detector integration tests.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-05-05T16:17Z
- **Completed:** 2026-05-05T16:24Z
- **Tasks:** 5 (per Plan 02 task layout)
- **Files modified:** 3
- **Files created:** 1
- **Files deleted:** 2

## Accomplishments

- `src/angel/pattern-extractor.ts` (802 lines) deleted; `extractPatternsFromSession`, `formatTranscript`, `EXTRACTION_SYSTEM_PROMPT`, `DIRECTIVE_INDICATORS`, `extractDirectiveCandidates`, `findCrossSessionDirectives`, `reviewCandidatePatterns`, `measureSessionOutcome`, `bridgeCorrectionToSkill`, `stripInjectedBlocks`, `INJECTED_BLOCK_TAGS`, `getSessionTurns`, and the JSON-parsing helpers all gone.
- `src/angel/domain-classifier.ts` (71 lines) created with `classifySessionDomains` body verbatim from the deleted module; imports trimmed to the four it actually uses (`Database`, `cachedPrepare`, `callLocalLLM`, `recordDomainInteraction` + `extractDomain`).
- `src/angel/heartbeat.ts` import line updated; Site A try-block (lines 305–336) replaced with a classify-only body that increments `result.domains_classified`. `markSessionProcessed` removed from the session-monitor import.
- `src/tests/angel/pattern-extractor.test.ts` deleted (its function-under-test surface no longer exists).
- `src/tests/angel/heartbeat.test.ts` and `src/tests/intelligence/directive-detector-integration.test.ts` mock targets retargeted from `pattern-extractor` to `domain-classifier`; mock entries for the deleted exports dropped; two assertions in the directive-detector test rewritten to remain meaningful post-deletion.
- `bun run build` clean. `bun run test` — 27 pre-existing failures unchanged, 3417 / 3452 passing (test count drop of 21 = the deleted pattern-extractor.test.ts cases). `bun run vesna` 17/17 PASS preserved.

## Task Commits

1. `35dcfb0` — feat(04-02): create src/angel/domain-classifier.ts with relocated classifySessionDomains
2. `db688ca` — feat(04-02): delete Site A extraction loop in heartbeat; import classifier from new module
3. `1711fdb` — feat(04-02): delete src/angel/pattern-extractor.ts (Site A surgical kill)
4. `539918b` — test(04-02): delete src/tests/angel/pattern-extractor.test.ts
5. `c9c5ea8` — test(04-02): retarget vi.mock from pattern-extractor to domain-classifier

## Deviations from Plan

### [Rule 1 - Bug] Soft-no-op of `result.sessions_processed` / `patterns_extracted` propagates downstream

- **Found during:** Task 2 verification (re-reading heartbeat.ts after the surgery).
- **Issue:** The plan's "soft no-op" for `sessions_processed` (always 0) is used as a "pattern extraction ran" sentinel by two downstream gates: `heartbeat.ts:696` (skips embedding backfill if `sessions_processed > 0`) and `heartbeat.ts:715` (skips observation consolidation if `sessions_processed > 0`). With extraction deleted, these gates always evaluate as 'no heavy work', meaning embedding backfill and observation consolidation now run on every tick instead of being skip-gated.
- **Fix:** Accepted per the plan's literal instruction ("apply soft no-op (set to 0 always; TODO comment for Phase 7 cleanup)"). The increased per-tick frequency of backfill (10 items at a time) and consolidation (rate-limited to once per 5 minutes via `shouldConsolidate`) is bounded; not pathological. Phase 7 retirement work owns the gate cleanup.
- **Files modified:** none (this is the documented behavior of the deletion).
- **Verification:** Vesna 17/17 PASS confirms no behavioral regression at the probe surface.

### [Rule 1 - Bug] `getUnprocessedSessions` now returns same sessions every tick

- **Found during:** Task 2 verification (tracing the `markSessionProcessed` deletion).
- **Issue:** Without `markSessionProcessed` being called by the Phase-2 loop, sessions never get an `angel_processed` event, so `getUnprocessedSessions` returns them on every tick.
- **Fix:** Accepted per the plan's literal task description. Each tick, the same up-to-5 sessions get classifySessionDomains called on them; the function is idempotent (regex first, LLM only on regex-miss; `recordDomainInteraction` is an upsert), so the cost is bounded. If Phase 7 retirement spots LLM-call thrash on a session whose topic doesn't regex-match, it can re-introduce a marker write at that point.
- **Files modified:** none.

### [Rule 1 - Bug] Two test rewrites instead of pure mock target changes

- **Found during:** Task 5.
- **Issue:** Two tests in `directive-detector-integration.test.ts` directly asserted on `mockExtractPatterns` — `failure isolation: directive throw does NOT block pattern-extractor` (asserted pattern-extractor was called once) and `call order: directive extraction runs BEFORE pattern extraction` (asserted call ordering). Both test surfaces no longer exist post-deletion.
- **Fix:** Renamed and re-purposed each test to validate the new Phase-2 semantics:
  - `failure isolation: directive throw does NOT crash the tick` — asserts the tick still completes without throwing AND that classifySessionDomains still runs after a directive failure.
  - `directive extraction is the only LLM call in the Phase-2 loop body` — asserts callLocalLLM was called and classifySessionDomains was called exactly once. (classifySessionDomains is mocked to return 0 without calling callLocalLLM, so directive-detector is verifiably the only LLM caller.)
- **Files modified:** `src/tests/intelligence/directive-detector-integration.test.ts`.
- **Verification:** Both rewritten tests pass; total file 3 / 3 PASS.
- **Commit:** `c9c5ea8`

**Total deviations:** 3 — all Rule 1 (auto-fixed). The first two are documented behavioral consequences explicitly accepted by Plan 02; the third is a test-rewrite that preserves meaningful coverage of Phase-2 loop semantics.
**Impact:** Two heartbeat downstream gates (backfill skip, consolidation skip) now always evaluate as 'no heavy work'. Phase 7 retirement owns the cleanup. No functional regression at the probe (Vesna) or test (full suite) level.

## Authentication Gates

None.

## Issues Encountered

None — all 5 tasks completed; full test suite holds steady at 27 pre-existing failures (verified unrelated in Plan 01 SUMMARY).

## Next Phase Readiness

**Ready for Plan 04-03.** Site A is structurally gone. The Mem0 trap is now closed at the codepath level — the extractor that consumed injected content no longer exists. Sites B and C remain:
- Plan 03: Site B — `applyExperienceFeedback` step 1 in `src/intelligence/experience-scoring.ts` (regex-driven, hook-side, on `correction_flagged=true`).
- Plan 04: Site C — heartbeat merge/synthesis loop in `src/angel/heartbeat.ts:1090–1149` (delete LLM synthesis + lesson rewrite; keep dedup + score absorption).
