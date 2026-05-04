---
phase: 01-episode-substrate
plan: 02
subsystem: database
tags: [episode-substrate, provenance, dual-write, wrapper-parser, mem0-trap, telemetry]

requires:
  - phase: 01-01
    provides: V25 episodic_events table + closed-enum provenance CHECK constraint
provides:
  - parseWrappers — single source of truth for splitting user prompts into organic + injected
  - dualWriteUserPrompt — single-transaction dual-write of conversation_turns + organic + N injected episodic rows
  - dualWriteAssistantMessage — single-transaction dual-write of conversation_turns UPDATE/INSERT + organic assistant_message episodic row
  - episodic_write_failure event_kind extension to telemetry CHECK enum
  - lifecycle.ts shim that routes legacy storeConversationTurn family through the dual-write helpers (external signatures unchanged)
  - EPI-07 structural Mem0-trap-impossibility proof at the helper level
affects: [01-03, 01-04, phase-3, phase-4]

tech-stack:
  added: []
  patterns:
    - "Provenance-as-row-attribute split at write time: each wrapper produces its own injected row with parent_event_id linkage; readers filter with a single WHERE clause"
    - "Telemetry-on-rollback: db.transaction() catches throws, single telemetry row written outside the transaction so the failure is queryable even when the writes are not"
    - "Wrapper parser regex source = KNOWN_WRAPPER_TAGS.join('|'): the tag list is the single source of truth, no duplicate regex spelling"

key-files:
  created:
    - src/extraction/wrapper-parser.ts
    - src/core/episodic-events.ts
    - src/tests/extraction/wrapper-parser.test.ts
    - src/tests/adapters/episodic-events/dual-write-user-prompt.test.ts
    - src/tests/adapters/episodic-events/dual-write-stop.test.ts
  modified:
    - src/adapters/cc-hooks/user-prompt-submit.ts
    - src/adapters/shared/lifecycle.ts
    - src/core/migration-steps.ts
    - src/core/schema.ts

key-decisions:
  - "Bundle telemetry CHECK enum extension into the V25 migration rather than spawning V26: keeps Phase 1 substrate as one logical migration, mirrors V20/V21 'enum-extension' pattern"
  - "lifecycle.ts shim approach (option a) over alt-helpers (option b): callers in user-prompt-submit.ts and stop.ts require zero edits; dual-write becomes invisible to surrounding code"
  - "Assistant text is NEVER passed through parseWrappers — parser is only for user prompts. Assistant output is the LLM's own text, treated as raw organic"
  - "dualWriteAssistantMessage's parent_event_id stays NULL in Phase 1 — Phase 4 (Angel reduction) revisits when tool_call->tool_result chain becomes load-bearing"

patterns-established:
  - "Episodic writer pattern: db.transaction(closure)() wraps all rows; on throw the catch path emits one telemetry row OUTSIDE the transaction (so it survives rollback) and re-throws"
  - "Telemetry-CHECK extension migration: rename + DROP indexes + db.exec(TELEMETRY_SCHEMA) + INSERT-SELECT + DROP old; idempotency probe via sqlite_master.sql substring match"
  - "Wrapper parser regex: literal source = KNOWN_WRAPPER_TAGS.join('|'); flags = /gi; dotall = [\\s\\S]*?; attribute capture = (\\s[^>]*)?"

requirements-completed: [EPI-03, EPI-04, EPI-07]

duration: 10 min
completed: 2026-05-04
---

# Phase 1 Plan 02: Wrapper-parser + dual-write substrate

**parseWrappers becomes the single source of truth for organic-vs-injected splitting; dualWriteUserPrompt + dualWriteAssistantMessage land the substrate's defining property — Mem0 trap structurally impossible — at the helper level via single-transaction dual-write with telemetry-on-rollback.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-05-04T21:00:04Z
- **Completed:** 2026-05-04T21:09:44Z
- **Tasks:** 3
- **Files modified:** 9 (5 created, 4 modified)

## Accomplishments

