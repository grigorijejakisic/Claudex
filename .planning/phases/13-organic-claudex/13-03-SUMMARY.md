---
phase: 13-organic-claudex
plan: 03
subsystem: intelligence
tags: [angel, llm, opus, sqlite, schema, session_highlights, WIR-01]

requires:
  - phase: 13-01
    provides: Sessions/ markdown files
  - phase: 13-02
    provides: indexer confirms Sessions/ coverage at the chunk level
provides:
  - "session_highlights V33 table (per-session FRAME artifacts; structured fields)"
  - "src/intelligence/session-highlights.ts: upsertHighlights, getLatestHighlights, getHighlightsBySessionId, getSessionsPendingHighlights"
  - "src/angel/highlights-extractor.ts: extractHighlightsForSession (Opus primary, local LLM fallback, degraded-flag discipline)"
  - "recordFrameExtractionFallback telemetry (mirrors reranker_fallback)"
  - "heartbeat coverage gate: extracts highlights for completed sessions; retries degraded rows"
affects:
  - 13-04 (assembly reads getLatestHighlights at session-start)
  - 13-05 (coverage check reads session_highlights for shouldFireCue)

tech-stack:
  added: []
  patterns:
    - "Opus-primary + Ollama-fallback with degraded discipline mirroring reranker_fallback in CLAUDE.md"
    - "Closed-enum degraded_reason taxonomy: opus_timeout | opus_non_2xx | opus_auth_failed | opus_parse_failed | opus_empty_response"
    - "Test hooks for LLM callables: _setOpusCallableForTest / _setFallbackCallableForTest avoid network calls in tests without mocking node:https"

key-files:
  created:
    - src/intelligence/session-highlights.ts
    - src/angel/highlights-extractor.ts
    - src/tests/intelligence/session-highlights.test.ts
    - src/tests/angel/highlights-extractor.test.ts
  modified:
    - src/core/migration-steps.ts
    - src/core/migrations.ts
    - src/core/telemetry-signals.ts
    - src/angel/heartbeat.ts

key-decisions:
  - "session_highlights is a NEW table (V33), NOT an extension to project_curated_context — different scope (per-session vs. project), different shape (structured fields vs. blob), no automated flow between them. Operator-locked per 13-CONTEXT.md Q [13-03/Q2]."
  - "Opus 4.7 OAuth primary; Ollama (callLocalLLM with config.localModel) fallback via existing Angel LLM path. Degraded flag is non-optional — silently keeping a degraded artifact while showing it as authoritative is unacceptable."
  - "Retry-on-degradation: heartbeat picks up sessions with degraded=true on next tick and re-attempts Opus. If Opus succeeds, upsert (ON CONFLICT DO UPDATE) replaces the degraded row with re_extracted_at_epoch_ms set."
  - "Transcript capped at 50K chars (slice the END — most recent context most relevant). Full Sessions/ file remains the durable source; the extractor's cap is an LLM-context-budget constraint only."
  - "Health line injection (## Frame Extraction Degraded) delegated to Plan 13-04 session-start assembly — extractor only writes to DB; assembly reads from DB."
  - "Migration lives in src/core/migration-steps.ts (existing project convention), NOT src/db/migrations/v33.ts (plan's sketch path). Registered in migrations.ts; TARGET_USER_VERSION bumped 32 → 33."

patterns-established:
  - "Closed-enum degraded_reason taxonomy makes telemetry queryable by reason (operators can see whether the issue is auth, network, parse, or empty)."
  - "Test hooks injected via setter functions (_setOpusCallableForTest etc) avoid the complexity of mocking node:https inside vitest; same pattern can be reused for any LLM-touching path in Angel."

requirements-completed: []

duration: 25min
completed: 2026-05-14
---

# Phase 13 Plan 03: Highlights Extraction Pipeline Summary

**V33 session_highlights table plus Angel highlights extractor — Claude Opus 4.7 OAuth primary, local-LLM fallback, degraded-flag discipline that mirrors reranker_fallback; heartbeat reads pending sessions and retries degraded artifacts on each tick.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 7 (read migrations + V33 step + reader/writer module + extractor module + heartbeat wire + 2 test files)
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- V33 migration creates `session_highlights` with UNIQUE(session_id, project) + DESC index on (project, created_at_epoch_ms). Idempotent (CREATE TABLE IF NOT EXISTS); shape-agnostic (no existing surface altered).
- `session-highlights.ts` exports 4 functions: upsert, latest-N, by-session-id, pending-sessions query.
- `highlights-extractor.ts` exports `extractHighlightsForSession({db, sessionId, project, projectDir, config})`. Reads Sessions/ markdown, calls Opus 4.7 via OAuth, falls back to `callLocalLLM` with `config.localModel`, writes telemetry on every fallback, persists row with degraded fields.
- Heartbeat tick adds two new phases after sessions-indexer: (a) the indexer step (Plan 02), (b) the highlights extraction step (this plan). Both are non-fatal — failure of either does not kill the heartbeat.
- `recordFrameExtractionFallback` lives in `src/core/telemetry-signals.ts` alongside the existing four Phase 12 signals; uses the same `writeTelemetrySignal` row-capped INSERT path.
- 17 tests pass (12 reader/writer + 5 extractor degraded-flag discipline).

