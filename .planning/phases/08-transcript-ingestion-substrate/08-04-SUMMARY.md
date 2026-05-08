---
phase: 08-transcript-ingestion-substrate
plan: 04
subsystem: ingestion-cli
tags: [v6, transcript-substrate, backfill, reranker-fitness, cli]
requires: [08-02]
provides: [enumerateArchiveSessions, runBackfill, computeRerankerFitness, FitnessReport, two CLI entrypoints, two npm scripts]
affects: [08-05]
tech-stack:
  added: []
  patterns: [operator-invoked CLI, mtime-ordered enumeration, idempotent backfill via session_id skip, reachability probe before bulk loop]
key-files:
  created:
    - src/ingestion/backfill-archive.ts
    - src/ingestion/reranker-fitness-check.ts
    - src/cli/backfill-transcripts.ts
    - src/cli/reranker-fitness.ts
    - src/tests/ingestion/backfill-archive.test.ts
    - src/tests/ingestion/reranker-fitness-check.test.ts
  modified:
    - package.json
    - build.ts
key-decisions:
  - "Backfill is operator-invoked, not auto-run. Multi-hour Ollama load — operator chooses the moment."
  - "Reranker fitness is informational, never a ship blocker — sets P9's reranker default per CONTEXT decision 4. Below-threshold means P9 uses bi-encoder-only baseline; substrate is fine either way."
  - "Reachability probe up-front (one cheap call before sampling 50 chunks) so unreachable reranker fails fast instead of wasting 50 timeouts."
requirements-completed: [TRX-03]
duration: 11 min
completed: 2026-05-08
---

# Phase 8 Plan 04: Backfill + Reranker Fitness CLIs Summary

Two operator-invoked CLIs backed by reusable library functions. Backfill enumerates `~/.claude/projects/**/*.jsonl` and floods Angel's heartbeat queue. Reranker fitness samples 50 transcript chunks and reports BGE-v2-m3 vs arctic-embed2 top-3 overlap, writing a markdown report.

## What changed

- **`src/ingestion/backfill-archive.ts`** (NEW) — `enumerateArchiveSessions(rootDir?)` walks `~/.claude/projects/{project}/{session_id}.jsonl` (default root = `os.homedir()/.claude/projects`), sorts by mtime ascending, returns `SessionRef[]` with file size + mtime. `runBackfill(db, refs, opts?)` enqueues each ref via `enqueueSessionIngestion`, skipping any session that already has at least one `transcript_chunk_v6` row (idempotent re-run guard). Optional `onProgress` callback fires every `progressEvery` records + final.
- **`src/cli/backfill-transcripts.ts`** (NEW) — `bun run backfill:transcripts`. Prints session count + total size + top-10 projects, optionally `--dry-run` (no DB writes), `--root <path>` for tests. Tested live: 352.5 MB across 9 projects on this install.
- **`src/ingestion/reranker-fitness-check.ts`** (NEW) — `computeRerankerFitness(db, opts?)`. Samples `sampleSize=50` random chunks from `transcript_chunk_v6`, derives synthetic queries from each chunk's first sentence (≤200 chars), builds 20-chunk candidate pools (source + 19 random others), scores cross-encoder via fetch to `127.0.0.1:7439/rerank` and bi-encoder via cosine over arctic-embed2 vectors, computes top-3 overlap per query and mean across all. `PASS_THRESHOLD = 0.60`. Reachability probe (one call up-front) avoids 50 wasted timeouts. Writes one `telemetry` row of `event_kind='reranker_fitness_check_completed'` on success (silently dropped if event_kind CHECK enum doesn't admit yet).
- **`src/cli/reranker-fitness.ts`** (NEW) — `bun run reranker:fitness`. Writes markdown report to `context/measurements/{date}-reranker-fitness.md` with verdict + per-query overlap bucket histogram. Tested live: zero chunks → "run backfill first" message + clean exit.
- **`package.json`** — added two npm scripts: `backfill:transcripts` and `reranker:fitness`.
- **`build.ts`** — added two CLI entry points to the required list.
- **`src/tests/ingestion/backfill-archive.test.ts`** — 10 tests: empty root, 6-ref enumeration across 3×2 projects, non-jsonl filtering, mtime-ordered output, runBackfill enqueueing, skip-already-ingested, progress callback cadence, CLI arg parsing (`--dry-run`/`-n`/`--root`).
- **`src/tests/ingestion/reranker-fitness-check.test.ts`** — 10 tests: reachability=false on probe failure, reachable=true with mock client, mean overlap bounds [0,1], `pass` threshold logic, telemetry row tolerated-absent path, empty-chunks fast return, CLI argument parsing for `--sample` / `--out` / invalid input.

## Verification

- `bun run build` exits 0 (CLIs compile to `dist/cli/backfill-transcripts.cjs` + `dist/cli/reranker-fitness.cjs`).
- `bun run vitest run src/tests/ingestion/backfill-archive.test.ts src/tests/ingestion/reranker-fitness-check.test.ts` — 20/20 pass.
- `bun run backfill:transcripts --dry-run` runs against live DB without error and prints session count summary.
- `bun run reranker:fitness` runs against live DB without error and reports clearly when no chunks are available.
- Hook-safety guard: `grep -rn 'backfill-transcripts\|reranker-fitness' src/adapters/cc-hooks/` returns nothing — operator-only.

## Deviations from Plan

**Total deviations:** None — plan executed exactly as written. The reachability probe (one `rerank` call before the 50-chunk loop) was implied by the "3s timeout — same shape as hybrid-retrieval.ts's fallback path" guidance and avoids the ergonomic disaster of waiting 50×3s = 2.5 min on an unreachable reranker.

## Authentication Gates

None.

## Issues Encountered

None.

## Next Phase Readiness

Ready for Plan 08-05 (WIR-01 wire-test + Mem0-trap closure + ship close-out). The substrate is complete; 08-05 lands the live-wiring ship gate, the Mem0-trap structural-closure assertion, and flips STATE.md + ROADMAP.md to Phase 8 SHIPPED.

**Duration:** 11 min
**Tasks completed:** 2/2
**Files created:** 6
**Files modified:** 2 (package.json, build.ts)
**Commits:** 1 (`f0f303d feat(08-04): full-archive backfill CLI + reranker-fitness CLI ...`)
