---
phase: 09-empirical-measurement
plan: 03
subsystem: empirical-verdict-aggregator-cli
tags: [v6, p9, empirical, verdict, aggregator, cli, append-only]
requires: [09-02]
provides: [computeReplicationVerdict, poolReplications, perKindBreakdown, appendReplication, appendPooledSummary, loadAggregator, renderAggregatorMarkdown, runBindingMeasurement, checkSubstrate, "src/cli/benchmark-deliberation-surfacing.ts", "package.json benchmark:deliberation-surfacing script", "empty .planning/aggregates/deliberation-surfacing.{json,md} containers"]
affects: [09-04]
tech-stack:
  added: []
  patterns: [atomic-write-tmp-rename, append-only-aggregator, INCONCLUSIVE-verdict-extension, substrate-check-gate, dry-run-mocked-transports]
key-files:
  created:
    - src/benchmark/deliberation-surfacing/verdict.ts
    - src/benchmark/deliberation-surfacing/aggregator.ts
    - src/benchmark/deliberation-surfacing/aggregator-renderer.ts
    - src/benchmark/deliberation-surfacing/runner.ts
    - src/cli/benchmark-deliberation-surfacing.ts
    - .planning/aggregates/deliberation-surfacing.json
    - .planning/aggregates/deliberation-surfacing.md
    - src/tests/benchmark/deliberation-surfacing/verdict.test.ts
    - src/tests/benchmark/deliberation-surfacing/aggregator.test.ts
    - src/tests/benchmark/deliberation-surfacing/runner.test.ts
  modified:
    - package.json
    - build.ts
key-decisions:
  - "Verdict computation uses wilsonDeltaCI: lower > 0 → POSITIVE, upper < 0 → NEGATIVE, brackets zero → INCONCLUSIVE. Pooling sums pass counts across replications via the same Wilson/Newcombe binding."
  - "Aggregator mirrors src/benchmark/episodic-density/aggregator.ts atomic-write + append-only contract verbatim. Markdown derived from JSON; prior content preserved byte-identical; Interpretive History prepended by closing phases."
  - "INCONCLUSIVE added to AggregatorVerdict union (new for v6 P9). Mapping: POSITIVE → GREEN_LIGHT, NEGATIVE → KILL, INCONCLUSIVE → INCONCLUSIVE."
  - "Substrate gate via checkSubstrate prevents B-arm runs against empty vec_transcript_chunks_v6 — exits with operator-actionable 'run backfill first' message + exit code 2."
  - "CLI defaults: replications=2, top-K=5, label='r', project='claudex-v3'. --dry-run uses mocked Ollama transports + skips aggregator writes. --bi-encoder-only flag controls retrieval baseline."
  - "Empty aggregator container files committed at .planning/aggregates/deliberation-surfacing.{json,md}. NO rows yet — CONTEXT additional_locks pre-commitment audit anchor (09-CONTEXT.md commit 00ab2bb) still binds against actual measurement timestamps in plan 09-04."
requirements-completed: [ENG-03, ENG-04]
duration: 24 min
completed: 2026-05-08
---

# Phase 9 Plan 03: Verdict + aggregator + runner + CLI Summary

5 source files + 3 test files + 2 empty aggregator containers + 1 CLI + package.json + build.ts wiring. Wave 3 of P9 — turns plan 09-02's `ReplicationRunResult` into binding decisions and an audit-anchored append-only record.

`verdict.ts` codifies CONTEXT decision 4 verbatim: Wilson lower > 0 → POSITIVE, Wilson upper < 0 → NEGATIVE, CI brackets zero → INCONCLUSIVE. The per-kind breakdown is `descriptive_only: true`-tagged so consumers cannot accidentally use it as a ship gate (CONTEXT additional_locks: pooled cross-kind verdict is the only gate).

