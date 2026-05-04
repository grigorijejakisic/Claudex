---
phase: 02-p1-artifact-table-unification
plan: 02-05
subsystem: database
tags: [migration, v17, runner, ollama, atomic-tx, phase-a, phase-b]

requires:
  - phase: 02-01
    provides: composeBody + KIND_MAPPING
  - phase: 02-02
    provides: createAndVerifyBackup + manifest + rotation
  - phase: 02-03
    provides: scanStaleRows + parseStaleReview + getStaleIds
  - phase: 02-04
    provides: applyV17DDL + generateViewsAndTriggers

provides:
  - stageEmbeddings() — Phase A pre-embed via Ollama arctic-embed2
  - runV17Migration() — full pipeline orchestrator
  - migrate:v17:dry-run + migrate:v17:apply CLI subcommands

affects:
  - 02-07-verification-state (full-suite test + benchmark gate runs against migrated DB)

tech-stack:
  added: []
  patterns:
    - "Phase A / Phase B split: expensive work outside tx, atomic state change inside."
    - "Dependency injection for embedder — tests use deterministic fake; prod uses EmbeddingProvider."
    - "ROLLBACK on any throw inside BEGIN IMMEDIATE tx; backup always restorable if apply fails."

key-files:
  created:
    - src/core/migration/v17-embed-stage.ts
    - src/core/migration/v17-runner.ts
    - src/tests/core/migration/v17-runner.test.ts
  modified:
    - src/cli/migrate.ts (v17RunnerMain + subcommand routing)

key-decisions:
  - "EmbedderLike interface (subset of EmbeddingProvider) lets tests inject a deterministic fake without standing up Ollama. Prod CLI passes real EmbeddingProvider with localhost:11434 arctic-embed2."
  - "Phase B sequence: DDL → RENAME legacy → DROP legacy FTS5 → Pass 1 INSERT + legacy_id_map + vec0 → Pass 2 resolve supersedes_id → Pass 3 flag stale → applyGeneratedDDL → backfill artifact_fts → validation → user_version bump → COMMIT."
  - "Backfill artifact_fts after triggers (not before): trigger path would double-insert. Post-triggers backfill uses plain INSERT INTO artifact_fts(rowid, title, body) SELECT ... FROM artifact."
  - "vec0 rowid binding requires BigInt in better-sqlite3 (1n not 1). Discovered during test run; runner fix is tiny but pattern-critical."
  - "Exit codes: 0 PASS, 1 FAIL, 2 ABORTED. ABORTED is reserved for user-actionable states (missing stale-review.md, Ollama down)."

patterns-established:
  - "runner.phase field ticks through 'backup' → 'stale-review' → 'stage' → 'phase-b' → 'post-check' → 'done'. Useful for observability + test assertions."
  - "Pre-flight parity snapshot taken BEFORE BEGIN IMMEDIATE (reads from the about-to-be-renamed legacy tables); post-check compares against SELECT kind, COUNT(*) FROM artifact GROUP BY kind."
  - "Fake embedder for tests: text → Array.from({length:1024}, (_,i) => (t.length+i)/2048). Deterministic, cheap, matches vec0 dimension."

requirements-completed:
  - STOR-01
  - STOR-02
  - STOR-03
  - STOR-04
  - STOR-05
  - STOR-08

duration: 14 min
completed: 2026-04-20
---

# Phase 2 Plan 02-05: V17 Migration Runner Summary

**End-to-end V16→V17 pipeline: backup + verify gate, stale-review gate, Ollama-driven Phase A pre-embed, Phase B atomic BEGIN IMMEDIATE transaction covering DDL + legacy RENAME + FTS5 retirement + 3 data passes + view/trigger generation + FTS5 backfill + validation + version bump. ROLLBACK-safe; 7 E2E Vitest cases green with deterministic fake embedder.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-04-20T10:02:50Z
- **Completed:** 2026-04-20T10:17:00Z
- **Tasks:** 4
- **Files modified:** 4 (3 created, 1 edited)

## Accomplishments

