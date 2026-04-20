---
phase: 02-p1-artifact-table-unification
plan: 02-06
subsystem: database
tags: [migration, v17, fts5, hybrid-retrieval, dual-path]

requires:
  - phase: 02-04
    provides: artifact_fts (new FTS5 index content='artifact')

provides:
  - Dual-path FTS5 routing (artifact_fts primary, legacy FTS5 fallback) in recall-server, experience-patterns
  - v17HasArtifactsOfKind(db, kind) helper in experience-patterns.ts
  - data-quality sync check upgraded to track artifact_fts

affects:
  - 02-07-verification-state (full-suite test gate must pass with ports in place)

tech-stack:
  added: []
  patterns:
    - "Runtime FTS5 target selection: try artifact_fts first, fall back to legacy *_fts when artifact kernel is empty."
    - "V17 DDL runs as dormant storage at initializeSchema time; data migration stays CLI-driven."

key-files:
  created: []
  modified:
    - src/mcp/recall-server.ts (Channel 4 + Channel 6 ported)
    - src/intelligence/experience-patterns.ts (findMatchingPatterns + deduplicateCheck ported; v17HasArtifactsOfKind helper added)
    - src/angel/data-quality.ts (validateSchemaIntegrity learnings entry → artifact)
    - src/core/migrations.ts (import + call migrateV16toV17 as dormant storage)
    - src/core/migration-steps.ts (migrateV16toV17 narrowed to DDL only; views deferred to runner)

key-decisions:
  - "Dual-path fallback rather than hard switch: keeps pre-V17 behavior intact while making callers V17-forward-compatible. Tests don't need V17 data migration to pass."
  - "artifact_fts becomes dormant storage at V16 init (empty kernel). The V17 runner populates it inside Phase B. Before the runner runs, the fallback path hits legacy FTS5."
  - "Views + INSTEAD OF triggers moved OUT of migrateV16toV17 into the runner — CREATE VIEW name collides with CREATE TABLE name before legacy tables are renamed to _old."
  - "SearchResult.id narrowed to rank position (integer) since artifact.id is TEXT UUID. UUID preserved in provenance field per plan's ID-type-switch option (b)."

patterns-established:
  - "v17HasArtifactsOfKind(db, kind) — cheap SELECT 1 ... LIMIT 1 probe; non-throwing; unknown schema → false."
  - "Dual-path pattern: try V17 primary, on empty hit fall back to legacy. Both paths inside try/catch so missing tables are non-fatal."

requirements-completed:
  - STOR-03

duration: 8 min
completed: 2026-04-20
---

# Phase 2 Plan 02-06: FTS5 Caller Port Summary

**Runtime dual-path FTS5 routing: every MATCH query that hit learnings_fts or experience_patterns_fts now probes artifact_fts first, falls back to the legacy FTS5 table when artifact kernel is empty. Makes callers V17-forward-compatible without breaking pre-V17 tests — 2405/2425 tests green (20 pre-existing llama failures unchanged).**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-20T10:17:10Z
- **Completed:** 2026-04-20T10:25:10Z
- **Tasks:** 4
- **Files modified:** 5

## Accomplishments

- `src/mcp/recall-server.ts` Channel 4 (learnings) and Channel 6 (experience patterns) refactored to try artifact_fts first, fall back to legacy *_fts on empty hit. Both paths wrapped in try/catch so missing tables don't crash the loop.
- `src/intelligence/experience-patterns.ts` `findMatchingPatterns` and `deduplicateCheck` now route through `v17HasArtifactsOfKind('experience_pattern')` — picks the V17 or legacy query shape at runtime.
- `src/angel/data-quality.ts` `validateSchemaIntegrity` swapped `learnings_fts` → `artifact_fts` sync check (unified index covers all 6 kinds post-V17).
- `initializeSchema` now calls `migrateV16toV17` as dormant storage (matches V14→V15 vec0 pattern). Artifact kernel + artifact_fts + legacy_id_map available from V16 init; data migration still CLI-driven via Plan 02-05 runner.
- Full test suite: 2405 relevant tests green (up from 2368 before P1 — +37 new tests from Waves 1–2).

