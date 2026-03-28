# Gemini-Powered Architectural Diff Review: Angel Guardian System

**Scope**: `src/angel/` (13 files), with focus on 4 new Guardian of All Memory modules
**Reviewer**: Crux (Opus 4.6 1M)
**Date**: 2026-03-28
**Grade: B+**

---

## Executive Summary

The Angel Guardian system is a well-architected persistent memory optimizer for Claudex. The 4 new guardian modules (retention-sweep, cross-project-consolidator, data-quality, proactive-curator) are cleanly integrated into the heartbeat with proper rate limiting, non-throwing contracts, batch bounds, and correct phase ordering. The code is production-quality with one genuine bug (FTS desync on skeletal pruning) and several design-level concerns worth addressing.

---

## Detailed Findings

### CRITICAL (1)

#### C1: FTS Desync on Conversation Turns Skeletal Pruning

**File**: `src/angel/retention-sweep.ts:78-94`
**Schema**: `src/core/schema.ts:495-510`

The skeletal tier NULLs `assistant_text` on conversation_turns via UPDATE. The schema defines FTS triggers for INSERT (`convturns_fts_ai`) and DELETE (`convturns_fts_ad`) but **no AFTER UPDATE trigger**. This means:

- After skeletal pruning, `conversation_turns_fts` still indexes the old (now-NULL) `assistant_text`
- FTS queries will return phantom matches against content that no longer exists in the base table
- The data-quality module's `validateSchemaIntegrity()` does NOT check `conversation_turns_fts`, so this drift is invisible

**Fix**: Add an `AFTER UPDATE OF assistant_text ON conversation_turns` trigger to the schema DDL, and add `conversation_turns` to the FTS integrity check in `data-quality.ts`.

---

### HIGH (3)

#### H1: Redundant Importance Guard in Artifact Cold-Delete

**File**: `src/angel/retention-sweep.ts:149-165`

Target 2 (cold unaccessed packed artifacts) has `importance < 3 AND importance < 5`. The `importance < 5` clause is completely redundant -- if `importance < 3`, it is already less than 5. This suggests copy-paste from another query without cleanup.

#### H2: No Test Coverage for Guardian Modules

The test suite at `src/tests/angel/` covers `session-monitor`, `message-sender`, `pattern-extractor`, and `consolidator` -- but **none** of the 4 new guardian modules have tests:

- `retention-sweep.ts` -- no tests
- `cross-project-consolidator.ts` -- no tests
- `data-quality.ts` -- no tests
- `proactive-curator.ts` -- no tests

These modules perform destructive operations (DELETE, UPDATE SET NULL, activation_score halving). Without tests, the safety contracts (e.g., "never delete importance >= 5", "never touch non-angel_processed sessions") are assertions, not verified invariants.

#### H3: Abandoned Projects Query Can Produce False Positives

**File**: `src/angel/proactive-curator.ts:227-238`

The `archiveAbandonedProjects` query finds projects with ANY sessions but no RECENT sessions. However, the outer `SELECT DISTINCT project FROM sessions` has no `created_at_epoch` lower bound. A project with a single session from 2 years ago would be returned on every curation run. Since it is already packed from a previous run, the UPDATE is a no-op, but it is wasted work repeated every 60 minutes.

The same structural issue appears in `prepareAwayDigests` (line 389-406). The "away 3-30 days" query correctly excludes projects with recent activity, but there is no dedup mechanism to prevent creating duplicate digest artifacts on successive runs.

---

### MEDIUM (5)

#### M1: Cross-Project Consolidation Rate Limit Uses Seconds, Others Use Milliseconds

**File**: `src/angel/cross-project-consolidator.ts:474-476`

The rate limit comparison uses `Math.floor(Date.now() / 1000)` (epoch seconds), while `retention-sweep.ts:382` and `proactive-curator.ts:495` use `Date.now()` (epoch milliseconds). Both approaches work, but the inconsistency is a maintenance hazard. A future developer copying rate-limit logic from one module to another could mix the units.