- `stageEmbeddings(db, embedder)` streams every row of the 6 legacy tables through `composeBody` + `embedder.embedBatch(32)` and emits a `StagedRow[]` with kind-derived payloads.
- `runV17Migration(opts)` orchestrates backup + stale-review + Phase A + Phase B + post-check with typed `RunnerResult` ({verdict, phase, backupResult, stagedCount, insertedCounts, errors}).
- Phase B atomic tx: DDL + 6 RENAMEs + legacy FTS5 drop + 3 data passes + view/trigger generation + FTS5 backfill + validation + version bump. ROLLBACK on any throw.
- CLI subcommands `migrate:v17:dry-run` and `migrate:v17:apply` wired into `src/cli/migrate.ts`. Exit code discipline: 0 PASS / 1 FAIL / 2 ABORTED.
- 7 E2E Vitest cases green: dry-run no-mutation, full apply (8 rows across 6 kinds, 1 stale-flagged), legacy FTS5 retired + artifacts_fts preserved, version bump, view round-trip (SELECT + INSERT through learnings view), missing stale-review.md ABORT, failing embedder ABORT, null embedder ABORT.

## Task Commits

1. **Tasks 05-01-01 through 05-01-04** (v17-embed-stage + v17-runner + CLI + tests, bundled) — `bbfb046` (feat).

**Plan metadata:** (pending — committed with SUMMARY.md)

## Files Created/Modified

- `src/core/migration/v17-embed-stage.ts` — 110 lines. `stageEmbeddings` + `EmbedderLike` + `EmbeddingError` + `floatsToBuffer`.
- `src/core/migration/v17-runner.ts` — 320 lines. Full pipeline + helpers.
- `src/tests/core/migration/v17-runner.test.ts` — 390 lines. 7 E2E cases + seed helpers for V16 shape.
- `src/cli/migrate.ts` — +55 lines. `v17RunnerMain` + subcommand routing.

## Decisions Made

- Writes go through a SECOND Database connection opened after stageEmbeddings, not the stage-reader's read-only connection. This is necessary because stageEmbeddings opens read-only and can't be upgraded; better-sqlite3 connections are single-writer.
- `msFromLegacyRow` picks the most likely time column from {`created_at_epoch`, `first_seen_epoch`, `timestamp_epoch`} with a `Date.now()` fallback for critical_rules (TEXT datetime cols). Kernel stores ms; legacy stored seconds.
- Validation SQL is a single UNION-style query covering all 6 kinds with per-kind required-path checks. Catches malformed rows BEFORE COMMIT, leaving the tx to ROLLBACK cleanly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] vec0 rowid binding requires BigInt in better-sqlite3**
- **Found during:** First E2E test run (verdict returned FAIL with "Only integers are allowed for primary key values on artifact_embeddings").
- **Issue:** Initial runner bound `vecRowid` as a JS number. vec0's rowid column demands BigInt via better-sqlite3's prepared statement binding.
- **Fix:** Changed to `let vecRowid = 1n` and `vecRowid += 1n`. Pass BigInt to insertEmbStmt, Number(vecRowid) to the plain-INTEGER updateEmbRefStmt.
- **Files modified:** src/core/migration/v17-runner.ts (Pass 1 INSERT loop).
- **Verification:** All 7 runner tests green post-fix.
- **Committed in:** bbfb046.

---

**Total deviations:** 1 auto-fixed.
**Impact:** Standard better-sqlite3 + vec0 binding quirk. Documented here for future phase reference.

## Issues Encountered

None beyond the auto-fixed above.

## User Setup Required

None for automated tests. For the REAL P1 apply run (Plan 02-07), Ollama must have `snowflake-arctic-embed2` pulled and reachable on localhost:11434.

## Next Phase Readiness

- Plan 02-06 (FTS5 caller port) is unblocked — callers must swap from `learnings_fts` / `experience_patterns_fts` to `artifact_fts` with kind-filtered joins before the full suite can green against a migrated DB.
- Plan 02-07 (verification + benchmarks) will invoke `migrate:v17:apply` on the dev DB via the CLI.

## Self-Check

- Files on disk: v17-embed-stage.ts, v17-runner.ts, v17-runner.test.ts — all present.
- `bun run test -- migration` → 120/120 green (8 migration test files).
- `bun run build` clean.

## Self-Check: PASSED

---
*Phase: 02-p1-artifact-table-unification*
*Completed: 2026-04-20*
