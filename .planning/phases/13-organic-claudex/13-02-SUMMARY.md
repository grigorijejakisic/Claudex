---
phase: 13-organic-claudex
plan: 02
subsystem: infra
tags: [angel, heartbeat, indexing, sqlite-vec, sessions, WIR-01]

requires:
  - phase: 13-01
    provides: Sessions/ markdown files (per-turn fsync writes)
  - phase: 08
    provides: chunkTranscript + upsertChunk + V32 transcript_chunk_v6 schema
provides:
  - "src/angel/sessions-indexer.ts: scanAndIndexSessions, buildChunksFromSessionMarkdown, getRegisteredProjectDirs"
  - mtime-skip optimization via lazy sessions_index_cursor table
  - heartbeat integration (sessions_files_scanned/indexed/chunks_upserted/errors on TickResult)
  - WIR-01 fixture coverage on V32 fresh-DB shape
affects:
  - Angel heartbeat tick
  - transcript_chunk_v6 cross-session retrieval coverage
  - 13-03 (highlights extractor reads same Sessions/ files)
  - 13-04 (assembly reads chunks indexed by this path)

tech-stack:
  added: []
  patterns:
    - "Recovery = normal path: same heartbeat-scan loop handles steady-state and DB-wipe-rebuild"
    - "Pipeline reuse: indexer delegates chunking + wrapper redaction to chunkTranscript so parseWrappers fires exactly once per turn"
    - "Lazy schema additions: CREATE TABLE IF NOT EXISTS for optimization-only tables (sessions_index_cursor) — no migration overhead"

key-files:
  created:
    - src/angel/sessions-indexer.ts
    - src/tests/angel/sessions-indexer.test.ts
  modified:
    - src/angel/heartbeat.ts

key-decisions:
  - "Watch mechanism: Angel heartbeat stat()-scan — chokidar rejected (Windows-fragility), standalone polling rejected (redundant with heartbeat). One code path for both steady-state and recovery."
  - "Cross-session latency ≤2 minutes (heartbeat cycle). Same-session retrieval out of scope by design — CC's in-conversation transcript covers that. Anti-scope statement is in the module docstring."
  - "sessions_index_cursor table created lazily (CREATE TABLE IF NOT EXISTS) — no schema migration required; one less migration to maintain."
  - "Wrapper redaction happens at extraction-time inside chunkTranscript (Phase 8 pipeline), not at write-time. Indexer never touches parseWrappers directly."
  - "In-memory mtime cache + DB cursor table: cache is fast-path; cursor table survives process restart. ON CONFLICT DO UPDATE on upsertChunk handles idempotency regardless of whether the skip optimization fires."
  - "Project enumeration: reuses ~/.claudex/projects.json via a small helper rather than introducing a new registry. Heartbeat does not need a project_dirs argument — the indexer self-resolves."

patterns-established:
  - "Indexer is a heartbeat phase, ordered after curated-context extraction and before Phase 4 Guardian retention. Failure is local: indexer try/catch never kills the heartbeat loop."

requirements-completed: []

duration: 18min
completed: 2026-05-14
---

# Phase 13 Plan 02: DB-as-Derived-Index Summary

**Angel heartbeat stat()-scans Sessions/ per project, re-chunks new/modified markdown via the existing chunkTranscript + upsertChunk pipeline, lands chunks idempotently in transcript_chunk_v6 — recovery becomes a special case of normal operation.**

## Performance

- **Duration:** ~18 min
- **Tasks:** 4 (read pipeline + indexer module + heartbeat wire + tests)
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- `sessions-indexer.ts` exports `scanAndIndexSessions`, `buildChunksFromSessionMarkdown`, `getRegisteredProjectDirs`.
- Heartbeat tick now includes a Phase-13 step that runs after curated-context extraction and reports four counters on `TickResult` (files_scanned, files_indexed, chunks_upserted, indexer_errors).
- mtime-skip optimization: cached in-memory + persisted in `sessions_index_cursor` (lazy CREATE TABLE IF NOT EXISTS). Unchanged files are skipped without a fs.read.
- Idempotency: re-index produces the same row count via the V32 UNIQUE constraint + Phase 8's ON CONFLICT DO UPDATE semantics. Tests confirm this by force-touching mtime and re-running the scan.
- WIR-01 fixture coverage: 8 tests against an in-memory DB carrying the V32-shape transcript_chunk_v6 schema; V17-collapsed shape is inherited via Phase 8's existing upsertChunk coverage (no new SQL surface beyond the optimization cursor).
- 14 tests pass (6 pure parser + 6 scanner + 2 boundary cases).