#### M2: Health Report Delivery Has No Fallback When No Active Session Exists

**File**: `src/angel/proactive-curator.ts:347-354`

`generateHealthReport()` targets the most recently active session. If no sessions are active (common when the user is not working), the report is silently dropped. The `_lastHealthReportEpoch` is NOT updated on failure, so the next tick will retry -- which is correct. But the report content is recomputed from scratch each time, doing 7 COUNT(*) queries against potentially large tables.

Consider: store the computed report in a buffer and only recompute if stale. Or accept this as fine given the 24h interval.

#### M3: Pattern Dedup Uses GROUP_CONCAT(id) Which Can Truncate

**File**: `src/angel/cross-project-consolidator.ts:228-235`

`GROUP_CONCAT(id)` in SQLite has a default maximum length of ~1,000,000 bytes. With ULID pattern IDs (26 chars each + comma), this limits to ~38,000 patterns per trigger_context group. In practice this is fine, but the code then splits by comma and uses all IDs in an `IN (${placeholders})` clause. If truncation occurs, some patterns would be silently missed.

#### M4: Stale Embedding Detection Has No Modified-Content Check

**File**: `src/angel/data-quality.ts:222-243`

`detectStaleEmbeddings()` nulls embeddings on all artifacts modified in the last 24 hours. The heuristic is correct but aggressive -- an artifact could be modified without its content changing (e.g., state change from 'fresh' to 'packed'), triggering unnecessary re-embedding. The `timestamp_epoch` column does not distinguish content modifications from metadata modifications.

#### M5: archiveAbandonedProjects Packs All Artifacts Including Importance 5

**File**: `src/angel/proactive-curator.ts:246-250`

The query `UPDATE artifacts SET state = 'packed' ... WHERE project = ? AND state != 'packed'` does not exclude `importance >= 5`. The retention-sweep correctly protects importance >= 5 artifacts from deletion, but archiving packs them, which changes their state. This conflicts with the user-profile-sync module which creates importance-5 global artifacts. If a project is abandoned and then revived, its importance-5 artifacts will have been packed.

---

### LOW (4)

#### L1: Ancient Packed Artifacts Hardcoded to 90-Day Cutoff

**File**: `src/angel/retention-sweep.ts:171`

`pruneArtifacts` Target 3 uses `cutoff(90)` -- a hardcoded 90-day constant. All other retention windows are configurable via `RetentionConfig`. This should either be added to the config or documented as intentionally fixed.

#### L2: deduplicateDecisions Keeps Newest But Does Not Merge Context

**File**: `src/angel/cross-project-consolidator.ts:149-200`

When deduplicating decisions with the same fingerprint across projects, the code keeps the newest by `timestamp_epoch` and deletes the rest. Unlike learnings (which merge `promotion_count`) and patterns (which sum counters), decisions lose their cross-project session linkage. The `session_id` of deleted copies is lost. For decisions this is probably acceptable since the fingerprint proves identity, but it is a design asymmetry worth noting.

#### L3: Contradiction Detection Uses Description String as Dedup Key

**File**: `src/angel/proactive-curator.ts:145-148`

Contradiction dedup checks `WHERE description = ?` using a formatted string like `"Artifact contradiction: artifact 42 contradicts artifact 17 (strength=0.85)"`. If the strength changes on a subsequent link update, a new knowledge_gap is created for the same pair. Consider deduping on the artifact pair IDs instead.

#### L4: Rate Limit State Is Module-Level (Process Memory)

All 4 guardian modules use module-level `let _lastXxxEpoch = 0` variables for rate limiting. If the Angel process restarts, all rate limits reset and all phases run immediately on the first tick. This is by design (documented in the heartbeat comment), but could cause a brief burst of DB write pressure on Angel restart. The 500-row batch limits adequately bound this.

---

## Verification of Specific Review Questions

### Are the 4 new guardian modules properly wired into the heartbeat runtime?

