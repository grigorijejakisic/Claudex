---
phase: 08-transcript-ingestion-substrate
plan: 03
subsystem: ingestion-wiring
tags: [v6, transcript-substrate, hook, heartbeat, queue-drain]
requires: [08-02]
provides: [enqueueSessionIngestion, ingestSession, SessionEnd-hook wiring, heartbeat drain loop]
affects: [08-04, 08-05]
tech-stack:
  added: []
  patterns: [enqueue-then-drain, json_set queue marker, per-session try/catch, sqlite_master vec table probe]
key-files:
  created:
    - src/ingestion/ingest-session.ts
    - src/tests/ingestion/ingest-session.test.ts
    - src/tests/integration/phase-8-ingestion-hook.test.ts
  modified:
    - src/adapters/cc-hooks/session-end.ts
    - src/angel/heartbeat.ts
    - src/core/session-events.ts
key-decisions:
  - "Hook stays fast — only enqueues. Heartbeat owns chunking + embedding work, LIMIT 5 sessions per tick (matches memory_curation drain budget)."
  - "Per CONTEXT decision 5: ingestion fires on clean_endsession only via the SessionEnd hook path. Crash-killed sessions reach the same path on re-open + next clean exit."
  - "Boundary-detector enqueue NOT wired in P8 — see Deviations Rule 4 deferral."
  - "Embedding failures degrade to metadata-only rows (non-fatal); sqlite-vec unavailability detected via sqlite_master probe so test envs without the extension still pass."
requirements-completed: [TRX-01, TRX-03]
duration: 16 min
completed: 2026-05-08
---

# Phase 8 Plan 03: Hook + boundary + heartbeat wiring Summary

Wires the substrate from 08-02 into the live boundary-close pipeline. SessionEnd hook calls `enqueueSessionIngestion` after `emitCleanEndsessionClose`; Angel's `heartbeatTick` drains the queue at 5 sessions per tick and runs `ingestSession` (JSONL → chunker → arctic-embed2 → upsertChunk + vec0 INSERT) out-of-band.

## What changed

- **`src/ingestion/ingest-session.ts`** (NEW) — `enqueueSessionIngestion` (single `session_events` INSERT, milliseconds) and `ingestSession` (async, reads JSONL, parses turns via `parseSessionJsonl`, runs `chunkTranscript`, embeds each chunk via `EmbeddingProvider`, upserts metadata + vec0 rows). Returns `{ chunksWritten, embeddingsWritten, errors }` for the heartbeat to write into the queue row's detail JSON. Per-chunk try/catch keeps one bad chunk from aborting a session.
- **`src/adapters/cc-hooks/session-end.ts`** — adds `enqueueSessionIngestion(ctx.db, input.session_id, ctx.project, getTranscriptPath(input))` immediately after `emitCleanEndsessionClose`. Wrapped in its own try/catch with `emitErrorTelemetry` matching the shape of the existing `memory_curation_pending` enqueue at lines 41–54.
- **`src/angel/heartbeat.ts`** — adds a Phase 8 drain phase right after the Phase 6 boundary tick (line ~1175). Selects up to 5 unprocessed `transcript_ingestion_pending` rows ordered by id, resolves the JSONL path (from detail.jsonl_path or `~/.claude/projects/{project}/{sessionId}.jsonl` fallback), runs `ingestSession`, and stamps the queue row's detail with `processed=true`, `chunks_written`, `embeddings_written`, `errors`. Per-session try/catch with `episodic_write_failure` telemetry. New module-level `resolveJsonlPath` helper at the bottom of the file.
- **`src/core/session-events.ts`** — adds `'transcript_ingestion_pending'` to the EventType enum.
- **`src/tests/ingestion/ingest-session.test.ts`** — 10 tests: enqueue row shape (event_type, entity, action, detail JSON), null jsonl_path, multiple-enqueue persistence, empty JSONL, 5-turn happy path, embed-null fallback, idempotent re-run, malformed-line skip + counter, missing JSONL path, wrapper redaction round-trip.
- **`src/tests/integration/phase-8-ingestion-hook.test.ts`** — 4 tests: end-to-end (close marker → enqueue → ingestSession → 5 chunks + ordered roles), idempotent re-drain, hook-safety grep (session-end.ts has no LLM/embedding/HTTP imports), full heartbeat-tick drive (`heartbeatTick` end-to-end → queue marked processed → chunks landed; second tick is no-op).

