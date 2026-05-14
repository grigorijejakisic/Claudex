---
plan: 12-04
phase: 12-real-v6-structural-marks
wave: 2
status: complete
requires: []
provides:
  - Four telemetry signal recorders (signal_reread_after_surface, signal_retrieval_fallback, signal_transcript_injection_acceptance, signal_retrieved_but_unapplied)
  - Row-count cap enforcement at 10K rows per signal kind
  - Non-propagating error handling (hook pipeline safety)
  - TELEMETRY_SCHEMA updated in schema.ts with all four signal_* event_kind values
affects:
  - Post-push telemetry window (2-week signal accumulation)
  - 12-08 transcript_injection_acceptance coupling
key_files:
  - src/core/telemetry-signals.ts
  - src/tests/observability/telemetry-signals.test.ts
  - src/core/schema.ts (TELEMETRY_SCHEMA CHECK constraint updated)
---

# 12-04 Summary — Telemetry Signal Collection

## What Was Built

`src/core/telemetry-signals.ts` exports four signal recorder functions, each writing a row to the `telemetry` table with a distinct `event_kind` value:

- `recordRerereadAfterSurface` → `signal_reread_after_surface` — agent reads a file within N turns of memory surfacing it (acceptance proxy)
- `recordRetrievalFallback` → `signal_retrieval_fallback` — generalizes existing `reranker_fallback` to all fallback paths
- `recordTranscriptInjectionAcceptance` → `signal_transcript_injection_acceptance` — L2.5 deliberation surface injection accepted by agent
- `recordRetrievedButUnapplied` → `signal_retrieved_but_unapplied` — retrieval result with domain token surfaced but agent's next 3 turns don't reference it

`TELEMETRY_SCHEMA` in `schema.ts` updated to include all four `signal_*` event kinds in the CHECK constraint — critical for fresh DB creation to get the correct constraint.

## Decision Notes

1. **No verdict structure** — Phase 12 ships signal collection only. Verdict design (what volume of retrieved_but_unapplied events signals a problem) requires real post-push data first, not advance speculation.

2. **retrieved_but_unapplied is the load-bearing signal** — directly measures the W1/s42 Big Mozzy V2 decoupling pattern where retrieval was correct and precise but the agent said "the handoff is a menu, not a directive." Row volume during the 2-week post-push window is the primary diagnostic question.

3. **Row cap at 10K rows per signal kind** — prevents DB bloat without a schema migration. Deletion is oldest-first (ORDER BY timestamp_epoch ASC).

4. **Non-propagating error handling is belt+suspenders** — outer try/catch in `writeTelemetrySignal` + inner try/catch in `enforceRowCap`. Hook pipeline must never fail due to telemetry writes.

## Schema Fix

The `TELEMETRY_SCHEMA` constant was missing the four `signal_*` event kinds from its CHECK constraint. Fresh test DBs (created via `initializeSchema` which uses `TELEMETRY_SCHEMA`) were getting the old constraint even when V32→V33 migration added the kinds to existing DBs. Fixed by updating the CHECK constraint in `TELEMETRY_SCHEMA`.

## Tests

5 tests pass: each signal type writes the correct row with correct `event_kind` and `detail` JSON; `recordRetrievedButUnapplied` does not throw when telemetry write fails (non-breaking hook proof).
