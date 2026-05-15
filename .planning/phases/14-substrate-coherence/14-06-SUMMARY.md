---
phase: 14
plan: "06"
subsystem: core/schema
tags: [epoch-ms, migration, V35, canonicalization]
dependency_graph:
  requires: [14-01, 14-02, 14-03, 14-04, 14-05]
  provides: [epoch-ms-canonical-substrate]
  affects: [all-production-queries, all-test-fixtures]
tech_stack:
  added: []
  patterns: [epoch-ms-everywhere, cutoffMs-vs-cutoff-distinction]
key_files:
  created: []
  modified:
    - src/core/migrations.ts
    - src/core/migration-steps.ts
    - src/core/schema.ts
    - src/core/cross-project-search.ts
    - src/angel/retention-sweep.ts
    - src/intelligence/directive-detector.ts
    - src/intelligence/intent-predictor.ts
    - src/core/context-pull-cues.ts
    - src/angel/memory-md-writer.ts
decisions:
  - "TARGET_USER_VERSION = 35 with WHERE guard (< 1e12) preventing double-scaling"
  - "Tables NOT in V35 renames: experience_patterns, decisions, thread_state, checkpoint_tracking, session_events, artifact_access_log, episodic_index_error_fingerprint, artifact_links, verified_facts, project_curated_context"
  - "cutoffMs() returns ms; cutoff() remains seconds — two helpers preserved for their respective domains"
metrics:
  duration: "~4 hours (across two context windows)"
  completed: "2026-05-15T22:14:55Z"
  tasks: 2
  files: 166
---

# Phase 14 Plan 06: Epoch-MS Canonicalization Summary

V35 SQLite migration + full production-code and test-fixture canonicalization of all epoch columns to milliseconds precision. 166 files touched across 2 commits.

## What Was Built

V35 migration renames `*_epoch` columns to `*_epoch_ms` on 16 tables and scales existing second-precision values to milliseconds using a WHERE guard (`< 1e12`) that prevents double-scaling on already-migrated rows.

Tables affected: sessions, observations, learnings, checkpoint_meta, artifact (V17 kernel), episodic_events, telemetry, pressure_scores, schema_versions, session_messages, session_signals, retrieval_events, kind_registry, session_journal, conversation_turns, artifacts.

Tables intentionally NOT renamed (keep `_epoch`): experience_patterns, decisions, thread_state, checkpoint_tracking, critical_rules, session_events, artifact_access_log, episodic_index_error_fingerprint, artifact_links, verified_facts, project_curated_context.

## Commits

- `05e9594` — feat(14-06): V35 migration + epoch-ms canonicalization across production code (62 files)
- `0276a78` — fix(14-06): update test fixtures for epoch-ms canonicalization (V35) (104 files)

## Test Results

Starting state: 38 failed test files (171 tests).
Final state: 5 failed test files (31 tests).

All remaining failures are pre-existing and unrelated to epoch canonicalization:
- `llama-server-supervisor.test.ts` (18 failures): pre-existing llama server tests requiring live binary
- `llama-client.test.ts` (2 failures): pre-existing
- `phase-5-full-gate.test.ts` (7 failures): checks for SUMMARY.md files that don't exist on disk
- `phase-6-5-cross-project-vesna.test.ts` (3 failures): assembleExperienceTier cross-project retrieval, pre-existing
- `phase-12-retrieval-ranking-rebalance.test.ts` (1 failure): `topicalRelevance` cap in `computeArtifactScore` — planned Phase 12 feature not yet implemented in production code

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed cross-project-search.ts epoch column name**
- Found during: test run for recall-server-cross-project-expansion.test.ts
- Issue: `cross-project-search.ts` queried `a.timestamp_epoch` on `artifacts` table (renamed by V35 to `timestamp_epoch_ms`). Query silently failed (wrapped in catch), returning empty candidate pool.
- Fix: Changed to `timestamp_epoch_ms` in SELECT, ORDER BY, and TypeScript type annotation.
- Files modified: `src/core/cross-project-search.ts`
- Commit: `05e9594`

**2. [Rule 1 - Bug] Fixed directive-detector.ts restatement UPDATE path**
- Found during: directive-schema.test.ts run
- Issue: `UPDATE artifact SET updated_at_epoch = ?` used old column name (renamed to `updated_at_epoch_ms`). UPDATE failed silently (caught), `result.updated` stayed 0.
- Fix: Changed to `updated_at_epoch_ms`
- Files modified: `src/intelligence/directive-detector.ts`
- Commit: `05e9594`

**3. [Rule 1 - Bug] Fixed sections.ts journal sort**
- Found during: test run
- Issue: `formatFlowSection` sorted on `a.timestamp_epoch - b.timestamp_epoch` but `JournalEntry` has `timestamp_epoch_ms`. Sort was a no-op / nonsense.
- Fix: Changed to `timestamp_epoch_ms`
- Files modified: `src/assembly/sections.ts`
- Commit: `05e9594`

### Deferred Items

**Phase-12 topicalRelevance cap**: `computeArtifactScore` in `hybrid-retrieval.ts` does not implement the topical importance cap that `phase-12-retrieval-ranking-rebalance.test.ts` tests. The `topicalRelevance` parameter on `ArtifactScoringContext` is not defined in production code. This was a planned Phase 12 feature that was not implemented. Filed to `deferred-items.md` for Phase 12 follow-up.

## Self-Check

Verifying production code changes:
- `src/core/cross-project-search.ts` — timestamp_epoch_ms in query
- `src/intelligence/directive-detector.ts` — updated_at_epoch_ms in UPDATE
- `src/core/migrations.ts` — TARGET_USER_VERSION = 35
- Commits `05e9594` and `0276a78` exist

## Self-Check: PASSED