## Task Commits

1. **Tasks 1–4 (combined):** `43dac2e` — feat(13-02): Angel sessions-indexer with mtime-skip + WIR-01

Combined into one feat commit because the indexer module + heartbeat wire + tests are coupled at the module-import surface; separating would have produced commits that didn't independently build.

## Files Created/Modified

- `src/angel/sessions-indexer.ts` — pure parser + DB scanner + project enumeration helper
- `src/angel/heartbeat.ts` — TickResult fields + integrated indexer step
- `src/tests/angel/sessions-indexer.test.ts` — 14 fixture tests

## Decisions Made

See `key-decisions` frontmatter. Notable shape: `buildChunksFromSessionMarkdown` parses the Sessions/ markdown into intermediate `JsonlTurn[]` and delegates to `chunkTranscript` rather than re-implementing wrapper redaction or sentence-boundary splitting. This means the indexer inherits the Phase 8 polish suite (POLISH-03 hard char-cap, sentence-boundary walker, force-split bound) for free.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Plan sketch re-implemented chunking and wrapper redaction inline**
- **Found during:** Task 2 (writing sessions-indexer.ts)
- **Issue:** Plan's `buildChunksFromSessionMarkdown` sketch called `parseWrappers` directly and did fixed-size 2000-char sub-chunking. That diverges from Phase 8's authoritative chunker (sentence-boundary splitting, soft token limit, hard char cap) — the indexer would have produced chunks the rest of the stack reads inconsistently.
- **Fix:** Parse Sessions/ markdown into `JsonlTurn[]` (matching the chunker's input shape) and call `chunkTranscript` once at the end. parseWrappers fires exactly once per turn inside chunkTranscript.
- **Files modified:** `src/angel/sessions-indexer.ts`
- **Verification:** Tests assert role/provenance/wrapper_redacted/sub-chunking semantics all match the Phase 8 chunker's contract.
- **Committed in:** `43dac2e`

**2. [Rule 2 — Missing Critical] ToolResult turns needed a role mapping**
- **Found during:** Task 2 (writing parser)
- **Issue:** Plan's parser sketch assigned tool_result turns role='assistant'. That would violate the V32 CHECK(role IN ('user','assistant','tool','system')) constraint's semantic contract — tool results would surface as assistant body in retrieval.
- **Fix:** ToolResult headers map to role='tool' + provenance='tool_result'. Test "parses ToolResult turn into tool role + tool_result provenance" confirms.
- **Files modified:** `src/angel/sessions-indexer.ts`, `src/tests/angel/sessions-indexer.test.ts`
- **Verification:** Test passes; build passes (the CHECK constraint accepts the value).
- **Committed in:** `43dac2e`

**3. [Rule 3 — Blocking] Heartbeat-tick project-dir argument resolution**
- **Found during:** Task 3 (heartbeat wire)
- **Issue:** Plan sketch passed a `projectDirs` argument from a hypothetical `getRegisteredProjectDirs(db)` helper. No such DB-backed helper exists in this codebase; project enumeration lives in `~/.claudex/projects.json` (file-system source of truth).
- **Fix:** `scanAndIndexSessions` self-resolves project dirs via `getRegisteredProjectDirs()` (reads projects.json) when no argument is provided. Heartbeat call site stays one-liner: `await scanAndIndexSessions(ctx.db)`. Test entry point accepts the explicit `projectDirs` argument so tests don't depend on the user's real projects.json.
- **Files modified:** `src/angel/sessions-indexer.ts`, `src/angel/heartbeat.ts`
- **Verification:** Build passes; tests pass with explicit project-dirs injection.
- **Committed in:** `43dac2e`

---

**Total deviations:** 3 auto-fixed (1 Rule 1, 1 Rule 2, 1 Rule 3).
**Impact on plan:** Plan executed as scoped; deviations corrected three places where the plan sketch would have produced inconsistent retrieval behavior.

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- 13-03 unblocked: highlights extractor can read Sessions/ markdown directly (does not need this indexer to have finished); will also be able to query `transcript_chunk_v6` rows for completed sessions if it wants chunk-level grounding.
- 13-04 unblocked: assembly path queries `session_highlights` (created in 13-03) which is downstream of this indexer's coverage.

---
*Phase: 13-organic-claudex*
*Completed: 2026-05-14*