**Yes.** Lines 337-411 of `heartbeat.ts` wire all four in sequence:
- Phase 4b: `runRetentionSweep(ctx.db, ctx.config.retention)`
- Phase 4c: `runCrossProjectConsolidation(ctx.db, ctx.config.retention)`
- Phase 4d: `runDataQualityChecks(ctx.db, ctx.config.retention)`
- Phase 4e: `runProactiveCuration(ctx.db, ctx.config.retention)`

Each is wrapped in individual try/catch blocks. The config threading is correct -- `ctx.config.retention` passes the `RetentionConfig` from `AngelConfig.retention`.

### Do the retention policies make sense architecturally?

**Mostly yes.** The tiered approach (full -> skeletal -> delete for conversation_turns) is well-designed. However:

**Tables MISSING from retention that probably should have it:**
- `artifact_access_log` -- grows unboundedly. No pruning anywhere.
- `telemetry` -- grows unboundedly. The data-quality module writes to it but nothing prunes it.
- `knowledge_gaps` -- resolved gaps are never cleaned up.
- `temporal_profile` / `action_transitions` -- stale behavioral data persists forever.
- `checkpoint_meta` -- old checkpoint metadata is never cleaned.

### Is the safety contract for conversation_turns enforced?

**Yes, the angel_processed check is correct.** Both the skeletal tier (line 82-93) and the delete tier (line 97-110) include `EXISTS (SELECT 1 FROM session_events se WHERE se.session_id = s.session_id AND se.event_type = 'angel_processed')`. Sessions without this marker are never touched.

Additionally, `pruneSessionEvents` preserves `angel_processed` events forever (line 239: `AND event_type != 'angel_processed'`), ensuring the safety marker itself is never deleted.

**However**, the FTS desync bug (C1) undermines the data integrity of the skeletal tier.

### Do the cross-project consolidation queries handle edge cases?

**Largely yes, with caveats:**
- `__global__` scope is correctly excluded from source queries and used as the merge target via `GLOBAL_PROJECT_SCOPE` constant (verified as `'__global__'` in `src/shared/constants.ts:136`)
- NULL projects: The `decisions` table has `DEFAULT '__global__'` and `learnings` also defaults to `'__global__'`, so NULL projects do not occur in practice. The consolidator's queries use `project != ?` which would correctly exclude NULL (NULL != X is NULL in SQL, which is falsy). Safe.
- The `propagateLearnings` function correctly double-checks with `fingerprint NOT IN (SELECT fingerprint FROM learnings WHERE project = ?)` before inserting, and uses `INSERT OR IGNORE` as belt-and-suspenders.

### Is the proactive curator's health report actually deliverable?

**Conditionally.** The report is delivered via `sendMessage()` to `session_messages`, targeting the most recently active session. The `message-sender.ts` confirms this inserts into `session_messages` with `delivered_at_epoch IS NULL`. The `UserPromptSubmit` hook reads pending messages (confirmed by `getPendingMessages()` in message-sender.ts). So delivery works **if and only if** there is an active session at report generation time. If not, the report is dropped and retried next tick.

### Are the rate limits appropriate?

**Yes, with one nuance:**
- 60min retention sweep: Appropriate. Batch-limited to 500 rows/table, so even at full speed it is bounded.
- 60min cross-project consolidation: Appropriate. Limited to 20 fingerprint groups per run.
- 120min data quality: Appropriate. The heavier queries (FTS count comparison, orphan detection) justify the longer interval.
- 24h health report: Appropriate for an informational report.
- 60min proactive curation (main sweep): Appropriate. The health report's independent 24h rate limit inside `generateHealthReport()` is a good design -- it decouples from the main sweep.

**Nuance**: The cross-project consolidation reuses `sweepIntervalMinutes` from RetentionConfig (same 60min as retention sweep). This means they always run in the same tick. If they should be independent, they need separate interval configs.

### Could any of these operations cause contention with ephemeral CC hooks?

**Low risk, but not zero.** The Angel uses `journal_mode = WAL` and `busy_timeout = 5000` (index.ts:277-278). WAL allows concurrent readers during writes. The 500-row batch limits on DELETE operations keep individual write transactions short. The main contention risk is:

