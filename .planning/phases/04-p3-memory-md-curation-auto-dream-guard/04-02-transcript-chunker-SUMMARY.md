---
phase: 04-p3-memory-md-curation-auto-dream-guard
plan: 02
subsystem: angel
tags: [transcript-chunker, artifact, llm-segment, endsession]

requires:
  - phase: 02-p1-artifact-table-unification
    provides: artifact kernel + kind_registry trigger (transcript_chunk writes here)
provides:
  - Pure module `chunkSessionTranscript(db, sessionId, project): Promise<ChunkResult>`
  - LLM topic-segmenter (`callLocalLLM`, strict JSON) with shape validation + bounds enforcement
  - Soft bounds [3, 20] / hard cap 30 turns per chunk with merge-up + split-down passes
  - Single-chunk fallback path for <3 turns, LLM transport errors, and shape-invalid output
  - Idempotent per-session insert guard (`kind='transcript_chunk' + session_id`)
affects: [04-04 (heartbeat wiring), 04-05 (phase gate), Phase 6b backfill]

tech-stack:
  added: []
  patterns:
    - LLM segmenter with strict-JSON shape validation + deterministic fallback
    - `randomUUID()` artifact ids; `kind_registry` populates via V17 AFTER-INSERT trigger
    - Non-throwing top-level — transport errors counted in `errors`; shape rejects counted as 0

key-files:
  created:
    - src/angel/transcript-chunker.ts
    - src/tests/angel/transcript-chunker.test.ts
  modified: []

key-decisions:
  - "Embeddings deferred to Phase 6b backfill — `embedding_ref` null at insert"
  - "First-segment below soft-min merges INTO successor and inherits successor's label"
  - "Continuation spans on oversize split keep suffix `<label> (cont.)`"
  - "Shape-invalid LLM output (gaps/overlaps) is a deterministic fallback, not an error"
  - "No transaction wrapper around the insert loop — partial writes preferable to aborts"

patterns-established:
  - "chunker API: db + ids → {inserted, skipped, errors}. Callable from heartbeat or /endsession hook identically."
  - "LLM-segmenter shape contract: `{segments:[{start,end,topic_label}]}` with full coverage, no gaps/overlaps — validated by `parseSegmentationResponse`."

requirements-completed:
  - STOR-06
  - EXTR-06

duration: ~1 session
completed: 2026-04-22
---

# Plan 04-02: Transcript Chunker Summary

**Pure-module transcript chunker — LLM topic-segmented artifacts at `/endsession`. Writes `artifact(kind='transcript_chunk')` rows with `turn_range` + `topic_label`; no heartbeat wiring yet (04-04).**

## Performance

- **Completed:** 2026-04-22
- **Tasks:** 6 (scaffold, LLM segmenter, bounds enforcement, insert helper, fallback wiring, test suite)
- **Files created:** 2
- **New tests:** 11 (all pass)
- **Module size:** 424 lines (implementation), 315 lines (tests)

## Accomplishments

- `chunkSessionTranscript` entry point with empty-session and already-chunked early returns plus top-level try/catch.
- Strict-JSON LLM topic-segmenter (`segmentViaLLM`) via `callLocalLLM` with exported `parseSegmentationResponse` for shape validation (full coverage, no gaps/overlaps, integer turn bounds).
- Exported `enforceBounds` merges sub-3-turn segments (first merges into successor and inherits its label; others merge into predecessor) and splits >30-turn segments into 30-turn spans with `(cont.)` continuation labels; defensive coverage-invariant fallback to single chunk.
- `insertChunks` writes one artifact per segment via a single prepared statement, with `turn_range` + `topic_label` in `data`, joined full-text body (no truncation), and last in-segment `timestamp_epoch` for `created_at_epoch`. `embedding_ref` left null — Phase 6b backfill picks up.
- Fallbacks: <3 turns bypass LLM; LLM throws → single chunk + `errors:1`; shape-invalid LLM → single chunk + `errors:0` (deterministic).
- `kind_registry` row for `transcript_chunk` populates implicitly via V17 `artifact_register_kind` AFTER-INSERT trigger — verified in test case 4.

## Task Commits

1. **04-02-01** — `3eb5707` (scaffold — types + early-return guards)
2. **04-02-02** — `fa12cc5` (LLM segmenter + strict JSON parser)
3. **04-02-03** — `d40c8a1` (bounds enforcement + coverage reconciliation)
4. **04-02-04** — `0fab9c2` (artifact insertion helper)
5. **04-02-05** — `cc4f353` (single-chunk fallback wired into main flow)
6. **04-02-06** — `8915e4b` (unit test suite — 11 cases)

## Files Created/Modified

- `src/angel/transcript-chunker.ts` (new, 424 lines) — main module; `chunkSessionTranscript` entry point; exported helpers `parseSegmentationResponse` and `enforceBounds` for direct unit testing without the DB round-trip.
- `src/tests/angel/transcript-chunker.test.ts` (new, 315 lines) — 11-case suite mocking `callLocalLLM` via `vi.mock`, using in-memory SQLite with `initializeSchema` + `applyV17DDL`.

## Test Results

- Targeted: `bun run test src/tests/angel/transcript-chunker.test.ts` — **11/11 pass**.
- Full suite: `bun run test` — **2509 pass / 20 fail**. The 20 failures are all in `src/tests/angel/llama-server-supervisor.test.ts` (18) and `src/tests/angel/llama-client.test.ts` (2), both **pre-existing** and unrelated to this plan (confirmed by running those test files against a clean working tree before my changes). No new regressions introduced.

## Decisions Made

- Kept mocking at the module level (`vi.mock('../../angel/llama-client.js')`) rather than dependency-injecting an `llmFn`. Matches the directive-detector test pattern the plan referenced and keeps the public API surface minimal.
- Exported `parseSegmentationResponse` and `enforceBounds` so future iteration can unit-test them without rebuilding DB fixtures, without widening the runtime API (production callers only need `chunkSessionTranscript`).
- Single `db.prepare` outside the segment loop per plan guidance — no transaction wrapper.
- Used `randomUUID()` from `node:crypto` directly (not the directive-detector's `require('node:crypto').randomFillSync` hand-roll) — simpler and the stricter bundler-compat workaround wasn't needed here.

## Deviations from Plan

None material. Minor clarifications:
- The plan's suggested import snippet included `createHash` — removed since no hashing is needed in this module (Plan 04-01's sentinel hash owns that).
- Prompt text inlined as a module-scope `SEGMENT_SYSTEM_PROMPT` constant rather than composed ad-hoc per call — consistent with how directive-detector loads its system prompt.

## Issues Encountered

None. 11/11 new tests green on first build + run. Build remains ~70ms via esbuild.

## Next Phase Readiness

- Chunker is a pure module — ready for Plan 04-04 heartbeat wiring (queue-consume slot before curation so Recent Threads reads fresh chunks).
- `embedding_ref` is null at insert — Phase 6b's `backfillEmbeddings` must cover `artifact(kind='transcript_chunk')` without any additional wiring (already planned in 04-RESEARCH §1.4).
- `kind_registry` will show `transcript_chunk` after the first real `/endsession` triggers the chunker.

---
*Phase: 04-p3-memory-md-curation-auto-dream-guard*
*Completed: 2026-04-22*
