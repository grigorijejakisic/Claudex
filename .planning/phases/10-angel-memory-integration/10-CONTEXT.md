# Phase 10: Angel/CC Memory Integration - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Align Angel with CC's memory features so they cooperate rather than conflict. Primarily defensive — relevant when/if CC memory is re-enabled (Phase 1 disabled it via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). No new user-facing features. Mostly doc-only with two small code enhancements.

Key principle from session 42 handoff: "COOPERATE with CC, don't fight it. Use CC features as free resources."

</domain>

<decisions>
## Implementation Decisions

### Already Done (3 items — no work needed)

| Item | Status | Covered By |
|------|--------|------------|
| **A9** (Dedup tracking) | DONE | `session_injected_ids` in `experience-flags.ts:122`. Assembler uses it at `assembler.ts:180` to suppress re-injection of patterns already shown this session. Exact equivalent of CC's `alreadySurfaced` set in `findRelevantMemories.ts`. |
| **A12** (File race prevention) | DONE | Phase 1 disabled CC memory writes via env var. `detectCcMemoryConflict()` in `env-file.ts` provides defensive detection at session start. Angel's `memory-monitor.ts` is unidirectional (reads CC files, writes only to Claudex DB). No race possible. |
| **A5** (Away summary) | DONE | Angel reads `conversation_turns` which naturally contains any CC away summaries (appended as system messages). No special integration needed. CC's Away Summary is also feature-flagged (`AWAY_SUMMARY` + `tengu_sedge_lantern`) and likely inactive. |

### Document-Only (2 items — comments/docs only)

#### A1: Dream Consolidation — Angel is Sole Consolidator (DOC-ONLY)
- Phase 1 disabled auto-memory, which disables autoDream (`executeAutoDream()` returns early when `isAutoMemoryEnabled()` is false)
- Angel IS the sole consolidator via `consolidator.ts` (observation merging) and `pattern-extractor.ts` (6-phase pipeline: CONTEXT → ANALYZE → MEASURE → PLAN → REVIEW → COMMIT)
- Angel's pipeline is already more sophisticated than Dream's 4-phase model (orient → gather → consolidate → prune)
- Add doc comments in `consolidator.ts` and `pattern-extractor.ts` confirming Angel's consolidation ownership
- If Dream is ever re-enabled, `detectCcMemoryConflict()` will log a warning — no additional guard needed

#### A2: extractMemories — Angel Handles All Extraction (DOC-ONLY)
- CC's extractMemories disabled by Phase 1 env var
- Angel cannot adopt CC's forked-agent-with-cache-sharing pattern because Angel is an independent process (separate PID), not a CC subagent — cache sharing only works within CC's conversation fork
- Angel uses CliProxy (Sonnet via localhost:8317) or Ollama for LLM extraction
- The cursor-based incremental extraction pattern from CC is deferred to Phase 12 (P2)
- Add doc comment in `pattern-extractor.ts` noting the architectural boundary

### Deferred (1 item)

#### A4: Session Memory Integration — SKIP
- CC's Session Memory writes to a temp file per session (`sessionMemory.ts`) — no stable discoverable path
- Gated on `tengu_session_memory` GrowthBook flag AND `isAutoCompactEnabled()`
- Even if accessible, Angel already processes raw conversation turns — a pre-summary would lose detail needed for pattern extraction
- Becomes relevant only if CC ships SM-Compact with a stable, documented summary path
- **No code, no doc — revisit when CC's Session Memory is stable**

### A3: Retention Sweep — Contradiction-Aware Pruning (IMPLEMENT)
- Wire existing `contradiction-detector.ts:detectContradiction()` into `retention-sweep.ts:pruneObservations()`
- Before age-based pruning, run contradiction detection on observations within the same project
- When contradictions are found: keep newer observation, mark older as superseded (set `consumed=1`) rather than blindly age-pruning
- Run every sweep (hourly) — text comparison on project-scoped observations is cheap
- Contradiction detector already handles tokenization, negation detection, and overlap scoring
- Integration point: add a `resolveContradictions()` call at the start of `pruneObservations()`, before the three importance-tiered DELETE queries
- ~30 lines of integration code

### A9 Extension: Observation ID Tracking in session_injected_ids (IMPLEMENT)
- Current `session_injected_ids` only tracks experience pattern IDs (from `assembler.ts:191-196`)
- Extend to also track observation IDs when observations are surfaced via assembly
- Check where observations are injected in the assembly pipeline (checkpoint loader, entity summaries, materialization) and accumulate those IDs too
- Prevents the same observation from being surfaced on multiple turns within a session
- ~15 lines across `assembler.ts` and relevant assembly sections

