---
phase: 08-transcript-ingestion-substrate
plan: 02
subsystem: ingestion
tags: [v6, transcript-substrate, chunker, redaction, upsert]
requires: [08-01]
provides: [chunkTranscript, ChunkV6, JsonlTurn, SOFT_TOKEN_LIMIT, upsertChunk]
affects: [08-03, 08-04, 08-05]
tech-stack:
  added: []
  patterns: [pure-function chunker, parseWrappers single-source-of-truth, ON CONFLICT DO NOTHING, cachedPrepare]
key-files:
  created:
    - src/ingestion/transcript-chunker-v6.ts
    - src/ingestion/upsert-chunk.ts
    - src/tests/ingestion/transcript-chunker-v6.test.ts
    - src/tests/ingestion/upsert-chunk.test.ts
  modified: []
key-decisions:
  - "Sentence integrity preserved on long turns: sentences exceeding SOFT_TOKEN_LIMIT stay intact rather than word-splitting (rare in practice; degrading retrieval precision on edge cases is preferable to corrupting sentence semantics)."
  - "Empty-after-strip turns still emit a single chunk with empty body — predictable ingestion shape; downstream embedder no-ops on empty text already."
requirements-completed: [TRX-02, TRX-04]
duration: 11 min
completed: 2026-05-08
---

# Phase 8 Plan 02: chunkTranscript + upsertChunk Summary

Two ingestion-side modules + their test suites. The chunker is pure (no DB, no I/O, no clock reads) and emits one chunk per turn by default with ascending `sub_index` sentence-boundary sub-chunks on long turns. `upsertChunk` is the exported write surface that plan 08-05's WIR-01 wire-tests will exercise against V17-collapsed + base-table fresh-DB fixtures.

## What changed

- **`src/ingestion/transcript-chunker-v6.ts`** — `chunkTranscript(turns: JsonlTurn[]): ChunkV6[]`. Imports `parseWrappers` once per turn, sets `wrapper_redacted = injected.length > 0`, uses `organic` as the chunk body. `splitAtSentences` greedy-packs sentences under SOFT_TOKEN_LIMIT (1500 tokens via the `~0.75 tokens-per-word` proxy used elsewhere in the codebase). Sentence-split regex `/(?<=[.!?])\s+/`. Sentences exceeding the limit themselves stay intact (rare in practice; preserves retrieval semantics).
- **`src/ingestion/upsert-chunk.ts`** — `upsertChunk(db, chunk)`. Single `INSERT ... ON CONFLICT(session_id, turn_index, role, sub_index) DO NOTHING` via `cachedPrepare`. CHECK violations propagate (no swallowed throws — closed-enum `role` and `provenance` are structural per V32, bad values are bugs).
- **`src/tests/ingestion/transcript-chunker-v6.test.ts`** — 11 pure-function tests: empty input, single-chunk turn, system-reminder strip, 5000-token sentence-boundary split (ascending sub_index, sentence integrity), multi-modality wrapper strip (`<command-message>` + `<file-content>`), every `KNOWN_WRAPPER_TAGS` variant, provenance pass-through, idempotency/determinism, identity preservation across sub-chunks, empty-after-strip, no-whitespace-between-wrappers.
- **`src/tests/ingestion/upsert-chunk.test.ts`** — 10 DB-write tests on in-memory V32 DBs: round-trip, idempotency, sub_index disambiguation, provenance/role CHECK violations, wrapper_redacted boolean→INTEGER round-trip, all four valid provenance values, all four valid role values, 1000-chunk bulk benchmark under 1s.

## Verification

- `bun run build` exits 0.
- `bun run vitest run src/tests/ingestion/` — 21/21 pass (~525ms total).
- Purity guard: `transcript-chunker-v6.ts` has no `better-sqlite3` or `Database` import.
- `parseWrappers` import: exactly one in chunker, one call site per turn.

## Deviations from Plan

**Total deviations:** None — plan executed exactly as written. The chunker's defensive single-chunk emission for empty-after-strip turns was a documentable decision (called out in `key-decisions`) but was implied by the plan's "do not over-engineer" guidance for rare edge cases.

## Authentication Gates

None.

## Issues Encountered

None.

## Next Phase Readiness

Ready for Plan 08-03 (SessionEnd hook + Angel boundary-detector + heartbeat drain). The exported write surface is in place; 08-03 wires it into the live boundary-close pipeline.

**Duration:** 11 min
**Tasks completed:** 2/2
**Files created:** 4
**Files modified:** 0
**Commits:** 1 (`818e080 feat(08-02): chunkTranscript + upsertChunk ...`)