## Task Commits

1. **Tasks 06-01-01 through 06-01-04** (enumerate + rewrite + tests + docs, bundled) — `53c6eb8` (feat).

**Plan metadata:** (pending — committed with SUMMARY.md)

## Files Created/Modified

- `src/mcp/recall-server.ts` — dual-path wiring in 2 channels; ~80 line net change.
- `src/intelligence/experience-patterns.ts` — dual-path wiring in 2 callers + helper; ~50 line net change.
- `src/angel/data-quality.ts` — 1 entry swap in checks array + doc line update.
- `src/core/migrations.ts` — +1 import, +1 call to `migrateV16toV17` with try/catch guard.
- `src/core/migration-steps.ts` — `migrateV16toV17` narrowed to DDL (views removed).

## Decisions Made

- Split migrateV16toV17 into "always-on DDL" (kernel + indexes + vec0 + fts5) vs. "runner-time views + triggers" because views require the legacy tables to be renamed first. This lets `initializeSchema` install V17 DDL as dormant storage without breaking anything.
- Dual-path callers instead of hard-switch: the plan accepts either approach; dual-path preserves pre-V17 test behavior and means the runner doesn't have to run before the app works.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Views collided with legacy tables at initializeSchema time**
- **Found during:** Adding `migrateV16toV17` to `runMigrations`.
- **Issue:** `CREATE VIEW learnings AS ...` fails with "there is already another table or view named learnings" because the legacy `learnings` table still exists pre-runner. Same for the 5 other legacy tables.
- **Fix:** Moved view + trigger generation OUT of `migrateV16toV17` into the runner (where it fires AFTER the 6 RENAME TO _old statements). `migrateV16toV17` now only applies kernel DDL (dormant storage).
- **Files modified:** src/core/migration-steps.ts.
- **Verification:** Full test suite passes with V16 schema + dormant V17 kernel; runner tests still pass because runner calls both `applyV17DDL` and `applyGeneratedDDL` in sequence.

**2. [Rule 1 - Bug] Test regression when first draft used only V17 path**
- **Found during:** Running experience-patterns tests after initial port.
- **Issue:** Tests insert into legacy experience_patterns table which has its own FTS5 index. The V17-only port meant those tests no longer saw matches (artifact kernel was empty).
- **Fix:** Dual-path routing via `v17HasArtifactsOfKind`. Tests hitting legacy FTS5 still work; production post-migration uses the V17 path.
- **Files modified:** src/intelligence/experience-patterns.ts, src/mcp/recall-server.ts.
- **Verification:** experience-patterns tests 103/103 green.

---

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking, 1 Rule 1 bug).
**Impact:** Both were inevitable given the cross-phase V17 architecture — surfacing them during Plan 02-06 rather than Plan 02-07 verification is a win.

## Issues Encountered

Pre-existing failures in `llama-server-supervisor.test.ts` (18) and `llama-client.test.ts` (2) remain — tests for the retired local llama-server flow swapped out in commit c84dd61 (Angel → Ollama Cloud glm-5.1:cloud). Out of P1 scope. Flagged.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Wave 2 complete (02-04, 02-05, 02-06 all shipped).
- Plan 02-07 (verification + benchmark gate) unblocked.
- All ported callers support both pre-V17 (legacy FTS5) and post-V17 (artifact_fts) substrates.

## Self-Check

- Files modified: verified on disk.
- `bun run build` clean.
- `bun run test` — 2405 relevant tests green (20 pre-existing llama failures unchanged).

## Self-Check: PASSED

---
*Phase: 02-p1-artifact-table-unification*
*Completed: 2026-04-20*
