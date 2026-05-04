---
phase: 01-episode-substrate
plan: 04
subsystem: testing
tags: [episode-substrate, integration-test, mem0-trap, structural-impossibility, operator-readme]

requires:
  - phase: 01-01
    provides: V25 schema with closed-enum provenance CHECK
  - phase: 01-02
    provides: dualWriteUserPrompt + dualWriteAssistantMessage + parseWrappers
  - phase: 01-03
    provides: writeToolResult + writeEnvironmentalEvent + environmental audit doc
provides:
  - End-to-end integration test exercising every requirement EPI-01..EPI-07 in named-by-ID test cases
  - Stub-extractor proof at the integration level — Phase 4's reduced-extractor preview, structurally cannot leak wrapper or tool-result content
  - Operator-facing substrate README with schema reference, provenance semantics, write-path map, telemetry signal, MUST-NOT prohibitions
  - Wrapper-parser fix for fully-wrappers input (organic = '' instead of unstripped text) discovered during integration testing
affects: [phase-2, phase-3, phase-4, phase-6, phase-7]

tech-stack:
  added: []
  patterns:
    - "Phase-level integration tests called by EPI-* requirement ID — single grep returns the phase's coverage map for downstream verifiers"
    - "Hand-curated diversity-set fuzz instead of fast-check property-based testing — 12 fixtures span the substrate's invariant space without adding a test framework dependency"

key-files:
  created:
    - src/tests/integration/phase-1-episode-substrate.test.ts
    - src/tests/integration/phase-1-extractor-stub.test.ts
    - .planning/phases/01-episode-substrate/01-04-substrate-readme.md
  modified:
    - src/extraction/wrapper-parser.ts
    - src/tests/extraction/wrapper-parser.test.ts

key-decisions:
  - "Hand-curated fuzz fixture array (12 inputs) over fast-check property-based testing — Phase 1 doesn't need a new dep; the diversity is sufficient for EPI-07 at integration level"
  - "Stub-extractor lives in tests/integration/, NOT in production code — the function is a preview of what Phase 4 will look like, not yet a real reader"
  - "Substrate README links to 01-03-environmental-audit.md rather than duplicating the deferred-sites table — single source of truth"

patterns-established:
  - "Test name format: 'EPI-NN[+EPI-MM]: short description' — `bun run test --grep EPI-` returns the phase's full coverage map across helper-level + integration files"

requirements-completed: [EPI-07]

duration: 6 min
completed: 2026-05-04
---

# Phase 1 Plan 04: Integration tests + stub-extractor proof + substrate README

**End-to-end test exercises the full turn cycle (UserPromptSubmit → PostToolUse → Stop → environmental boundaries); stub-extractor proves the Mem0 trap is structurally impossible across diverse inputs; substrate README is the operator-facing contract document Phase 2-7 read first.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-04T21:17:52Z
- **Completed:** 2026-05-04T21:23:32Z
- **Tasks:** 2
- **Files created/modified:** 5 (3 created, 2 modified)

## Accomplishments

- **End-to-end integration test** at `src/tests/integration/phase-1-episode-substrate.test.ts` (8 scenarios). Each test name starts with the EPI requirement ID(s) it covers, so `bun run test --grep "EPI-"` returns the substrate's full coverage. Coverage:
  - Clean turn (no injection) → 1 organic prompt + 1 tool_result + 1 organic assistant_message.
  - 3 wrappers → 1 organic + 3 injected, parent-linked, in document order.
  - EPI-07 Mem0 trap at integration level (organic-filtered SELECT cannot return wrapper content under the full turn cycle).
  - Tool_result containing wrapper-tag strings is verbatim in tool_result row but invisible to organic SELECTs.
  - tool_input visible in metadata_json.
  - Legacy conversation_turns preserved with raw prompt + assistant_text.
  - Environmental events excluded from `WHERE turn_number IS NOT NULL` queries.
  - Atomicity: rollback yields zero conversation_turns delta + zero episodic delta + exactly one telemetry row.