### A13: 30-Day Transcript Priority Escalation (IMPLEMENT)
- `cross-agent-indexer.ts:detectPaths()` limits to last 20 sessions per provider but has NO age awareness
- CC cleans up transcript JSONL files after 30 days
- Angel's `conversationTurnsFullDays` already aligns at 30 days in `DEFAULT_RETENTION_CONFIG`
- Enhancement: In `indexCrossAgentSessions()`, sort detected paths by mtime, prioritize files with mtime approaching 25+ days (5-day buffer before CC cleanup)
- Log a warning when transcripts are found past 25 days that haven't been indexed
- ~15 lines in `cross-agent-indexer.ts`

### Claude's Discretion
- A3: How many observations to check per project in contradiction pass (batch of 50 should suffice — recent observations only)
- A9 extension: Whether to track observation IDs by numeric ID or by a content hash (numeric ID is simpler, use that)
- A13: Exact age threshold for priority escalation (25 days is reasonable — 5-day safety buffer)

</decisions>

<specifics>
## Specific Ideas

- A3 contradiction detection should only scan observations from the last 90 days (aligns with medium-importance retention window) — no point checking ancient observations that are about to be pruned anyway
- A9 observation ID tracking: the `session_injected_ids` array is stored as JSON in `experience_flags` — it's a flat string array, so observation IDs should be prefixed (e.g., `obs:123`) to distinguish from pattern IDs (which are ULIDs)
- A13 mtime sorting: `detectPaths()` already uses `fs.readdirSync().slice(-20)` — change to sort by mtime descending and prioritize old-but-unindexed files first
- Doc comments for A1/A2 should reference the CC source files: `06-dream-kairos.md` (Dream 4-phase), `04-memory-system.md` (extractMemories)

</specifics>

<deferred>
## Deferred Ideas

- A4 (Session Memory integration) — revisit when CC ships SM-Compact with stable summary path
- P2 (Cursor-based incremental extraction) — Phase 12 item, noted as future improvement for Angel's pattern extractor
- Forked-agent-with-cache-sharing — architecturally impossible while Angel is a separate process. Would require Angel to run as a CC plugin/hook agent.

</deferred>

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/angel/retention-sweep.ts` | A3: Add `resolveContradictions()` before `pruneObservations()` tier queries |
| `src/intelligence/contradiction-detector.ts` | A3: May need a batch variant that checks multiple observations (current API is single-observation) |
| `src/assembly/assembler.ts` | A9: Track observation IDs in `session_injected_ids` alongside pattern IDs |
| `src/intelligence/experience-flags.ts` | A9: No schema change needed — `session_injected_ids` is already string[] |
| `src/intelligence/cross-agent-indexer.ts` | A13: Add mtime-based priority sorting and 25-day warning threshold |
| `src/angel/consolidator.ts` | A1: Doc comment — Angel owns consolidation |
| `src/angel/pattern-extractor.ts` | A1/A2: Doc comments — sole extractor, architectural boundary with CC |

## Files to Create

None.

---

## CC Source References

| Source | Item |
|--------|------|
| `cc-source/06-dream-kairos.md` | A1: Dream 4-phase consolidation structure, autoDream gate chain |
| `cc-source/04-memory-system.md` | A2: extractMemories forked-agent pattern, cursor-based extraction |
| `cc-source/04-memory-system.md` §6 | A9: `alreadySurfaced` dedup set in `findRelevantMemories.ts` |
| `cc-source/18-skills-angel-overlap.md` §2.7 | A3: /remember taxonomy, cross-layer contradiction checking |
| `cc-source/18-skills-angel-overlap.md` §3.3 | A4: Session Memory — temp file, SM-Compact |
| `cc-source/18-skills-angel-overlap.md` §3.5 | A5: Away Summary — terminal blur, feature-gated |
| `cc-source/18-skills-angel-overlap.md` §3.1 | A2: extractMemories cache sharing, 5-turn cap |
| SYNTHESIS.md A1-A5, A9, A12, A13 | All items — master reference |

---

## Verification Checklist

- [ ] A3: `resolveContradictions()` runs before age-based pruning in `pruneObservations()`
- [ ] A3: Newer observation kept, older marked `consumed=1` on contradiction
- [ ] A3: Only scans observations from last 90 days
- [ ] A9: Observation IDs prefixed with `obs:` to distinguish from pattern ULIDs
- [ ] A9: Observations surfaced in assembly pipeline have their IDs accumulated
- [ ] A9: Second surfacing of same observation in same session is suppressed
- [ ] A13: `indexCrossAgentSessions()` sorts paths by mtime
- [ ] A13: Files approaching 25+ days old are prioritized
- [ ] A13: Warning logged for unindexed transcripts past 25-day threshold
- [ ] A1/A2: Doc comments added confirming Angel's consolidation/extraction ownership
- [ ] All tests pass (`bun run test`)

---

*Phase: 10-angel-memory-integration*
*Context gathered: 2026-04-03*