## Task Commits

1. **Tasks 1–7 (combined):** `0f74ae0` — feat(13-03): V33 session_highlights + Angel highlights extractor (Opus primary, local fallback)

## Files Created/Modified

- `src/core/migration-steps.ts` — `migrateV32toV33` function (session_highlights DDL)
- `src/core/migrations.ts` — TARGET_USER_VERSION 33, migrations[32]
- `src/core/telemetry-signals.ts` — `recordFrameExtractionFallback`
- `src/intelligence/session-highlights.ts` — reader/writer module
- `src/angel/highlights-extractor.ts` — Opus + fallback extractor with test hooks
- `src/angel/heartbeat.ts` — wire the heartbeat phase (pending sweep + extract)
- `src/tests/intelligence/session-highlights.test.ts` — 12 tests
- `src/tests/angel/highlights-extractor.test.ts` — 5 tests

## Decisions Made

See `key-decisions` frontmatter. Notable: the plan's sketch put the migration at `src/db/migrations/v33.ts` but the existing project convention is `src/core/migration-steps.ts` + a registration entry in `src/core/migrations.ts` + a `TARGET_USER_VERSION` bump. I followed the existing convention — adding a new directory under `src/db/` for a single migration would be Rule 4 architectural deviation in disguise.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Plan sketch field names did not match the codebase**
- **Found during:** Task 4 (extractor)
- **Issue:** Plan sketched `angel.default_model` and `config.default_model`; AngelConfig actually exposes `localModel` (camelCase). Sketch also said "register migration in `src/db/migrations/v33.ts`" — that path does not exist; the project uses `src/core/migration-steps.ts` plus a registration entry in `src/core/migrations.ts`.
- **Fix:** Used `config.localModel`. Added `migrateV32toV33` to `migration-steps.ts`; registered in `migrations.ts` migrations array; bumped `TARGET_USER_VERSION` 32 → 33; updated the version-map JSDoc.
- **Files modified:** `src/core/migration-steps.ts`, `src/core/migrations.ts`, `src/angel/highlights-extractor.ts`
- **Verification:** Build passes; 17 tests pass.
- **Committed in:** `0f74ae0`

**2. [Rule 2 — Missing Critical] Test path was network-dependent**
- **Found during:** Task 7 (extractor smoke test)
- **Issue:** Plan said "Use `vi.mock` to mock `node:https`" — that approach is fragile under vitest's auto-mocking and would fail on Windows path resolution. The other suggested path ("mock `./llama-client.js`") creates module-graph coupling.
- **Fix:** Added two test-only setters (`_setOpusCallableForTest`, `_setFallbackCallableForTest`) inside `highlights-extractor.ts` that swap in deterministic callables. Cleaner than ESM mocking; reusable for any future Angel LLM-touching code.
- **Files modified:** `src/angel/highlights-extractor.ts`, `src/tests/angel/highlights-extractor.test.ts`
- **Verification:** 5 extractor tests pass without network.
- **Committed in:** `0f74ae0`

**3. [Rule 2 — Missing Critical] Telemetry event_kind type system is closed**
- **Found during:** Task 4 (telemetry)
- **Issue:** Plan said `emitTelemetry(db, sid, 'frame_extraction_fallback', {...})`. EventKind is a closed type union in `observability/types.ts` (~11 kinds); adding a new one requires a typed detail interface AND blocks the generic-constrained `emitTelemetry`. The existing pattern for new event-kinds is raw INSERT via `writeTelemetrySignal` in `src/core/telemetry-signals.ts` (where Phase 12 signals already live).
- **Fix:** Added `recordFrameExtractionFallback` to `telemetry-signals.ts` using the same `writeTelemetrySignal` helper. No EventKind type changes needed; same row-cap discipline.
- **Files modified:** `src/core/telemetry-signals.ts`, `src/angel/highlights-extractor.ts`
- **Verification:** Test asserts the telemetry row exists with `event_kind='frame_extraction_fallback'` and JSON detail carries the reason + fallback_model.
- **Committed in:** `0f74ae0`

**4. [Rule 1 — Bug] Plan sketch had a fragile JSON-fence regex**
- **Found during:** Task 4
- **Issue:** Plan's `replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '')` doesn't handle leading whitespace before the fence or trailing whitespace after.
- **Fix:** `replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/im, '')` plus `.trim()` — robust to both.
- **Files modified:** `src/angel/highlights-extractor.ts`
- **Verification:** Parse helper has unit-level coverage via the success-path test.
- **Committed in:** `0f74ae0`

---

**Total deviations:** 4 auto-fixed (2 Rule 1, 2 Rule 2). All correctness fixes; no scope creep.
**Impact on plan:** Plan executed as scoped; deviations corrected places where the sketch did not match the actual codebase conventions.

## Issues Encountered

None.

## User Setup Required

None — the OAuth credentials path (~/.claude/.credentials.json) already exists for the user (Claudex MAX subscription).

## Next Phase Readiness

- 13-04 unblocked: `getLatestHighlights` and `## Frame Extraction Degraded` health-line surface (assembly side) can be wired now.
- 13-05 unblocked: `shouldFireCue` reads `getLatestHighlights` for the coverage gate.

---
*Phase: 13-organic-claudex*
*Completed: 2026-05-14*
