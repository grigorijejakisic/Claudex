# Phase 6: Checkpoint System - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

DB-first checkpoint lifecycle: ULID-based IDs, state machine writes (pending -> committed -> mirrored), two-layer recovery (DB-first + file fallback with 3-hop chain), atomic YAML file writes, and checkpoint-to-markdown injection renderer. The checkpoint system is the "save game" mechanism -- without it, every compaction or crash loses all working context.

Target modules:
- New: `src/checkpoint/writer.ts`, `src/checkpoint/loader.ts`, `src/checkpoint/inject.ts`
- New: `src/checkpoint/types.ts` (v3 checkpoint interfaces)
- Dependency: `ulid` npm package (1.2KB, zero transitive deps)
- Existing: `src/core/checkpoint-tracking.ts` (Phase 1 CRUD -- thresholds, observation counts)
- Existing: `src/intelligence/enrichment.ts` (Phase 4 -- LLM enrichment with safety-net merge)

</domain>

<decisions>
## Implementation Decisions

### ULID for Checkpoint IDs
- Use `ulid` npm package per Architecture Section 8.3
- Generates monotonic, sortable, collision-free IDs (48-bit timestamp + 80-bit random)
- Replaces directory-scan sequential counter from v2 (eliminates race conditions)
- File naming: `{date}_{ulid}.yaml` (e.g., `2026-03-09_01JQXYZ4K9BPGF.yaml`)

### DB-First State Machine (Architecture Section 8.3)
- Write flow: INSERT pending -> build YAML -> UPDATE committed -> enrich -> write file -> UPDATE mirrored
- `pending`: write started but not complete. On crash recovery: discard
- `committed`: data is in SQLite. File may not exist yet. On recovery: re-mirror from DB
- `mirrored`: file exists, DB and file are consistent. Normal state
- Uses existing `checkpoint_meta` table (already in schema DDL from Phase 1)

### File Location
- `src/checkpoint/` directory per Architecture Section 12 layout
- `writer.ts`: DB-first write flow, threshold trigger logic, debounce, YAML serialization
- `loader.ts`: Two-layer recovery chain (DB + file fallback + 3-hop)
- `inject.ts`: Checkpoint -> markdown injection renderer
- `types.ts`: CheckpointV3, CheckpointMeta, SelectiveLoadPreset interfaces

### Write Triggers and Debounce
- Threshold-based: 200k window at 75%/90%, 1M window at 15%/30%/45%/60%/75%/90%
- Compaction: always write (bypass debounce -- safety net)
- Session-end: always write
- Debounce: 60s minimum between non-compaction writes (configurable via `checkpoint.debounce_seconds`)
- Thresholds tracked via existing `checkpoint-tracking.ts` CRUD

### GSD Field as Optional Parameter
- Checkpoint schema includes a `gsd` field read from `.planning/STATE.md`
- Phase 7 (Supporting Subsystems) builds the GSD state reader
- Writer accepts `gsd` as an optional parameter from caller, does not read `.planning/` directly
- Clean separation: checkpoint writer doesn't know about GSD filesystem structure

### Enrichment Integration
- Writer imports from `src/intelligence/enrichment.ts` (Phase 4) directly
- During beforeCompact trigger: after mechanical checkpoint built, attempt LLM enrichment
- Safety-net merge: enriched data can never silently drop heuristic entries
- If enrichment unavailable/fails: heuristic checkpoint is canonical, no error propagated

### Open Items Extraction
- Architecture: "extracted from assistant messages (TODO/FIXME patterns)"
- Simple inline regex scan in writer (not a separate module)
- Patterns: TODO, FIXME, HACK, remaining/still need/need to
- Accepts optional `lastAssistantText` param from caller

### Two-Layer Recovery Chain (Architecture Section 8.4)
- Layer 1 (DB recovery): query checkpoint_meta for latest committed/mirrored row
  - If committed but not mirrored: re-mirror from data column -> atomicWriteFile -> update to mirrored
  - If mirrored: read from mirror_path (fast path)
  - If pending: discard (incomplete write)
- Layer 2 (File fallback -- DB unavailable/empty):
  - Read latest.yaml -> parse "ref: {filename}" -> load that file
  - If latest.yaml missing/corrupt: dir scan *.yaml, sort by mtime desc, take first
  - Follow previous_checkpoint links (basename only, max 3 hops, track seen set for cycle detection)
- Returns first successfully parsed checkpoint, or null

### Selective Loading Presets (Architecture Section 8.5)
- `ALWAYS`: meta, working, thread.topic -- every checkpoint read
- `RESUME`: + decisions, files, thread.*, open_items, learnings -- session-start, post-compaction
- `GSD`: + gsd -- when .planning/ exists
- Loader accepts preset parameter, returns only requested fields

### Atomic File Writes
- Uses existing `atomicWriteFile` from `src/shared/fs-helpers.ts`
- tmp + rename with Windows EPERM fallback (copy + unlink)
- Checkpoint dir: `{project}/context/checkpoints/`
- latest.yaml: `ref: {filename}` pointer updated after each successful write

### Claude's Discretion
- YAML formatting details (key ordering, comment style)
- Error logging/reporting within non-throwing functions
- Exact open_items regex patterns beyond the listed ones
- Internal helper function decomposition within writer.ts
- Test fixture construction details

</decisions>

<specifics>
## Specific Ideas

- writer.ts `writeCheckpoint` function takes a params object: `{ db, sessionId, project, projectDir, trigger, tokenUsage?, gsd?, lastAssistantText? }`
- The writer reads decisions (LIMIT 15), thread_state, hot files (from pressure_scores), learnings, and observation file touches all within a single DB transaction for consistency
- `latest.yaml` content is minimal: `ref: {filename}` -- one line, fast to parse
- loader.ts `loadCheckpoint` function signature: `(db: Database | null, projectDir: string, preset?: SelectiveLoadPreset) => CheckpointV3 | null`
- The db parameter is nullable to support the file-fallback path when DB is unavailable
- inject.ts produces markdown sections consumable by the assembly pipeline (Phase 5)
- 3-hop cycle detection uses a `Set<string>` tracking seen checkpoint basenames

</specifics>

<deferred>
## Deferred Ideas

- **GSD state reading from filesystem** -- Phase 7 (Supporting Subsystems) builds state-reader.ts
- **Assembly pipeline integration** -- Phase 5 consumes inject.ts output in priority-budgeted sections
- **Hook adapter wiring** -- Phase 8/9 call writeCheckpoint during beforeCompact lifecycle
- **Token gauge integration** -- Phase 7 provides token usage for threshold calculations
- **Decay engine interaction** -- Phase 9 (decay runs at sessionEnd, checkpoint writes at sessionEnd too; ordering managed by adapter)

</deferred>

---

*Phase: 06-checkpoint-system*
*Context gathered: 2026-03-12*
