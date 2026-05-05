---
phase: 02-multi-modal-index-seeds-density-check
plan: 03
subsystem: benchmark/backfill
tags: [v5, phase2, idx-01, backfill, sidecar, corpus]
requires: [phase-1-substrate, v26-schema, error-fingerprint-module]
provides: [populated-sidecar, fingerprinted-metadata, corpus-audit]
affects:
  - src/benchmark/episodic-density/types.ts
  - src/benchmark/episodic-density/backfill.ts
  - src/benchmark/episodic-density/cli.ts
  - build.ts
tech-stack:
  added: []
  patterns: [idempotent-backfill, shadow-row-fk-bridge, corpus-origin-tagging]
key-files:
  created:
    - src/benchmark/episodic-density/types.ts
    - src/benchmark/episodic-density/backfill.ts
    - src/benchmark/episodic-density/cli.ts
    - src/tests/benchmark/episodic-density/backfill.test.ts
    - .planning/phases/02-multi-modal-index-seeds-density-check/02-03-corpus-audit.md
  modified:
    - build.ts
key-decisions:
  - "v4 source filter: artifact_type='observation' (the codebase column name; CONTEXT.md item 2's 'kind' maps here). Validated against the live DB where 'observation' is the dominant artifact_type with 8391 rows."
  - "PHASE1_SHIP_TS_EPOCH bound to commit 9434ab9 timestamp = 1777929975 (epoch sec) via 'git show -s --format=%ct'."
  - "Shadow row pattern for v4 backfill: writeEnvironmentalEvent with provenance='environmental', source='backfill/v4-artifact', metadata_json carries source_table+source_row_id+corpus_origin+error_fingerprint. Sidecar FK points to the shadow row id, not the artifact id, so the schema constraint stays consistent."
  - "Idempotency strategy: DELETE-by-(episode_event_id, corpus_origin) before reinserting sidecar rows; json_extract($.source_row_id) lookup for shadow rows; UPDATE refreshes shadow row metadata so re-runs converge on the latest fingerprint."
  - "CLI exit codes: 0 = floor met, 2 = floor not met (soft fail), 1 = hard fail (V26 missing, runtime). Re-runnable by design."
requirements-completed: [IDX-01]
duration: "20 min"
completed: "2026-05-04"
---

# Phase 2 Plan 3: Backfill Module + Corpus Audit Summary

Re-runnable, idempotent backfill from two sources (Phase 1 organic + v4 artifact observations) into the V26 sidecar `episodic_index_error_fingerprint`, plus a CLI runner and a corpus audit document with real numbers from a dry-run against the operator's DB.

## Final filter SQL for v4 artifacts

```sql
SELECT id, project, timestamp_epoch, content
  FROM artifacts
 WHERE artifact_type = 'observation'
   AND content IS NOT NULL
 ORDER BY id ASC
```

The CONTEXT.md item 2 phrasing of "kind='observation'" maps to this codebase's `artifact_type` column. Confirmed at execution time by `pragma table_info(artifacts)` against the live DB — `kind` is not present; `artifact_type` is. Distinct values queried as a sanity check: `observation` dominates at 8391 rows out of ~9420 total.

The per-row `looksLikeStackTrace` heuristic from `src/core/error-fingerprint.ts` is the second-stage filter. CONTEXT discretion explicitly accepts a heuristic that misses some real errors and over-includes some non-errors, because (a) missed fingerprints fall out of the corpus rather than corrupt it, and (b) the auto-pair-labeler in Plan 02-04 uses a stricter test (same outer_exception AND ≥3 frame overlap) for ground truth.

## Final corpus counts (operator's DB at audit time)

