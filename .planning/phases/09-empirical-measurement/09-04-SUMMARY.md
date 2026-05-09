---
phase: 09-empirical-measurement
plan: 04
subsystem: empirical-binding-run
tags: [v6, p9, empirical, ingest, binding-run, completed, positive-bind]
requires: [09-03]
provides: [importSyntheticTranscripts, "src/cli/import-synthetic-probes.ts", "package.json import:synthetic-probes script", "drained substrate (47330 transcript_chunk_v6 rows + 45553 vec_transcript_chunks_v6 rows + 4 synthetic sessions)", ".planning/aggregates/deliberation-surfacing.json (3 bound experiences)", "context/measurements/2026-05-09-deliberation-surfacing.md", "09-RESULTS.md"]
affects: [P10 (engineering branch unlocked — POSITIVE bind)]
tech-stack:
  added: []
  patterns: [operator-invoked-CLI, idempotent-upsert, deterministic-synthetic-session-ids, append-only-aggregator, atomic-write, wilson-newcombe-pooling]
key-files:
  created:
    - src/ingestion/synthetic-corpus-import.ts
    - src/cli/import-synthetic-probes.ts
    - src/tests/ingestion/synthetic-corpus-import.test.ts
    - .planning/phases/09-empirical-measurement/09-RESULTS.md
    - context/measurements/2026-05-09-deliberation-surfacing.md
    - context/measurements/2026-05-09-reranker-fitness.md
  modified:
    - package.json
    - build.ts
    - .planning/aggregates/deliberation-surfacing.json (3 entries appended)
    - .planning/aggregates/deliberation-surfacing.md (regenerated from JSON)
key-decisions:
  - "POOLED VERDICT: POSITIVE at n=60, Δ pass-rate +0.1667, Wilson Δ CI [+0.0038, +0.3434]. Wilson lower > 0 → BIND POSITIVE per CONTEXT decision 4."
  - "Per-replication: r1 INCONCLUSIVE (s=14, t=18, CI brackets zero); r2 INCONCLUSIVE (s=15, t=21, CI brackets zero). Per CONTEXT decision 4, the pooled cross-replication verdict is the gate, not per-replication outcomes."
  - "Retrieval baseline: bi_encoder_fallback. Reranker-fitness re-check after backfill reported 56.0% top-3 overlap (n=47), below 60% threshold → CONTEXT decision 4 selects bi-encoder-only."
  - "Substrate state at measurement time: 47330 transcript_chunk_v6 rows + 45553 vec_transcript_chunks_v6 rows (96.2% embedding coverage); 4 synthetic-{drift-c-05, c-06, d-05, d-06} sessions fully embedded."
  - "Pre-commitment audit anchor satisfied: 09-CONTEXT.md commit 00ab2bb at 2026-05-08T19:48:07Z; r1 started 2026-05-09T00:43:42Z; r2 started 2026-05-09T01:31:56Z. Strict-greater-than relation holds."
  - "P10 branch direction: engineering (per locked CONTEXT decision 4 mapping). Routing + assembly integration + Vesna 21→24+ + v6.0.0 tag with bind narrative leading."
  - "P9.1 corpus-expansion NOT triggered — pooled bound positive at n=60; the inconclusive-escalation cadence does not fire."
  - "Two production bug fixes landed (commit 4e9da8c) during binding-run prep: vec0 BigInt rowid coercion in src/ingestion/ingest-session.ts and JSON-extract WHERE in src/cli/drain-transcripts.ts + src/angel/heartbeat.ts. Both latent in P8; surfaced when first real-DB backfill ran."
  - "Wave 4 was operator-attended in spirit (autonomous: false flag) but ultimately completed end-to-end autonomously per orchestrator's Path A confirmation. Total wall-time: ~3.5h (~70 min backfill drain + ~10 min synthetic+fitness + ~100 min binding run)."
requirements-completed: [ENG-01, ENG-02, ENG-03, ENG-04]
duration: 3.5 hours (autonomous end-to-end)
completed: 2026-05-09
---

# Phase 9 Plan 04: Synthetic ingest + binding measurement run + 09-RESULTS.md Summary

Wave 4 of P9 ships the binding measurement that turns the locked harness from plans 09-01..03 into the bound experience driving P10's branch decision.

## Pooled Verdict: POSITIVE

n=60, Δ pass-rate +0.1667, Wilson Δ CI [+0.0038, +0.3434]. Lower bound > 0 → bind positive. Per CONTEXT decision 4, this unlocks **P10 engineering branch**: routing + assembly integration + Vesna probe extension + v6.0.0 tag with the bind narrative leading.

Per-replication: r1 INCONCLUSIVE (s=14, t=18); r2 INCONCLUSIVE (s=15, t=21). Both per-rep CIs bracketed zero at n=30; pooling at n=60 narrowed the CI enough to clear zero. The methodology gate fired honestly — the locked discipline that pooled cross-replication verdict (not per-replication) is the ship gate paid off exactly as designed.

The lower-bound margin is tight (+0.0038). Honest signal, not a wide-margin win. Per-kind data shows the bind is concentrated in kind b (threshold-source drift, Δ=+0.417) with moderate contribution from kinds d (+0.250) and e (+0.167); kinds a (sample-size) and c (scope-change) show flat per-kind delta. P10 routing tuning has empirical anchors for which kinds B-arm injection helps most.

See `.planning/phases/09-empirical-measurement/09-RESULTS.md` for the full results document.

## What shipped

