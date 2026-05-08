---
phase: 09-empirical-measurement
plan: 02
subsystem: empirical-harness
tags: [v6, p9, empirical, harness, wilson-reexport, ollama, cross-encoder]
requires: [09-01]
provides: [wilson re-export, types, probe-loader, callJudge, runSummaryArm, runTranscriptArm, runReplication, type RunReplicationOpts]
affects: [09-03, 09-04]
tech-stack:
  added: []
  patterns: [re-export-not-copy, mockable-fetcher, dependency-injected-transports, three-prong-AND-gate, abort-signal-timeout]
key-files:
  created:
    - src/benchmark/deliberation-surfacing/wilson.ts
    - src/benchmark/deliberation-surfacing/types.ts
    - src/benchmark/deliberation-surfacing/probe-loader.ts
    - src/benchmark/deliberation-surfacing/judge.ts
    - src/benchmark/deliberation-surfacing/arm-summary.ts
    - src/benchmark/deliberation-surfacing/arm-transcript.ts
    - src/benchmark/deliberation-surfacing/harness.ts
    - src/tests/benchmark/deliberation-surfacing/judge.test.ts
    - src/tests/benchmark/deliberation-surfacing/arm-summary.test.ts
    - src/tests/benchmark/deliberation-surfacing/arm-transcript.test.ts
    - src/tests/benchmark/deliberation-surfacing/harness.test.ts
key-decisions:
  - "wilson.ts is a re-export from src/benchmark/episodic-density/wilson.ts — NOT a copy. CONTEXT additional_locks: single source of truth for Wilson/Newcombe CI math across all empirical phases."
  - "B-arm reproduces production hybrid-retrieval.ts cross-encoder (port 7439) + bi-encoder fallback fetch shapes verbatim — same fetch URL, same body shape, same AbortSignal.timeout(3000). Branches on opts.useBiEncoderOnly."
  - "Agent + judge models default to deepseek-coder-v2:16b (rotatable via opts). Judge runs at temperature=0 for determinism. Self-grading risk surface noted but mitigated by three-prong rubric (prong 2 requires session_id + turn_index citation that summary-only baseline cannot produce)."
  - "Production-assembly safety: nothing in this plan registers a hook, modifies retrieval-config, mutates production DB outside scoped operations. Library-only — plan 09-03 wraps it in CLI."
  - "Tests use mocked fetchers throughout (vi.fn() / vi.spyOn), in-memory better-sqlite3 + sqlite-vec for B-arm KNN; no live Ollama or DB needed."
requirements-completed: [ENG-01 (engagement metric operationalized; cross-cutting decision rule lands in 09-03 verdict.ts), ENG-03 (locked corpus + harness primitives mockable; aggregator append discipline is 09-03's responsibility)]
duration: 18 min
completed: 2026-05-08
---

# Phase 9 Plan 02: Harness scaffolding (wilson + types + judge + arms + harness) Summary

7 source files + 4 test files land the measurement-only A/B harness primitives. Wave 2 of P9 — the first wave that depends on Wave 1's locked probe-set and judge prompt.

`wilson.ts` is a strict re-export of `wilsonCI`, `wilsonDeltaCI`, `WILSON_Z_95`, and `type CI` from `src/benchmark/episodic-density/wilson.ts`. Per CONTEXT additional_locks, drift here = methodology rot; the discipline holds — there is exactly one CI implementation across all v4-v6 empirical phases.

`judge.ts` calls `deepseek-coder-v2:16b` via Ollama with the locked judge-prompt.md template, parses JSON output (with fenced-markdown tolerance and prose-stripping), and computes `probe_pass = AND of three prongs` (model's own probe_pass claim is ignored). Temperature=0 for determinism. Retry budget covers parse failures but not transport failures.

`arm-summary.ts` invokes the agent through `hybridSearchAsync(db, query, project, opts)` — the existing v4 production read path. NO transcript injection, NO `vec_transcript_chunks_v6` query.

`arm-transcript.ts` reproduces production `src/core/hybrid-retrieval.ts:933-1032` fetch shapes verbatim — Ollama embeddings → vec0 KNN against `vec_transcript_chunks_v6` (with `v.k = ?` clause) → BGE-v2-m3 cross-encoder rerank (port 7439) with bi-encoder fallback when the cross-encoder is unreachable. Branches on `opts.useBiEncoderOnly`. Returns top-K spans with `session_id` + `turn_index` for prong-2 citation.

`harness.ts` orchestrates A-arm + B-arm + judge per probe, returns typed `ReplicationRunResult` with per-probe outcomes + per-arm pass counts + retrieval-baseline tag. Pure with respect to the supplied `db` handle and `opts.fetchers`. NO filesystem writes, NO hook registrations, NO production-DB mutations.

## Files

**Created (11):**
- 7 source files in `src/benchmark/deliberation-surfacing/` (wilson.ts, types.ts, probe-loader.ts, judge.ts, arm-summary.ts, arm-transcript.ts, harness.ts).
- 4 test files in `src/tests/benchmark/deliberation-surfacing/` (judge.test.ts, arm-summary.test.ts, arm-transcript.test.ts, harness.test.ts).

## Verification

- `bun run build` — exits 0.
- `bun run vitest run src/tests/benchmark/deliberation-surfacing/` — 28/28 tests pass (probe-schema 5 + judge 11 + arm-summary 3 + arm-transcript 4 + harness 5).
- `wilson.ts` content is exclusively re-export lines (no math implementation).
- No CC hook registrations introduced.
- All Ollama / cross-encoder / embedding fetchers are dependency-injected via opts.

## Deviations from Plan

[Rule 3 — Blocking] vec0 KNN required `AND v.k = ?` clause — `WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?` alone returned zero rows in tests. Fixed by adding the `v.k = ?` predicate matching the production pattern at `src/embeddings/sqlite-vec-backend.ts:332-334`. Tests verified before commit.

[Rule 1 — Bug] Initial test of `arm-summary` used `vi.mock` factory referencing top-level variable, which vitest hoists incorrectly. Switched to `vi.spyOn` against the imported module — clean separation, no hoist issue.

## Issues Encountered

None blocking — both deviations were caught + fixed during local test runs.

## Next Phase Readiness

Ready for plan 09-03 — `runReplication` returns the typed `ReplicationRunResult` that 09-03's `verdict.ts`, `aggregator.ts`, and `runner.ts` consume. `wilson.ts` re-export is in place for 09-03's `wilsonDeltaCI` calls.
