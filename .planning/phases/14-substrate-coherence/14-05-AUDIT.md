# 14-05 Audit: Writers of `sessions.status='completed'`

**Auditor:** Worker F (14-05 Plan Executor)
**Date:** 2026-05-16
**Method:** Grep across `src/` for `status.*completed`, `status = 'completed'`, `status='completed'`

---

## Production Writers (non-test files)

| # | File | Line(s) | Write Pattern | Action Required |
|---|------|---------|---------------|-----------------|
| 1 | `src/angel/boundary/cursor.ts` | 190–193 | `UPDATE sessions SET status = 'completed', ended_at_epoch_ms = COALESCE(ended_at_epoch_ms, ?) WHERE session_id = ?` inside `commitBoundaryTick` transaction | **KEEP** — this is inside `commitBoundaryTick`, which is the function `runBoundaryTick` (boundary-detector) calls. Plan 14-05 wraps this with `promoteSessionToCompleted`; the cursor write remains but is gated by the promotion function's idempotency check. |
| 2 | `src/angel/heartbeat.ts` | 215–216 | `UPDATE sessions SET status = 'completed', ended_at_epoch_ms = ?` in the auto-close (escalated idle) branch | **REMOVE** — heartbeat.ts directly writing status. This is the primary non-owner write found. |
| 3 | `src/angel/heartbeat.ts` | 544–545 | `UPDATE sessions SET status = 'completed', ended_at_epoch_ms = ?` in the orphaned-session-close branch (4d) | **REMOVE** — second direct heartbeat write. |
| 4 | `src/adapters/cc-hooks/session-end-close-marker.ts` | 51–53 | `UPDATE sessions SET last_heartbeat_ts = ?, status = 'completed', ended_at_epoch_ms = COALESCE(ended_at_epoch_ms, ?) WHERE session_id = ?` in `emitCleanEndsessionClose` | **KEEP (scope boundary)** — This is the clean_endsession path; boundary-detector explicitly skips sessions with `clean_endsession` close markers (line 237 of boundary-detector.ts). This path is not TERMINATED detection; it is an explicit, hook-driven close. Out of scope for this plan per anti-scope rule ("Do NOT remove the stop hook entirely — it still writes session_summary"). Clean_endsession is a separate lifecycle gate. Document as deferred in SUMMARY. |
| 5 | `src/adapters/cc-hooks/session-start.ts` | 231 | `UPDATE sessions SET status = 'completed', ended_at_epoch_ms = ? WHERE session_id = ?` in the orphan-recovery block | **REMOVE** — session-start.ts should not be closing sessions; the boundary-detector is the sole owner. |
| 6 | `src/core/sessions.ts` | 55–60 | `endSession(db, sessionId, status)` helper writes `UPDATE sessions SET status = ?, ended_at_epoch_ms = (unixepoch() * 1000)` | **DEPRECATE** — mark `@deprecated`; log telemetry warning on call. Callers (if any) must migrate to `promoteSessionToCompleted`. |

---

## Callers of `endSession()` from `src/core/sessions.ts`

Grep for `endSession(` in production code:

```
grep -rn "endSession(" src/ --include="*.ts" (excluding tests)
```

Result: **No production callers found.** `endSession` is defined but not called by any non-test production file. Safe to mark `@deprecated` only.

---

## Stop Hook (src/adapters/cc-hooks/stop.ts)

**Finding:** The stop hook does NOT currently write `status='completed'`. The audit confirms it only writes `session_summary` via `saveSessionSummary()` and bumps `last_heartbeat_ts`. No `UPDATE sessions SET status = 'completed'` exists in `stop.ts`.

**Action:** No change needed to stop.ts for status writes. Existing behavior preserved.

---

## Test-only Writers (informational, not modified)

These appear in test fixtures only and are expected/correct:

- `src/tests/adapters/shared/lifecycle.test.ts` — test setup
- `src/tests/adapters/cc-hooks/heartbeat-column-writes.test.ts` — test assertions
- `src/tests/adapters/cc-hooks/hooks.test.ts` — test assertions
- `src/tests/intelligence/directive-detector-integration.test.ts` — test setup
- `src/tests/angel/session-monitor.test.ts` — test seed data
- `src/tests/intelligence/session-highlights.test.ts` — test seed data
- `src/tests/angel/heartbeat.test.ts` — test setup (line 178)
- `src/tests/angel/guardian.test.ts` — test seed data
- `src/tests/angel/curated-context-extractor.test.ts` — test setup
- `src/tests/integration/e2e-flows.test.ts` — test assertions
- `src/tests/angel/boundary/*.test.ts` — test assertions
- `src/tests/integration/phase-6-crash-resilience.test.ts` — test assertions
- `src/benchmark/debug-locomo.ts` — benchmark script (not production path)
- `src/core/migration-steps.ts` — migration defaults (setting NULL rows to 'completed' in V8, V9 — historical migration data)

---

## Query-only References (not writes, informational)

These files read `status = 'completed'` but do not write it:

- `src/intelligence/intent-predictor.ts` — SELECT WHERE status='completed'
- `src/intelligence/session-highlights.ts` — SELECT WHERE status='completed'
- `src/core/session-discovery.ts` — comment + SELECT
- `src/angel/curated-context-extractor.ts` — SELECT WHERE status='completed'
- `src/angel/session-monitor.ts` — SELECT WHERE status='completed'
- `src/angel/heartbeat.ts` — SELECT for pending backlog check (not writes)

---

## Summary of Actions

| Action | Files | Count |
|--------|-------|-------|
| REMOVE direct writes | `heartbeat.ts` (×2), `session-start.ts` (×1) | 3 writes removed |
| KEEP (scope boundary) | `session-end-close-marker.ts` | 1 kept (clean_endsession path) |
| KEEP (inside boundary detector) | `boundary/cursor.ts` | 1 kept (gated by promoteSessionToCompleted) |
| DEPRECATE helper | `core/sessions.ts` `endSession()` | 1 deprecated |
| No change | `stop.ts` | Never wrote status (confirmed) |

---

## AC-9 Pre-condition

After Task 4, a final grep of `UPDATE sessions SET status.*=.*'completed'` should return ONLY:
1. `src/angel/boundary/cursor.ts` (inside commitBoundaryTick, called by the promotion chain)
2. Migration-steps.ts historical data migrations (V8/V9 legacy row fixups)
3. `src/adapters/cc-hooks/session-end-close-marker.ts` (clean_endsession path — separate lifecycle gate, not TERMINATED)

The three heartbeat writes and the session-start write are the removals.
