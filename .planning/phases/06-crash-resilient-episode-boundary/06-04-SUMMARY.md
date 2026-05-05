---
phase: 06-crash-resilient-episode-boundary
plan: 04
subsystem: angel
tags: [angel, boundary, classifier, cursor, sweep, reopen, phase-6]

requires:
  - phase: 06-01
    provides: V29 schema (cursor table + sessions liveness columns)
  - phase: 06-02
    provides: thresholds (BoundaryThresholds + LOCKED_DEFAULTS) + isPidAlive
  - phase: 06-03
    provides: hook-driven heartbeat ts feeding the classifier; clean_endsession close marker that the sweep skips
provides:
  - classifySession pure function (composition-rule.ts) — 4-branch close_reason precedence
  - loadCursor / commitBoundaryTick / resetCursor (cursor.ts) — atomic + heartbeat-compare guarded
  - runBoundaryTick(db, thresholds) sweep loop (boundary-detector.ts) — re-open + offset-overflow + per-session error isolation
  - 27 new boundary tests (10 composition-rule + 5 cursor + 3 heartbeat-compare + 6 boundary-detector + 3 reopen)
affects: [phase-6-plan-05]

tech-stack:
  added: []
  patterns:
    - "Pure-function classifier separated from transactional commit. classifySession is a pure (now, row, t) → Classification function — no DB, no I/O. Truth-table tested in 10 cases. The DB-side logic (heartbeat-compare, episodic_events insert, cursor UPSERT) lives in cursor.ts. Future readers can match the composition-rule body line-for-line against CONTEXT.md without DB-mocking."
    - "Heartbeat-compare-before-cleanup inside tx, telemetry outside. The race-guard re-reads sessions.last_heartbeat_ts/last_jsonl_write_ts inside the same transaction that writes the close marker. If either changed, the close is aborted, telemetry is written (best-effort, swallowed if CHECK enum rejects), and the cursor still advances. Result: cursor never gets stuck on a session whose detection snapshot keeps going stale."
    - "Append-only re-open invariant. The original episode_closed row is NEVER mutated on re-open. A re_opened env event row is APPENDED, sessions.status flips back to active, cursor.last_close_event_id resets to NULL. The 'cycle test' verifies a re-open + re-close pair produces TWO distinct episode_closed rows (different ids, both readable) — proves event-sourcing semantics."
    - "Candidate filter includes closed-but-fresh-JSONL sessions. The candidate JOIN doesn't just look at status='active'; it also picks up sessions whose cursor has a close marker AND whose last_jsonl_write_ts > last_processed_event_ts_epoch. Without this, the re-open branch would never see anomaly candidates."

key-files:
  created:
    - src/angel/boundary/composition-rule.ts
    - src/angel/boundary/cursor.ts
    - src/angel/boundary/boundary-detector.ts
    - src/tests/angel/boundary/composition-rule.test.ts
    - src/tests/angel/boundary/cursor.test.ts
    - src/tests/angel/boundary/heartbeat-compare.test.ts
    - src/tests/angel/boundary/boundary-detector.test.ts
    - src/tests/angel/boundary/reopen.test.ts
  modified: []
  deleted: []

key-decisions:
  - "Candidate filter widened to include `c.last_close_event_id IS NOT NULL AND s.last_jsonl_write_ts > c.last_processed_event_ts_epoch`. The plan implied this through the re-open requirement but the literal SQL in step 1 (`status='active' OR c.last_close_event_id IS NULL`) would have excluded all already-closed sessions. The widened filter is the only way the re-open / anomaly branches ever see candidates."
  - "telemetry writes for all Phase 6 event_kinds (close_aborted_stale_check_failed, episode_close_emitted, episode_reopen, episode_reopen_anomaly, boundary_cursor_replay) wrapped in try/catch + swallow. The V20 CHECK enum doesn't admit any of them yet. Same swallow pattern as Plan 02's jsonl_watcher_unreachable + Plan 03's episode_close_emitted. A future migration extends the enum; until then, telemetry is silently dropped. The load-bearing artifacts (episode_closed env event, cursor UPSERT, sessions.status flip) all live OUTSIDE telemetry, so the substrate is correct even with telemetry blocked."
  - "isCleanEndsession check matches against `metadata_json LIKE '%clean_endsession%'`. Phase 1 episodic_events.metadata_json is JSON1 — we could parse it but a substring scan is faster and the only consumer of `clean_endsession` is the boundary detector itself. Plan 7 retirement work may switch to json_extract if other consumers appear."

requirements-completed: [EBD-03, EBD-04, EBD-06]

duration: 12 min
completed: 2026-05-05
---

# Phase 6 Plan 04: composition rule + cursor + boundary detector Summary

**The brain of Phase 6. Three new modules in `src/angel/boundary/`: composition-rule (pure classifier matching CONTEXT formal predicate verbatim), cursor (atomic cursor advance + close-marker emission with heartbeat-compare race guard), and boundary-detector (sweep loop integrating both, plus re-open and offset-overflow recovery). 27 new tests; all pass; load-bearing JSONL-trumps-heartbeat invariant + Session-Amnesia race guard + append-only re-open semantics all proven.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-05-05T20:55Z
- **Completed:** 2026-05-05T21:07Z
- **Tasks:** 3
- **Files created:** 8