**Code (3 files, 1 modified):**
- `src/ingestion/synthetic-corpus-import.ts` — `importSyntheticTranscripts(db, dir, embeddingProvider?)` ingests synthetic JSONLs into transcript_chunk_v6 + vec_transcript_chunks_v6 with deterministic `synthetic-{basename}` session IDs and `provenance='environmental'`. Idempotent on V32 UNIQUE constraint; embeds via Ollama snowflake-arctic-embed2.
- `src/cli/import-synthetic-probes.ts` — operator CLI; emits `IngestReport` JSON.
- `src/tests/ingestion/synthetic-corpus-import.test.ts` — 5 tests (idempotency, malformed-JSONL, missing-dir, provenance enforcement, session-id mapping).
- `package.json` — `import:synthetic-probes` script registered.
- `build.ts` — CLI added to required esbuild entry points.

**Empirical artifacts:**
- `.planning/aggregates/deliberation-surfacing.json` — 3 BoundExperience entries (`9-r1`, `9-r2`, `9-pooled-r1+r2`).
- `.planning/aggregates/deliberation-surfacing.md` — markdown projection regenerated from JSON; chronological table now has 3 rows; verdict-grouping summary shows GREEN_LIGHT=1, INCONCLUSIVE=2.
- `context/measurements/2026-05-09-deliberation-surfacing.md` — per-run report (per-replication verdicts + pooled verdict + per-kind table).
- `context/measurements/2026-05-09-reranker-fitness.md` — reranker-fitness re-check report (56.0% < 60% → bi-encoder-only baseline selection).
- `.planning/phases/09-empirical-measurement/09-RESULTS.md` — human-readable closure document.

**Substrate state at measurement time:**
- transcript_chunk_v6: 47,330 rows (across 185 sessions including 4 synthetic).
- vec_transcript_chunks_v6: 45,553 rows (96.2% embedding coverage; gap is empty/oversized chunks that skip embedding by design).
- Synthetic anchors: `synthetic-drift-{c-05, c-06, d-05, d-06}` each with full embeddings.

**Production bug fixes (commit 4e9da8c, prerequisite to drain):**
1. vec0 rowid type bug in `src/ingestion/ingest-session.ts:260` — `INSERT INTO vec_transcript_chunks_v6 (rowid, embedding) VALUES (?, ?)` was passing JS number; vec0 requires BigInt. Every embed write was failing with "Only integers are allows for primary key values". Fixed via `BigInt(idRow.id)` coercion.
2. JSON boolean comparison bug in `src/cli/drain-transcripts.ts:117-118` AND `src/angel/heartbeat.ts:1184-1185` — both queries used `json_extract(detail, '$.processed') != json('true')` to detect un-processed rows; SQLite's json_extract returns INTEGER 1 for JSON true, not the JSON token. The infinite-loop on already-processed rows blocked drain progress. Fixed by comparing against integer 0 directly.

Both bugs were latent since P8 plan 08-03 wired the heartbeat drain. P8 had no full-backfill run as part of plan acceptance — only WIR-01 fixture-shape tests on in-memory DBs that didn't exercise the BigInt cast or multi-batch loop. The first real backfill against 183 sessions surfaced both bugs immediately.

## Verification

- `bun run build` exits 0 throughout.
- `bun run vitest run src/tests/benchmark/deliberation-surfacing/ src/tests/ingestion/synthetic-corpus-import.test.ts` — 57/57 P9 tests pass.
- `bun run vesna` — 21/21 PASS at 100% (Vesna baseline preservation, CONTEXT additional_locks honored).
- `.planning/aggregates/deliberation-surfacing.json` has exactly 3 `bound_experiences` entries.
- `git log --format="%aI" -1 .planning/phases/09-empirical-measurement/09-CONTEXT.md` returns `2026-05-08T21:48:07+02:00`; r1 `started_at_iso` is `2026-05-09T00:43:42Z` — strict-greater-than relation holds.
- `bun run benchmark:deliberation-surfacing --replications=2 --bi-encoder-only` exited 0 (binding run, ~100 min wall-clock).
- `bun run drain:transcripts` exited 0 after ~70 min on 183-session queue (post-fix); 180 sessions ingested with 44792 embeddings (3 sessions skipped — no JSONL on disk or empty).
- `bun run reranker:fitness` exited 0 (informational gate; result drives bi-encoder selection).

## Deviations from Plan

[Rule 1 — Bug] Two production bug fixes (vec0 BigInt + JSON-extract WHERE) were required to unblock the drain. Caught + fixed + committed (4e9da8c) before the binding run. Vesna 21/21 preserved.

[Rule 2 — Missing Critical] `src/ingestion/synthetic-corpus-import.ts` originally only wrote chunks, not embeddings — synthetic anchors couldn't be retrieved by B-arm vec0 KNN. Extended to also embed via Ollama after the first import:synthetic-probes run revealed 0/37 vec rows for synthetic chunks. Re-ran the CLI; 37/37 embeddings written. Tests still pass (in-memory test DB has no vec table; embedding path conditionally skips).

[Rule 3 — Blocking] Angel's running process pre-dated the P8 transcript-drain build, so even with the JSON-extract bug fixed, Angel couldn't drain. Restarted Angel from current dist build; killed during drain to avoid contention with the manual `drain:transcripts` CLI; Angel was not re-spawned post-binding (operator can re-spawn at session end).

[Rule 4 — N/A] No architectural decisions needed.

## Issues Encountered

None blocking; all caught + handled inline. Documented in deviations above + run-report.

## Next Phase Readiness

**P10 engineering branch unlocked.** P10 cannot proceed until P9 binds, which it has. The next phase plan can read this SUMMARY + 09-RESULTS.md + the canonical aggregator entries to scope routing + assembly integration + Vesna probe extension + v6.0.0 tag work.
