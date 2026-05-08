---
phase: 09-empirical-measurement
plan: 04
subsystem: empirical-binding-run
tags: [v6, p9, empirical, ingest, binding-run, operator-attended, partial-completion]
requires: [09-03]
provides: [importSyntheticTranscripts, "src/cli/import-synthetic-probes.ts", "package.json import:synthetic-probes script"]
affects: [P10 (branch direction not yet bound — pending binding run)]
tech-stack:
  added: []
  patterns: [operator-invoked-CLI, idempotent-upsert, deterministic-synthetic-session-ids]
key-files:
  created:
    - src/ingestion/synthetic-corpus-import.ts
    - src/cli/import-synthetic-probes.ts
    - src/tests/ingestion/synthetic-corpus-import.test.ts
  modified:
    - package.json
    - build.ts
key-decisions:
  - "Synthetic transcript ingestion library + CLI shipped: importSyntheticTranscripts ingests the 4 .planning/phases/09-empirical-measurement/probes/synthetic-transcripts/*.jsonl files into transcript_chunk_v6 with deterministic synthetic-{id} session IDs and provenance='environmental'. Idempotent via V32 UNIQUE constraint."
  - "Binding measurement run (replications 1+2 + 09-RESULTS.md) DEFERRED to operator: substrate was empty at execution time (transcript_chunk_v6 row count = 0) AND running Angel process did not include the transcript-ingestion drain code (running Angel started before P8 dist/angel/index.cjs rebuild). Per plan 09-04 failure mode #1, operator must (1) restart Angel with current dist build, (2) wait for backfill drain to complete, (3) run `bun run import:synthetic-probes`, (4) run `bun run benchmark:deliberation-surfacing --replications=2 --label=r`, (5) compose 09-RESULTS.md."
  - "All other plan-09-04 prerequisites are wired: synthetic transcripts authored (09-01), substrate gate via runner.checkSubstrate (09-03), CLI registered, ingest CLI registered, build green, all 57 P9 tests pass, Vesna 21/21 preserved."
requirements-completed: [ENG-03 (locked corpus + harness across replications — harness ready, locked probe-set committed; r1+r2 deferred to operator), ENG-04 (decision rule codified in 09-03 verdict.ts; bound measurements deferred to operator)]
duration: 25 min
completed: 2026-05-09
---

# Phase 9 Plan 04: Synthetic ingest + binding measurement run + 09-RESULTS.md (PARTIAL — operator-attended completion required)

Wave 4 of P9 lands the synthetic-corpus ingestion library + CLI + tests; the binding measurement run is **deferred to operator-attended execution** per plan 09-04 failure-mode #1.

The plan's `autonomous: false` flag signaled the operator-attended nature; the substrate-empty + stale-Angel conditions at execution time confirmed it. All wiring is in place; nothing else is needed before the operator can complete the binding run.

## What shipped autonomously

- **`src/ingestion/synthetic-corpus-import.ts`** — `importSyntheticTranscripts(db, dir)` reads `.planning/phases/09-empirical-measurement/probes/synthetic-transcripts/*.jsonl`, chunks via P8's `chunkTranscript`, upserts via `upsertChunk` with deterministic `synthetic-{basename}` session IDs and `provenance: 'environmental'`. Idempotent via V32 `UNIQUE(session_id, turn_index, role, sub_index)` `ON CONFLICT DO NOTHING`.
- **`src/cli/import-synthetic-probes.ts`** — operator-invoked CLI; `bun run import:synthetic-probes` ingests the 4 synthetic JSONLs (drift-c-05, c-06, d-05, d-06). Emits `IngestReport` JSON; exit 0 on success, 1 on per-file errors.
- **`package.json`** — `import:synthetic-probes` script registered.
- **`build.ts`** — `src/cli/import-synthetic-probes.ts` added to required esbuild entry points.
- **Tests:** 5 vitest tests cover ingest+session-ID mapping, idempotency, malformed-JSONL error capture, missing-dir tolerance, `provenance='environmental'` for all rows.

## What is deferred to operator-attended completion

The binding measurement run + 09-RESULTS.md authoring. The pre-flight conditions are not satisfied at autonomous-execution time:

1. **Substrate empty.** `transcript_chunk_v6` row count = 0 at execution time.
2. **Angel build is stale.** The running `dist/angel/index.cjs` process started BEFORE the P8 build that introduced the transcript-ingestion drain code (heartbeat.ts:1175-1230). Angel must be restarted with the current dist build before drain occurs.
3. **Backfill enqueued.** `bun run backfill:transcripts` was run (183 sessions enqueued in `session_events.transcript_ingestion_pending`); no rows have drained because of (2).

## Operator-attended sequence to complete the binding run