- **Stub-extractor proof** at `src/tests/integration/phase-1-extractor-stub.test.ts` (4 tests). The `stubExtractor(db, sessionId): string[]` function is a preview of Phase 4's reduced extractor — it reads ONLY `provenance='organic'` content. The tests prove that:
  - Across 12 hand-curated diverse fixtures (plain prompts, single wrappers, three-wrapper concatenations, attribute-rich wrappers, duplicate tags, empty bodies, mixed organic/wrapper, all 9 known tags, surrounding whitespace, tool-output pollution), stubExtractor never returns wrapper or tool-output markers.
  - Tool results polluted with `INJECTED CONTENT`, `<system-reminder>`, `WRAPPER_INTERNAL`, etc. are invisible to stubExtractor.
  - Mass scale (50 turns of mixed wrappers + tool calls) yields exactly 100 organic strings (50 user_prompt + 50 assistant_message), none containing wrapper tags.
  - Even an attacker who tries to smuggle data through wrappers + tool_input + tool_result cannot leak it into the organic-extractor output.
- **Operator-facing substrate README** at `.planning/phases/01-episode-substrate/01-04-substrate-readme.md`. Required sections present:
  - Schema reference (13-column table + index list).
  - Provenance semantics for each of the four closed-enum values + reader hints.
  - Write-path map (per-hook helper + row count).
  - Telemetry signal (event_kind + detail JSON shape + Angel surfacing query).
  - 7 MUST-NOT prohibitions for future phases.
  - Pointer to `01-03-environmental-audit.md` for the canonical environmental-surface map (no duplication).
- **Wrapper-parser fix** discovered during integration testing: when input is concatenated wrappers with no separator, organic must be `''` (empty), not the unstripped original. Added a regression test to `wrapper-parser.test.ts`.

## Task Commits

1. **Task 1: End-to-end integration test** - `4f83fe7` (test)
2. **Task 2: Stub-extractor proof + substrate README** - `4ed64e8` (test)
3. **Wrapper-parser regression fix** discovered during Task 2 - `3f8f89f` (fix)

## Files Created/Modified

- `src/tests/integration/phase-1-episode-substrate.test.ts` *(created)* - 8 EPI-tagged scenarios end-to-end.
- `src/tests/integration/phase-1-extractor-stub.test.ts` *(created)* - 4 tests proving stub-extractor cannot leak wrapper/tool content.
- `.planning/phases/01-episode-substrate/01-04-substrate-readme.md` *(created)* - operator-facing substrate contract document.
- `src/extraction/wrapper-parser.ts` *(modified)* - track `matched` flag so concatenated-wrappers input yields organic=''.
- `src/tests/extraction/wrapper-parser.test.ts` *(modified)* - add regression test asserting organic='' on concatenated-wrappers input.

## Coverage map (`bun run test --grep "EPI-"`)

| Requirement | Helper-level (Plan 02/03) | Integration-level (Plan 04) |
|---|---|---|
| EPI-01 schema shape + idempotency | `schema-migration.test.ts` × 5 | `phase-1-episode-substrate.test.ts` × 1 |
| EPI-02 closed-enum CHECK | `schema-migration.test.ts` × 2 | (covered structurally by EPI-01..07 tests) |
| EPI-03 dual-write atomicity + tool/environmental | `dual-write-stop.test.ts` × 1, `dual-write-tool-result.test.ts` × 1, `environmental-events.test.ts` × 7 | `phase-1-episode-substrate.test.ts` × 2 |
| EPI-04 wrapper split | `wrapper-parser.test.ts` × 12, `dual-write-user-prompt.test.ts` × 4, `dual-write-stop.test.ts` × 1 | `phase-1-episode-substrate.test.ts` × 2, `phase-1-extractor-stub.test.ts` × 4 |
| EPI-05 metadata_json visibility | `dual-write-tool-result.test.ts` × 1 | `phase-1-episode-substrate.test.ts` × 1 |
| EPI-06 legacy conversation_turns preserved | `schema-migration.test.ts` × 1, `dual-write-user-prompt.test.ts` × 1 | `phase-1-episode-substrate.test.ts` × 1 |
| EPI-07 Mem0 trap structurally impossible | `dual-write-user-prompt.test.ts` × 1 | `phase-1-episode-substrate.test.ts` × 2, `phase-1-extractor-stub.test.ts` × 4 |