## Accomplishments

### composition-rule.ts (87 lines)
- `SessionLivenessRow` type carrying caller-resolved pid + pid_alive + has_clean_endsession.
- `classifySession(now, row, t)` returns `{state:'alive'|'dormant'|'terminated', close_reason?}`.
- close_reason precedence: clean_endsession > idle_timeout > jsonl_silent > pid_dead.
- 10 truth-table tests including the load-bearing JSONL-trumps-heartbeat case (#2).

### cursor.ts (180 lines)
- `loadCursor`, `commitBoundaryTick`, `resetCursor`.
- `commitBoundaryTick` runs a single transaction:
  - Heartbeat-compare guard: re-reads sessions inside tx, aborts close if heartbeat or jsonl_write_ts changed since detection.
  - On guard pass: INSERT episodic_events (type='environmental_event', metadata episode_closed:true + close_reason + duration + event_count + pid_alive + last_heartbeat_ts + last_jsonl_write_ts), UPDATE sessions status='completed' + ended_at_epoch, UPSERT cursor with last_close_event_id.
  - On guard fail: INSERT close_aborted_stale_check_failed telemetry (try/catch'd) + cursor advance only.
- episode_close_emitted telemetry OUTSIDE the tx (swallowed if CHECK enum rejects) so close marker is durable.
- resetCursor: UPDATE offset=0 + telemetry attempt for offset_overflow / file_missing.

### boundary-detector.ts (260 lines)
- `runBoundaryTick(db, thresholds, opts?)`. opts: now, projectsRoot, limit, resolvePid.
- Candidate filter: active OR no-cursor OR cursor-closed-but-jsonl-fresher-than-close-ts.
- Per-session loop: cursor offset overflow check → PID resolve → re-open vs new-close branch.
- Re-open within T_reopen + fresh JSONL: emit re_opened env event + flip status='active' + reset cursor.last_close_event_id=NULL.
- Re-open beyond T_reopen: episode_reopen_anomaly telemetry only.
- New-close branch: classifySession → commitBoundaryTick (skips clean_endsession reason).
- Per-session try/catch: failures recorded as episodic_write_failure telemetry; sweep continues.

### Tests (27 new + 9 from Plan 02 = 53 total in src/tests/angel/boundary/)
- 10 composition-rule truth-table cases.
- 5 cursor module cases (loadCursor null, cursor-only commit, preserves last_close_event_id, close-marker commit, resetCursor).
- 3 heartbeat-compare race cases (heartbeat-fresh abort, jsonl-fresh abort, both-unchanged success).
- 6 boundary-detector cases (mixed fresh/idle/dormant, clean_endsession skip, offset overflow, no-PID fallback, bounded LIMIT 25, per-session error isolation).
- 3 reopen cases (within window, anomaly, re-open + re-close cycle with 2 episode_closed rows surviving).

## Task Commits

1. `[hash]` — feat(06-04): pure composition-rule classifier matching CONTEXT formal predicate
2. `[hash]` — feat(06-04): atomic cursor commit with heartbeat-compare-before-cleanup guard
3. `[hash]` — feat(06-04): boundary-detector sweep loop with re-open + offset-overflow recovery

## Verification Results

- `bun run build`: clean.
- `bun run test src/tests/angel/boundary/`: 53/53 pass (1.77s).
- Load-bearing tests confirmed:
  - composition-rule case #2 (JSONL fresh, hooks dead 3h, PID alive → ALIVE): PASS.
  - heartbeat-compare race (heartbeat goes fresh between detection and commit → close aborted, cursor advances): PASS.
  - reopen append-only (after re-open + re-close cycle, both episode_closed rows present): PASS.

## Deviations from Plan

**[Rule 3 - Blocking] Candidate filter SQL didn't include re-open candidates**
- Found during: Task 3 reopen tests
- Issue: Plan step 1 specified `WHERE s.status = 'active' OR c.last_close_event_id IS NULL`. But re-open candidates have `status='completed'` AND `last_close_event_id IS NOT NULL` — the original filter excluded them. The 3 reopen tests all failed.
- Fix: Widened filter to also include `c.last_close_event_id IS NOT NULL AND s.last_jsonl_write_ts > COALESCE(c.last_processed_event_ts_epoch, 0)`. This catches sessions whose JSONL was bumped after the prior close (i.e., reopen / anomaly candidates).
- Files: `src/angel/boundary/boundary-detector.ts`.
- Verification: All 3 reopen tests pass; existing tests still pass.

**Total deviations:** 1 (Rule 3). **Impact:** the re-open / anomaly branches are now reachable by the sweep; without this fix Phase 6 would silently drop the entire re-open feature.

## Issues Encountered

None.

## Next Phase Readiness

- Plan 05 unblocked: Angel integration calls `runBoundaryTick(angel.db, loadThresholds())` from heartbeat tick + manages `startJsonlWatcher` lifecycle (boot/shutdown). The boundary-detector module exposes a clean `BoundaryTickResult` for telemetry / observability.
- Vesna VAL-04 probe (crash-resilience) can now be designed against this surface — kill -9 mid-session test asserts the sweep emits idle_timeout after T_jsonl + T_grace.

Ready for **06-05-PLAN.md** (Angel integration + Vesna VAL-04).