- **`parseWrappers`** — locked KNOWN_WRAPPER_TAGS list (9 tags), case-insensitive + dotall regex built from the tag list, returns `{ organic, injected[] }` with attribute strings captured. Replaces the inline regex at `user-prompt-submit.ts:266`.
- **`dualWriteUserPrompt`** — single-transaction dual-write: legacy `conversation_turns` row (raw prompt) + organic `episodic_events` row (wrapper-stripped) + N injected `episodic_events` rows linked via `parent_event_id`. Source for injected rows is `wrapper:<tag>`; metadata_json carries `{ tag, attributes }`.
- **`dualWriteAssistantMessage`** — single-transaction dual-write: UPDATE the latest `conversation_turns` row whose `assistant_text` IS NULL (the v4 split-write happy path) OR INSERT a fresh row (fallback) + INSERT one organic `assistant_message` episodic row.
- **Telemetry-on-rollback** — every helper catches throws inside its transaction, emits one telemetry row with `event_kind='episodic_write_failure'` carrying `{ hook, attempted_rows, organic_id, error_message, error_stack }`, and re-throws. The telemetry row commits even when the dual-write rolls back because it's written outside the transaction.
- **Telemetry CHECK enum extension** — V25 migration now ALSO rebuilds the telemetry table to admit `'episodic_write_failure'`, mirroring the V19→V20 reranker_fallback pattern. Idempotent via `telemetryAcceptsEpisodicWriteFailure` probe.
- **Lifecycle shim** — `storeConversationTurn` / `storeConversationTurnUserText` / `updateConversationTurnAssistant` route through the helpers internally. External signatures unchanged (still non-throwing void/boolean). Hook call sites at `user-prompt-submit.ts:154` and `stop.ts:155-161` require zero edits.
- **EPI-07 proof** — dedicated test in `dual-write-user-prompt.test.ts` named `'EPI-07: Mem0 trap is structurally impossible — organic-filtered SELECTs never return wrapper content'`. The test is greppable for the structural-impossibility claim audit.
- **15 dual-write tests + 11 wrapper-parser tests** — all pass; full vitest suite delta is +15 passing tests, 0 new regressions (27 pre-existing failures unchanged).

## Task Commits

Each task was committed atomically:

1. **Task 1: Wrapper parser as shared module** - `37bff87` (feat)
2. **Task 2: Episodic write helpers + dual-write transaction + telemetry CHECK extension** - `a0ad303` (feat)
3. **Task 3: Dual-write + EPI-07 structural-impossibility tests** - `49d2ed7` (test)

## Files Created/Modified

- `src/extraction/wrapper-parser.ts` *(created)* - parseWrappers + KNOWN_WRAPPER_TAGS + WrapperBlock/ParsedWrappers types.
- `src/core/episodic-events.ts` *(created)* - dualWriteUserPrompt + dualWriteAssistantMessage + Provenance type + telemetry-on-rollback helpers.
- `src/tests/extraction/wrapper-parser.test.ts` *(created)* - 11 tests covering parser contract.
- `src/tests/adapters/episodic-events/dual-write-user-prompt.test.ts` *(created)* - 10 tests including the EPI-07 trap proof.
- `src/tests/adapters/episodic-events/dual-write-stop.test.ts` *(created)* - 5 tests covering UPDATE/fallback paths and atomicity.
- `src/adapters/cc-hooks/user-prompt-submit.ts` *(modified)* - inline strip regex at line 266 replaced by `const { organic: userText } = parseWrappers(prompt)`.
- `src/adapters/shared/lifecycle.ts` *(modified)* - `storeConversationTurn` family routes through dual-write helpers; sha256 helper added; mirror INSERT into episodic_events from `updateConversationTurnAssistant` to keep it in the same transaction as the legacy UPDATE.
- `src/core/migration-steps.ts` *(modified)* - extend `migrateV24toV25` to also rebuild telemetry with the new enum value (rebuild-and-copy, idempotent via probe).
- `src/core/schema.ts` *(modified)* - add `'episodic_write_failure'` to the `TELEMETRY_SCHEMA` CHECK enum.