## Verification

- `bun run build` exits 0.
- `bun run vitest run src/tests/ingestion/` — all 31 ingestion tests (chunker 11 + upsert 10 + ingest-session 10) pass.
- `bun run vitest run src/tests/integration/phase-8-ingestion-hook.test.ts` — 4/4 pass (~1.6s).
- `bun run vitest run src/tests/integration/phase-6-crash-resilience.test.ts src/tests/angel/boundary/ src/tests/angel/heartbeat.test.ts` — 67/67 pass; no Phase 6 / boundary / heartbeat regression.
- Hook-safety grep: integration test `'hook safety'` asserts `EmbeddingProvider`, `callLocalLLM`, `fetchJsonWithTimeout` are absent from `session-end.ts`.
- Single call site each in hook and boundary-detector: `grep enqueueSessionIngestion` confirms exactly one call in `session-end.ts`, zero in `boundary-detector.ts` (intentional — see Deviations).

## Deviations from Plan

**[Rule 4 — Architectural deferral] Boundary-detector enqueue NOT wired** — Found during: Task 2(b) implementation | Issue: Plan 08-03 task 2(b) directs "in the per-candidate loop ... after `commitBoundaryTick` succeeds and the close was a fresh `clean_endsession` promotion — i.e. the path that ALSO calls `emitCleanEndsessionClose`". Re-reading `boundary-detector.ts`: the boundary-detector currently has `if (cls.close_reason === 'clean_endsession') continue;` at line 267 — meaning it explicitly SKIPS the clean_endsession case (the hook owns it). The classifier never returns `'clean_endsession'` from the boundary-tick path; it returns `'idle_timeout'`, `'pid_dead_jsonl_silent'`, etc. The "path that ALSO calls emitCleanEndsessionClose" described by the plan does not exist in the code today.

CONTEXT decision 5 says crash-killed sessions are ingested via "Phase 6's idle-sweep promotes orphaned sessions to clean_endsession. Ingestion fires from that event." But that promotion path is also not implemented — the boundary-detector emits `idle_timeout` / `pid_dead_*` close reasons, never `clean_endsession`. Wiring an enqueue from idle_timeout closes would violate the lock ("Conservative-by-default — partial transcripts at idle-sweep detection time create retrieval-confounding chunks").

**Resolution:** Honor the lock literally — only the SessionEnd hook (the genuine clean-close path) enqueues ingestion in P8. Crash-killed sessions reach ingestion when they're re-opened by the user and exit cleanly the next time. The "idle-sweep promotes to clean_endsession" path the spec assumes is itself a deferred work item — best handled in v6.x once the substrate has been measured by P9 and we know whether crash-kill ingestion is actually load-bearing for the deliberation-engagement signal. | Files modified: `boundary-detector.ts` left unchanged | Verification: hook-only path tested end-to-end; deferred path documented | No commit.

**[Rule 1 — Bug] heartbeat resolveJsonlPath helper had to use `os.homedir()` not `homedir()`** — Found during: build | Issue: Plan said `path.join(homedir(), '.claude', 'projects', ...)` but heartbeat.ts imports `os` namespace, not `homedir` directly. | Fix: `os.homedir()` | Files modified: `src/angel/heartbeat.ts` | Verification: build clean | Commit hash: aa87f21.

**Total deviations:** 2 (1 Rule-4 deferral documented, 1 Rule-1 import-shape fix). **Impact:** None on the spec-locked happy path (clean exits via hook). The deferred crash-kill ingestion path is a known v6.x candidate per CONTEXT decision 5 + Deferred Ideas, NOT a P8 ship blocker.

## Authentication Gates

None.

## Issues Encountered

None blocking. The boundary-detector deferral is a documented architectural decision; the hook covers all clean-exit ingestion the spec locks for P8.

## Next Phase Readiness

Ready for Plan 08-04 (backfill CLI + reranker-fitness CLI). The live ingestion pipeline is in place; 08-04 adds operator-invoked CLIs that flood the queue (backfill) and read from it (fitness check).

**Duration:** 16 min
**Tasks completed:** 2/2 (Task 1 ingest-session entry points; Task 2 hook + heartbeat wiring; boundary-detector enqueue deferred per Rule 4)
**Files created:** 3
**Files modified:** 3
**Commits:** 1 (`aa87f21 feat(08-03): wire transcript ingestion ...`)