Total Phase 1 EPI-tagged tests: **>40 across 7 files**.

## Decisions Made

- **Hand-curated 12-fixture diversity set** rather than fast-check property-based testing. Phase 1 doesn't need a new dep; the curated fixtures span enough of the invariant space to prove EPI-07 at the integration level.
- **stubExtractor lives in tests, not production.** It's a preview of what Phase 4's reduced extractor will look like. Putting it in `src/extraction/` would be premature — Phase 4 might pick a different signature. The test file is the single canonical preview.
- **README links to environmental-audit doc** instead of duplicating the deferred-sites table. Single source of truth.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Wrapper-parser failed for fully-wrappers input (organic returned the unstripped text)**
- **Found during:** Task 2 (stub-extractor proof first run).
- **Issue:** When input is concatenated wrappers with no separator (e.g. `<system-reminder>SR</system-reminder><experience-data>EXP</experience-data>`), the parser correctly extracted both injected blocks but the organic field returned the original unstripped text. The fallback `strippedParts.length > 0 ? join : text` returned `text` whenever the loop matched but produced no intervening organic spans — incorrectly treating "fully-stripped" as "no matches".
- **Fix:** Added a `matched` boolean flag that flips on the first regex match. Organic = `matched ? join(strippedParts) : text` then trim.
- **Files modified:** `src/extraction/wrapper-parser.ts`, `src/tests/extraction/wrapper-parser.test.ts`
- **Verification:** New regression test in wrapper-parser.test.ts (`'concatenated wrappers with no separator -> organic is empty (regression)'`) asserts organic = `''`. All 12 parser tests pass; all 12 integration substrate tests pass; full episodic-events suite (43 tests) green.
- **Commit hash:** `3f8f89f`

---

**Total deviations:** 1 auto-fixed (bug-class, real defect uncovered by integration testing).
**Impact on plan:** This is exactly the kind of bug that helper-level tests with separator-rich fixtures wouldn't catch — Plan 02 fixtures all had `middle`/`tail` text between wrappers. The integration test explicitly fed concatenated wrappers, surfacing the defect. Fix is minimal and adds a regression test. No scope creep.

## Issues Encountered

None directly tied to Plan 01-04. The 27 pre-existing full-suite failures (`llama-client.test.ts`, `llama-server-supervisor.test.ts`, `phase-5-full-gate.test.ts`) remain unchanged.

## Vesna ship-gate

`bun run vesna` after Plan 01-04 commits: **17/17 PASS at 100%** — `entity-recall 3/3, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 2/2`. Phase 1 substrate writes are write-only; the existing read path is unchanged, and the v4 ship gate continues to pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

**Phase 1 is complete.** All four plans shipped:
- 01-01: V25 schema migration (`cf6bfaf` + `99b5675` + `4d08d12`).
- 01-02: wrapper-parser + dual-write user/assistant + telemetry CHECK extension (`37bff87` + `a0ad303` + `49d2ed7` + `d841b3e`).
- 01-03: tool_result + environmental write paths + audit (`b9f6b73` + `b4113ea` + `9811f35`).
- 01-04: integration tests + stub-extractor proof + substrate README (`3f8f89f` + `4f83fe7` + `4ed64e8`).

The substrate is empty by design (no backfill, no readers). Phase 2 (multi-modal index seeds + density-at-scale check) can start immediately. Phase 2 should:

1. Read `01-CONTEXT.md` first for the substrate design rationale.
2. Read `01-04-substrate-readme.md` for the contract.
3. Read `01-03-environmental-audit.md` for the deferred-environmental-sites map.
4. Pick ONE multi-modal index candidate (error-fingerprint, affect signal, or structural shape) and measure recall improvement at Claudex's scale before committing to N indexes.
5. Build the chosen index from `episodic_events.metadata_json` — no ALTER TABLE on the substrate.
6. Backfill the index from rows accumulated since Phase 1 ship (small corpus is preferable to corrupted corpus).

---
*Phase: 01-episode-substrate*
*Plan: 04*
*Completed: 2026-05-04*
*Phase 1 SHIPPED.*