## Wrapper Parser Contract (for Plan 03 / Phase 3 reference)

```ts
parseWrappers(text: string): {
  organic: string;            // Original text with all wrapper blocks removed AND trimmed.
  injected: WrapperBlock[];   // One per wrapper found, in document order.
}

// WrapperBlock
{
  tag: string;            // Lowercased; one of KNOWN_WRAPPER_TAGS
  content: string;        // Inner text, NOT including the tags
  attributes?: string;    // Raw attribute string from opening tag (no leading whitespace), or undefined
}

// KNOWN_WRAPPER_TAGS (locked v5.0)
[
  'task-notification', 'system-reminder', 'experience-data',
  'local-command-caveat', 'command-message', 'command-name',
  'command-args', 'local-command-stdout', 'file-content',
]
```

Adding a new tag here is a substrate change. Phases 2/3 surface new modalities via `metadata_json` on existing provenance values, NOT by widening this enum.

## Dual-Write Helper API (for Plan 03 reference)

```ts
dualWriteUserPrompt(
  db: Database,
  sessionId: string,
  project: string,
  rawPrompt: string,
): { turnNumber: number; organicId: number | null; injectedCount: number }

dualWriteAssistantMessage(
  db: Database,
  sessionId: string,
  project: string,
  assistantText: string,
): { turnNumber: number; episodicId: number; updatedLegacy: boolean }
```

Both helpers throw on DB failure (caller-friendly: tests assert atomicity). Both write one telemetry row on rollback before re-throwing.

## Telemetry detail JSON shape (operational judgment per CONTEXT.md)

```json
{
  "hook": "user-prompt-submit" | "stop",
  "attempted_rows": <int>,
  "organic_id": <int | null>,
  "error_message": "<first 500 chars of err.message>",
  "error_stack": "<first 5 lines of err.stack>"
}
```

Plan 03 should match this shape for tool-result + environmental writers and add `tool` (toolName) for tool_result failures and `kind: 'environmental'` for environmental failures.

## Rollback semantics (locked for Plan 03 to match)

1. `db.transaction(() => { ... })()` wraps ALL legacy + episodic INSERTs/UPDATEs.
2. Any throw inside rolls back the transaction (better-sqlite3 closure form).
3. The catch path runs OUTSIDE the transaction: it executes one direct INSERT into `telemetry` (`event_kind='episodic_write_failure'`) and re-throws.
4. Tests assert: `delta(conversation_turns) === 0`, `delta(episodic_events) === 0`, `delta(telemetry where event_kind='episodic_write_failure') === 1`.

## Decisions Made