- **Phase 1 organic:** 5 fingerprinted / 349 rows scanned (hit rate 1.4%); 1 project covered (`desktop-01dcc792`); 6454 sidecar shingle entries.
- **v4 backfill:** 130 fingerprinted / 8393 observations scanned (hit rate 1.5%); 19 projects covered (claudex, claudex-v3, openclaw-main, multiple Nexus iterations, Vesna, Oracle, Daemon, Lacuna-Betting, Kompas, BigMozzy/Balkan, etc.); 4166 sidecar shingle entries.
- **Total fingerprinted:** 135.
- **Total distinct projects:** 19.
- **Floor met (≥50 + ≥3):** YES — 2.7× the 50-event floor and 6.3× the 3-project floor.

The combined sidecar at full backfill will hold ~10,620 rows across 135 unique `episode_event_id`s.

## Floor met on operator's DB?

**YES.** Plan 02-04 has enough corpus to score Wilson CI deltas at the held-out test-set level the decision rule (CONTEXT item 5) requires. No remediation needed.

## Authentication Gates

None.

## Deviations from Plan

**[Rule 1 - Bug] Test fixture uses production `artifacts` schema, not the plan-suggested minimal table** — Found during: first run of Task 5 tests | Issue: my initial `CREATE TABLE IF NOT EXISTS artifacts` block in the test fixture was a no-op because `initializeSchema(db)` already creates the production `artifacts` table; subsequent INSERTs failed `NOT NULL` and CHECK constraints (`summary`, `state`, etc.). | Fix: dropped the redundant CREATE TABLE; updated INSERT statements to populate the required production columns (artifact_ref, summary, state='fresh', ttl, importance, timestamp_epoch). | Files modified: `src/tests/benchmark/episodic-density/backfill.test.ts`. | Verification: 10/10 tests pass. | Commit hash: `bae5306`.

**[Rule 3 - Blocking] CLI bundle missing from build.ts** — Found during: first attempt to dry-run via `bun run src/benchmark/episodic-density/cli.ts` (which fails because Bun doesn't support better-sqlite3 directly). | Issue: `node dist/benchmark/episodic-density/cli.cjs` is the canonical run path, mirroring `vesna`, `sc3`, `recall`, etc. The CLI source needs to be in `build.ts`'s `optionalEntryPoints` to land as a CJS bundle. | Fix: added the entry. | Files modified: `build.ts`. | Verification: `dist/benchmark/episodic-density/cli.cjs` is generated; `node dist/benchmark/episodic-density/cli.cjs backfill --dry-run` runs cleanly and produces the live counts captured in the audit doc. | Commit hash: `4829540` (folded with backfill source).

**Total deviations:** 2 auto-fixed (Rule 1, Rule 3). **Impact:** None to the spec — both deviations are mechanical fix-ups that aligned the implementation with the existing project conventions.

## Pointer to corpus audit

See `.planning/phases/02-multi-modal-index-seeds-density-check/02-03-corpus-audit.md` for the full numbers, the per-source breakdowns, and the 20-pair manual spot-check checklist (operator-driven, [OPERATOR-FILL]).

## Verification

- `bun run build` clean.
- `bun run test src/tests/benchmark/episodic-density/backfill.test.ts` → 10/10 PASS.
- Full `bun run test` → 3318 passing, 27 pre-existing baseline failures, no new regressions.
- Live dry-run: `node dist/benchmark/episodic-density/cli.cjs backfill --dry-run` exits 0 with `floor_met: true` (135/19 over 50/3 floor).

## Issues Encountered

None directly tied to Plan 02-03.

## Next Phase Readiness

**Plan 02-03 complete.** The corpus is durable, the floor is met by 2.7× / 6.3×, and the audit doc is on disk. Plan 02-04 (A/B/C measurement harness) can run.

Note: When the operator runs the verdict runner from Plan 02-05, the FIRST real run (no `--dry-run`) will write the 130+5 fingerprints to the live DB's metadata_json + sidecar. Plan 02-05's runner is wired to call `runBackfill` if the corpus is empty before measuring — but this is an explicit step, not an opportunistic one.

Ready for Plan 02-04.