`aggregator.ts` mirrors `src/benchmark/episodic-density/aggregator.ts` atomic-write discipline (tmp+rename with try/finally cleanup). Schema mirrors `multi-handle.json`'s `BoundExperience` shape; INCONCLUSIVE is added as a new verdict label specific to v6 P9. `appendReplication` and `appendPooledSummary` are the sole write entry points; both load → append → write via atomic rename.

`aggregator-renderer.ts` regenerates the .md from the .json after each append. The chronological table grows monotonically; the Interpretive History section is preserved byte-identical from prior .md content (read via `readInterpretiveHistory`).

`runner.ts` exposes `runBindingMeasurement(opts) → BindingMeasurementResult`. Substrate check gates against `transcript_chunk_v6` row count > 0 (informational message + exit 2 if empty). For each replication: `runReplication` → `computeReplicationVerdict` → `appendReplication`. After all: `poolReplications` → `appendPooledSummary` (only when replications > 1). Markdown report at `context/measurements/{date}-deliberation-surfacing.md`. Mockable end-to-end via injected fetchers + override aggregator paths.

CLI at `src/cli/benchmark-deliberation-surfacing.ts` wires `runBindingMeasurement` with flag parsing (`--replications`, `--label`, `--bi-encoder-only`, `--probes-dir`, `--top-k`, `--project`, `--dry-run`, `--help`). Exit 0 success, exit 2 on substrate empty (operator must run backfill first), exit 1 on hard failure.

Empty aggregator container files committed at `.planning/aggregates/deliberation-surfacing.{json,md}` — these are the targets that plan 09-04's actual measurement run will populate. Their commit timestamp is bounded above by 09-CONTEXT.md commit 00ab2bb; the strict-greater-than relation between `started_at_iso` (run-time, written by 09-04) and the anchor commit holds.

## Files

**Created (10):**
- 4 source files: `verdict.ts`, `aggregator.ts`, `aggregator-renderer.ts`, `runner.ts`.
- 1 CLI: `src/cli/benchmark-deliberation-surfacing.ts`.
- 2 aggregator containers: `.planning/aggregates/deliberation-surfacing.json` (empty `bound_experiences: []`), `.planning/aggregates/deliberation-surfacing.md` (header + empty table).
- 3 test files: `verdict.test.ts` (8 tests), `aggregator.test.ts` (8 tests), `runner.test.ts` (8 tests).

**Modified:**
- `package.json` — added `benchmark:deliberation-surfacing` script entry.
- `build.ts` — added `src/cli/benchmark-deliberation-surfacing.ts` to esbuild required entry points.

## Verification

- `bun run build` exits 0; `dist/cli/benchmark-deliberation-surfacing.cjs` produced.
- `bun run vitest run src/tests/benchmark/deliberation-surfacing/` — 52/52 P9 tests pass (probe-schema 5 + judge 11 + arm-summary 3 + arm-transcript 4 + harness 5 + verdict 8 + aggregator 8 + runner 8).
- `.planning/aggregates/deliberation-surfacing.json` is valid JSON with `bound_experiences.length === 0`.
- `.planning/aggregates/deliberation-surfacing.md` contains chronological table header + empty rows + verdict-grouping-summary + Interpretive History stub.
- `package.json` script entry registered.
- P2-precedent test passes: `summary=12, transcript=15, n=30` → INCONCLUSIVE (the lower-bound discipline holds).

## Deviations from Plan

[Rule 3 — Blocking] `build.ts` required updating to include `src/cli/benchmark-deliberation-surfacing.ts` in `requiredEntryPoints` — without it, esbuild does not produce `dist/cli/benchmark-deliberation-surfacing.cjs` and the CLI won't run via `node dist/cli/...cjs`. Caught and fixed; tests verified end-to-end.

## Issues Encountered

None blocking.

## Next Phase Readiness

Ready for plan 09-04 — the runner is wired, the CLI is registered, the aggregator container files exist, the substrate gate prevents accidental empty-substrate runs. Plan 09-04 ingests synthetic transcripts, runs r1+r2 against the live DB, and authors 09-RESULTS.md.