- **Bundle telemetry CHECK enum extension into V25** rather than V26. The Phase 1 substrate is incomplete without queryable rollback telemetry, and the existing V20/V21 migrations also bundled enum extensions into the same step that introduced the corresponding write surface. Single logical migration > arbitrary cleanliness boundary.
- **lifecycle.ts shim approach (option a)** over adding net-new exports (option b). Hooks at `user-prompt-submit.ts:154` and `stop.ts:155-161` require zero edits; the dual-write becomes invisible to all surrounding code, including any future hook that calls `storeConversationTurn`.
- **`updateConversationTurnAssistant` got an inline transaction** instead of delegating to `dualWriteAssistantMessage`. Reason: the v4 caller in `stop.ts:155-161` already does `if (!updated) storeConversationTurn(...)` for the fallback, and `storeConversationTurn` now routes through `dualWriteAssistantMessage`. Delegating would have caused the fallback path to write the episodic row twice. The inline UPDATE+INSERT keeps both call paths writing exactly one episodic row.
- **`parent_event_id` for assistant_message stays NULL in Phase 1.** Per CONTEXT.md, threading assistant_message → tool_result via parent links is a Phase 3/4 concern when retrieval starts using the chain.
- **Assistant text is treated as raw organic, never parsed.** Tested explicitly in `dual-write-stop.test.ts` to guard against future "improvements" that would split assistant output too.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 4 - Architectural] Plan calls for `event_kind='episodic_write_failure'` telemetry but the CHECK enum was closed**
- **Found during:** Task 2 (Episodic write helpers + dual-write transaction)
- **Issue:** The plan assumes `emitTelemetry('episodic_write_failure', ...)` works. The telemetry table's `event_kind` CHECK constraint is closed (defined in `src/core/schema.ts` `TELEMETRY_SCHEMA` and rebuilt by `migrateV19toV20`/`migrateV20toV21` for prior enum extensions). Inserting an unknown enum value silently fails the CHECK — which would defeat the whole point of "telemetry on rollback so we know about the failure."
- **Fix:** Bundle the enum extension into the existing V25 migration (already shipped at `cf6bfaf`): amend `migrateV24toV25` to ALSO rebuild the telemetry table when the live enum doesn't yet admit `'episodic_write_failure'`. Same rebuild-and-copy pattern as V19→V20. Idempotent via probe of `sqlite_master.sql`. Also update `TELEMETRY_SCHEMA` constant in `src/core/schema.ts`.
- **Files modified:** `src/core/migration-steps.ts`, `src/core/schema.ts`
- **Verification:** All 156 prior migration tests still pass (V20/V21 telemetry rebuild tests pass; V25 idempotency tests pass). New atomicity tests in Task 3 successfully insert `episodic_write_failure` rows on forced rollback.
- **Commit hash:** `a0ad303`
- **Authorization:** SendMessage to team-lead requesting decision; proceeded with recommended option 1 in line with the autonomous mandate from the team lead's "Run /auto-execute-phase 1" instruction. Documented for retrospective review.

**2. [Rule 1 - Bug-class] Plan said "modify `lifecycle.ts:152` to call modified `storeConversationTurnUserText`" — but the call site IS `user-prompt-submit.ts:152`, not lifecycle.ts:152**
- **Found during:** Task 2 reading
- **Issue:** Plan text describing the modification of `src/adapters/cc-hooks/user-prompt-submit.ts:152` accidentally referenced "lifecycle.ts:152" in one sentence. The intent was clearly the hook call site.
- **Fix:** Modified `user-prompt-submit.ts:154` (the actual call site after my line shifts from importing parseWrappers) — no edit needed because the lifecycle helper signature is unchanged. The hook call still reads `storeConversationTurnUserText(ctx.db, input.session_id, routedProject, prompt)` as before.
- **Files modified:** none beyond the import for parseWrappers in Task 1.
- **Verification:** Hook smoke tests pass (`bun run build` exercises every hook via the smoke harness; all 24 hooks green).
- **Committed in:** `37bff87` (Task 1)

---

**Total deviations:** 2 (1 architectural-bundled, 1 plan-text-clarification).
**Impact on plan:** The architectural deviation (telemetry enum) was necessary for the plan's tests to pass. No scope creep beyond the plan's stated `files_modified` PLUS the two schema/migration files needed for the telemetry CHECK extension. Documenting clearly so retrospective review can confirm.

## Issues Encountered

None directly tied to Plan 01-02. The 27 pre-existing full-suite failures (`llama-client.test.ts`, `llama-server-supervisor.test.ts`, `phase-5-full-gate.test.ts`) remain unchanged from the master baseline at commit `19383b5`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **Plan 01-03** (tool_result + environmental write paths) can start immediately. The `episodic-events.ts` module exists, the rollback semantics are proven, the telemetry surface admits `episodic_write_failure`. Plan 03 should:
  - Append `writeToolResult` and `writeEnvironmentalEvent` to the same module.
  - Match the rollback-and-telemetry pattern (one transaction per call; telemetry detail with `hook` + `error_message` + a `kind` discriminator).
  - Use the same `cachedPrepare` for INSERTs.
  - NOT decompose tool results into sub-rows (CONTEXT.md prohibition).
- **Plan 01-04** is downstream of 01-02 + 01-03; integration tests can already reference `dualWriteUserPrompt` / `dualWriteAssistantMessage` shipped here.

---
*Phase: 01-episode-substrate*
*Plan: 02*
*Completed: 2026-05-04*
