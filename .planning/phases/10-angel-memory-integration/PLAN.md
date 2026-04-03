# Phase 10: Angel/CC Memory Integration — Plan

**Status:** Ready to implement
**Estimate:** ~60 lines code + doc comments (light phase)

---

## Implementation Items

### A3: Contradiction-Aware Pruning (~30 lines)
**File:** `src/angel/retention-sweep.ts`
**Dependency:** `src/intelligence/contradiction-detector.ts`

Add `resolveContradictions()` function that runs as a pre-sweep pass in `pruneObservations()`:
1. Query observations from last 90 days, grouped by project, batch of 50
2. For each project batch, compare pairs using `detectContradiction()`
3. When contradiction found: keep newer observation (higher `timestamp_epoch`), mark older as `consumed=1` (superseded)
4. Return count of superseded observations
5. Call `resolveContradictions()` at the top of `pruneObservations()`, before the three importance-tiered DELETE queries

Add `observations_superseded` field to `RetentionSweepResult` and `EMPTY_RESULT`.

### A9 Extension: Observation ID Dedup in Assembly (~15 lines)
**File:** `src/assembly/assembler.ts`

In `assembleFullContext()`, after materialized artifacts are selected and before recording retrieval events:
1. Extract observation IDs from materialized artifacts where `artifact_type === 'observation'`
2. Prefix with `obs:` to distinguish from pattern ULIDs
3. Check against `session_injected_ids` — filter out already-seen observations
4. After injection, accumulate `obs:ID` entries into `session_injected_ids`

No schema change needed — `session_injected_ids` is already `string[]`.

### A13: 30-Day Transcript Priority (~15 lines)
**File:** `src/intelligence/cross-agent-indexer.ts`

In each `detect*Sessions()` function:
1. After `readdirSync().filter()`, get `fs.statSync(f).mtimeMs` for each file
2. Sort by mtime ascending (oldest first — process aging transcripts before fresh ones)
3. In `indexCrossAgentSessions()`, log warning when mtime is >25 days old and file hasn't been indexed

---

## Document-Only Items

### A1: Angel is Sole Consolidator (DOC)
**File:** `src/angel/consolidator.ts`
Add doc comment noting Angel owns all consolidation. CC Dream is disabled via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Ref: `cc-source/06-dream-kairos.md`.

### A2: Angel Handles All Extraction (DOC)
**File:** `src/angel/pattern-extractor.ts`
Add doc comment noting architectural boundary — Angel cannot adopt CC's forked-agent-with-cache-sharing pattern (separate process, no cache sharing). Ref: `cc-source/04-memory-system.md`.

### A5: Away Summary (DOC)
**File:** `src/angel/pattern-extractor.ts`
Inline note — Angel reads `conversation_turns` which naturally contains any CC away summaries.

### A9: session_injected_ids Equivalence (DOC)
**File:** `src/assembly/assembler.ts`
Inline note — `session_injected_ids` is equivalent to CC's `alreadySurfaced` set in `findRelevantMemories.ts`.

### A12: Race Prevention (DOC)
**File:** `src/assembly/assembler.ts`
Inline note — Race prevented by `CLAUDE_CODE_DISABLE_AUTO_MEMORY` + `detectCcMemoryConflict()` in env-file.ts.

---

## Verification

- [ ] A3: `resolveContradictions()` runs before age-based pruning
- [ ] A3: Newer kept, older `consumed=1`
- [ ] A3: Only scans last 90 days
- [ ] A9: Observation IDs prefixed `obs:`
- [ ] A9: Re-injection suppressed within session
- [ ] A13: Paths sorted by mtime (oldest first)
- [ ] A13: Warning for >25-day unindexed transcripts
- [ ] A1/A2/A5/A9/A12: Doc comments added
- [ ] `bun run build` passes
- [ ] `bun run test` passes