1. **Retention sweep DELETE on conversation_turns** during a hook's INSERT into the same table. WAL handles this -- readers do not block writers. The hook would briefly see slightly stale data, which is acceptable.
2. **Cross-project consolidation's transaction** wraps multiple DELETEs + INSERTs in `db.transaction()`. This holds a write lock for the duration. With 20 fingerprint groups maximum, this should complete in <100ms.
3. **No explicit WAL checkpoint** is performed after bulk deletes. SQLite auto-checkpoints at 1000 WAL frames. Large retention sweeps could grow the WAL file, though the 500-row batch limit makes this unlikely.

### Is the phase ordering correct?

**Yes.** The ordering is architecturally sound:
1. **Retention (4b)** runs first to free space and remove stale data
2. **Consolidation (4c)** runs second on the cleaned dataset -- no point deduplicating data that is about to be deleted
3. **Quality (4d)** runs third to fix integrity issues in the surviving data
4. **Curation (4e)** runs last to promote/decay/report on the clean, consolidated, quality-checked data

This is the correct dependency order.

---

## Architecture Assessment

### Strengths

1. **Non-throwing contract** is consistently enforced across all 4 modules. Every exported function returns a safe default on error. Every sub-operation is individually wrapped.
2. **Batch limiting** prevents runaway operations. 500 rows for retention, 20 groups for consolidation, 50 artifacts for stale embedding detection, 10 sessions for re-processing queue.
3. **Rate limiting** prevents over-eager execution. Each module has its own independently testable rate limit with reset functions for testing.
4. **Safety invariants** are well-documented in doc comments and enforced in queries (angel_processed guard, importance >= 5 protection in retention, 'summary' entry protection in journal).
5. **Pure SQL** -- all 4 new modules avoid LLM calls, keeping them fast and deterministic.
6. **Config threading** is clean. `RetentionConfig` is a well-typed interface with sensible defaults, passed through `AngelConfig.retention`.

### Weaknesses

1. **No tests** for destructive operations is the biggest gap.
2. **FTS desync** on skeletal pruning is a real correctness bug.
3. **Unbounded table growth** for `artifact_access_log`, `telemetry`, `knowledge_gaps`, `checkpoint_meta`, and behavioral tables.
4. **Duplicate digest artifacts** can accumulate from `prepareAwayDigests` without dedup.

---

## Summary Table

| ID | Severity | File | Issue |
|----|----------|------|-------|
| C1 | CRITICAL | retention-sweep.ts / schema.ts | FTS desync: no UPDATE trigger on conversation_turns |
| H1 | HIGH | retention-sweep.ts:149 | Redundant `importance < 5` clause |
| H2 | HIGH | (missing) | No test files for 4 new guardian modules |
| H3 | HIGH | proactive-curator.ts:227,389 | Abandoned/away project queries lack dedup, run every cycle |
| M1 | MEDIUM | cross-project-consolidator.ts:474 | Mixed seconds/ms rate limit units across modules |
| M2 | MEDIUM | proactive-curator.ts:347 | Health report silently dropped when no active session |
| M3 | MEDIUM | cross-project-consolidator.ts:228 | GROUP_CONCAT can truncate with many pattern IDs |
| M4 | MEDIUM | data-quality.ts:222 | Stale embedding detection is over-aggressive |
| M5 | MEDIUM | proactive-curator.ts:246 | Archive packs importance-5 artifacts |
| L1 | LOW | retention-sweep.ts:171 | Hardcoded 90-day ancient artifact cutoff |
| L2 | LOW | cross-project-consolidator.ts:149 | Decisions dedup loses cross-project session links |
| L3 | LOW | proactive-curator.ts:145 | Contradiction dedup uses formatted string, not ID pair |
| L4 | LOW | (all modules) | Rate limits reset on process restart |

---

*Generated by Crux (Opus 4.6 1M) -- Gemini-style architectural review*