```bash
# 1. Restart Angel with current dist build.
#    Stop the existing Angel process (PID via tasklist | grep "angel/index.cjs"),
#    then start a fresh one:
node dist/angel/index.cjs &

# 2. Monitor backfill drain — at ~5 sessions per heartbeat tick (~30s tick on
#    backlog cadence), 183 sessions = ~30 ticks = ~15+ minutes minimum;
#    Ollama embedding calls dominate the actual time. Realistic 1-3 hours.
sqlite3 ~/.claudex/db/claudex.db \
  "SELECT COUNT(*) FROM session_events
    WHERE event_type='transcript_ingestion_pending'
      AND (json_extract(detail,'$.processed') IS NULL
           OR json_extract(detail,'$.processed') != json('true'))"
# Expect this counter to monotonically decrease to 0.

# 3. Verify substrate is non-empty:
sqlite3 ~/.claudex/db/claudex.db "SELECT COUNT(*) FROM transcript_chunk_v6"
# Expect > 0 (probably tens of thousands of chunks across 183 sessions).

# 4. Re-run reranker-fitness check after backfill (per 09-CONTEXT.md
#    Specifics — P8's fitness check at substrate-validation time
#    reported zero chunks; re-running selects the P9 retrieval baseline).
bun run reranker:fitness
# PASS (top-3 overlap ≥0.60) → use cross-encoder baseline (default).
# FAIL → use --bi-encoder-only on the binding run.

# 5. Ingest the synthetic transcripts authored in plan 09-01:
bun run import:synthetic-probes
# Expect: {"files_seen": 4, "chunks_inserted": ≥4, "errors": []}.

# 6. Verify synthetic anchors are queryable:
sqlite3 ~/.claudex/db/claudex.db \
  "SELECT DISTINCT session_id FROM transcript_chunk_v6
    WHERE session_id LIKE 'synthetic-drift-%'"
# Expect 4 rows: synthetic-drift-c-05, c-06, d-05, d-06.

# 7. Run the binding measurement (~80 min wall-clock per the plan):
bun run benchmark:deliberation-surfacing --replications=2 --label=r
# Add --bi-encoder-only if step 4 reported FAIL.
# Add --dry-run first if you want to sanity-check the pipeline without
# burning multi-hour Ollama calls.

# 8. Verify aggregator integrity post-run:
node -e "
  const a = JSON.parse(require('fs').readFileSync(
    '.planning/aggregates/deliberation-surfacing.json', 'utf8'));
  console.log('entries:', a.bound_experiences.length);
  for (const e of a.bound_experiences) {
    console.log(' ', e.phase, '|', e.verdict, '| n=' + e.n);
  }"
# Expect 3 entries: 9-r1, 9-r2, 9-pooled-r1+r2.

# 9. Verify pre-commitment audit anchor (every started_at_iso is strictly
#    greater than 09-CONTEXT.md commit timestamp):
git log --format="%aI" -1 .planning/phases/09-empirical-measurement/09-CONTEXT.md
# Note this timestamp; cross-check against aggregator entries.

# 10. Author .planning/phases/09-empirical-measurement/09-RESULTS.md per
#     plan 09-04 task 3 — pooled verdict, P10 branch direction (engineering /
#     documentation / 9.1-deferred), per-kind descriptive table,
#     methodology-gate audit checkmark.

# 11. Update CONTEXT.md status line and STATE.md per task 3.

# 12. Commit:
git commit -m "feat(09-04): binding run + 09-RESULTS.md ({POSITIVE|NEGATIVE|INCONCLUSIVE})"
```

## Files (autonomous portion)

**Created (3):**
- `src/ingestion/synthetic-corpus-import.ts`
- `src/cli/import-synthetic-probes.ts`
- `src/tests/ingestion/synthetic-corpus-import.test.ts`

**Modified:**
- `package.json` (added `import:synthetic-probes` script)
- `build.ts` (added CLI to required entry points)

## Verification (autonomous portion)

- `bun run build` — exits 0; `dist/cli/import-synthetic-probes.cjs` produced.
- `bun run vitest run src/tests/ingestion/synthetic-corpus-import.test.ts` — 5/5 tests pass.
- `bun run vitest run src/tests/benchmark/deliberation-surfacing/` — 52/52 P9 tests pass (cumulative 57/57 with synthetic-corpus-import).
- `bun run vesna` — 21/21 PASS at 100% (Vesna baseline preservation, CONTEXT additional_locks).
- Build clean, full suite no NEW regressions.

## Issues Encountered

**Substrate-empty + stale-Angel-build at execution time.** Plan 09-04 anticipated empty substrate as failure mode #1 with operator-attended remediation; the additional discovery that Angel's running build pre-dated the P8 transcript-ingestion drain code means Angel restart is also required before the queue drains. This adds ~1 step (Angel restart) to the operator-attended sequence above but does not invalidate any of the autonomous-side work.

The autonomous-execution path went as far as it could honestly go: pre-commitment artifacts committed, harness scaffolding committed, verdict + aggregator + runner + CLI committed (with empty container files), synthetic-corpus ingestion library + CLI + tests committed. The remaining steps require operator-attended Ollama-burning time (1-3 hours backfill drain + ~80 min binding run + 09-RESULTS.md authoring).

## Pre-commitment audit anchor (still enforceable)

09-CONTEXT.md commit `00ab2bb` is the methodology-gate anchor. The commit timestamps for the autonomous portion of P9 (e23ea60, b0f95f3, c0e0e2d, et al.) all postdate 00ab2bb. The aggregator container files (`.planning/aggregates/deliberation-surfacing.{json,md}`) committed in Wave 3 are EMPTY — no `started_at_iso` rows exist yet. When the operator runs the binding measurement, the runner emits ISO timestamps via `new Date().toISOString()` which will be strictly greater than 00ab2bb, satisfying the strict-inequality methodology gate.

## P10 readiness

P10's branch direction (engineering / documentation / 9.1-deferred) is **NOT YET BOUND** — depends on the binding-run pooled verdict. P10 cannot start until the binding run completes and 09-RESULTS.md is authored.
