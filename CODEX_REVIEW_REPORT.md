# Codex Review Report: Angel System

**Scope**: 13 files in `src/angel/` -- heartbeat loop, 4 new guardian modules, 7 existing modules
**Date**: 2026-03-28
**Reviewer**: Claude Opus 4.6 (1M context)
**Grade: B+**

---

## Executive Summary

The Angel system is well-architected. The 4 new guardian modules (retention-sweep, cross-project-consolidator, data-quality, proactive-curator) follow the established non-throwing, rate-limited, batch-bounded patterns correctly. SQL column names match the V10/V11 schema. `cachedPrepare` is used consistently with one known exception. All new exports are imported and called in `heartbeat.ts`. The code is production-ready with a handful of real issues to address.

---

## Findings by Severity

### HIGH (2 issues)

#### H1. Feature flags `dataQualityChecks` and `proactiveCuration` are defined but never checked

`RetentionConfig` defines three feature flags: `crossProjectConsolidation`, `dataQualityChecks`, and `proactiveCuration`. Only `crossProjectConsolidation` is actually checked (in `runCrossProjectConsolidation()` line 471). The other two flags are ignored -- `runDataQualityChecks()` and `runProactiveCuration()` run unconditionally regardless of config.

**Files**: `src/angel/data-quality.ts`, `src/angel/proactive-curator.ts`, `src/angel/types.ts`

**Fix**: Add early-return guards in `runDataQualityChecks()` and `runProactiveCuration()`, matching the pattern in `runCrossProjectConsolidation()`:
```typescript
if (!config.dataQualityChecks) return { ...EMPTY_RESULT };
if (!config.proactiveCuration) return { ...EMPTY_RESULT };
```

#### H2. `logTickResult` in index.ts does not log new guardian metrics

`logTickResult()` (index.ts lines 227-243) only logs the original 6 metrics (idle_warnings, sessions, patterns, domains, learnings_pruned, patterns_pruned, memory_migrated). The 7 new TickResult fields from the guardian modules (retention_rows_deleted, cross_project_deduped, quality_issues_fixed, artifacts_promoted, artifacts_decayed, health_report_sent, user_profiles_synced) are silently dropped. Guardian work happens invisibly.

**File**: `src/angel/index.ts`

**Fix**: Add logging lines for the new fields, matching the existing pattern.

---

### MEDIUM (4 issues)

#### M1. Raw `db.prepare()` in message-sender.ts bypasses stmt-cache

`markMessagesDelivered()` (message-sender.ts line 71) uses `db.prepare()` directly instead of `cachedPrepare()`. Every other SQL call across all 13 Angel modules uses `cachedPrepare`. This is the only exception.

**File**: `src/angel/message-sender.ts:71`

**Fix**: Replace `db.prepare(...)` with `cachedPrepare(db, ...)`.

#### M2. Dynamic SQL in `deduplicatePatterns` defeats stmt-cache

`deduplicatePatterns()` (cross-project-consolidator.ts line 252) builds `SELECT * FROM experience_patterns WHERE id IN (${placeholders})` with a variable number of placeholders. Each distinct id-count creates a new cache entry in `cachedPrepare`. With the `LIMIT 20` constraint on the parent query, the maximum number of distinct placeholder counts is bounded (~2-20), so this will not leak memory, but it is a design smell that could cause issues if the batch limit increases.

**File**: `src/angel/cross-project-consolidator.ts:252`

**Fix**: Consider using a temp table or fixed-batch approach. Low urgency given the LIMIT 20 bound.

#### M3. Redundant importance check in `pruneArtifacts` cold tier

`pruneArtifacts()` (retention-sweep.ts lines 149-164) has both `importance < 3` AND `importance < 5` in the cold tier DELETE. The `importance < 5` predicate is redundant since `importance < 3` is strictly more restrictive.

**File**: `src/angel/retention-sweep.ts:159`

**Fix**: Remove `AND importance < 5` from the cold tier query.

#### M4. `detectStaleEmbeddings` heuristic is overly aggressive

`detectStaleEmbeddings()` (data-quality.ts lines 222-243) NULLs embeddings on ALL artifacts with `timestamp_epoch` in the last 24 hours. This catches newly-created artifacts whose embeddings are already correct (generated at insert time), not just artifacts whose content was modified after embedding. This creates unnecessary embedding churn on every quality check cycle -- every recent artifact loses its embedding and must be re-embedded by the backfill cycle.

**File**: `src/angel/data-quality.ts:222-243`

**Fix**: Track `embedded_at_epoch` or filter to artifacts where `timestamp_epoch > embedded_at_epoch` (indicating content changed after embedding).

---

### LOW (5 issues)

#### L1. No test coverage for any Angel module

Zero test files exist for any of the 13 Angel modules. The project has 92+ test files but none cover heartbeat, retention-sweep, cross-project-consolidator, data-quality, proactive-curator, user-profile-sync, or any other Angel module. The non-throwing contract and SQL correctness rely entirely on manual verification and production behavior.

#### L2. `archiveAbandonedProjects` re-decays already-packed artifacts

The query (proactive-curator.ts lines 227-238) finds projects with no recent sessions and runs `UPDATE artifacts SET state = 'packed', activation_score = activation_score * 0.5`. Since the UPDATE has no `AND state != 'packed'` filter, already-packed artifacts get their `activation_score` halved again on every curation cycle (every 60 minutes). Over days, activation_score approaches zero asymptotically but the repeated writes are wasteful.

**File**: `src/angel/proactive-curator.ts:246-249`

**Fix**: Add `AND state != 'packed'` to the UPDATE WHERE clause, or add `AND activation_score > 0.01`.

#### L3. `prepareAwayDigests` creates unbounded artifacts over time

Each curation cycle (default every 60 minutes) creates a new "away-digest" artifact for each qualifying project. There is no dedup check -- if a project stays "away" for 7 days, it accumulates ~168 digest artifacts. These are never cleaned up except by the general retention sweep.

**File**: `src/angel/proactive-curator.ts:382-471`

**Fix**: Check for existing recent digests before creating new ones (e.g., skip if one exists within 24 hours), or use a date-keyed `artifact_ref` with `INSERT OR IGNORE`.

#### L4. Skeletal tier FTS desync

When `pruneConversationTurns()` NULLs `assistant_text`, the FTS UPDATE trigger fires and replaces the indexed text with empty string. Conversations in the skeletal tier lose FTS searchability silently. This may be intentional (the data is gone so search should not find it) but is worth documenting explicitly.

**File**: `src/angel/retention-sweep.ts:78-94`

#### L5. Rate-limit unit inconsistency across modules

Three modules use `Date.now()` (milliseconds) for rate limiting: retention-sweep, data-quality, proactive-curator. One module uses `Math.floor(Date.now() / 1000)` (seconds): cross-project-consolidator. All implementations are internally consistent and correct, but the unit inconsistency invites copy-paste bugs in future modules.

**File**: `src/angel/cross-project-consolidator.ts:29,474-476`

---

## Verification Checklist

| Check | Result |
|---|---|
| All new exports imported and called in heartbeat.ts? | **PASS** -- `runRetentionSweep` (line 38/346), `runCrossProjectConsolidation` (line 39/367), `runDataQualityChecks` (line 40/383), `runProactiveCuration` (line 41/399), `syncUserProfiles` (line 37/326) |
| Non-throwing pattern followed? | **PASS** -- Every function has try/catch returning zero/empty on error. Master functions wrap each sub-call. heartbeat.ts wraps each phase. |
| Rate-limited with module-level variables? | **PASS** -- All 4 new modules use module-level `_last*Epoch` variables with reset functions exported for testing. |
| Batch limits prevent runaway? | **PASS** -- retention-sweep: 500/table, data-quality: 10-200/table, proactive-curator: 10-100/operation, consolidator: 10-20/operation |
| `cachedPrepare` used consistently? | **FAIL (1 exception)** -- `message-sender.ts:71` uses raw `db.prepare()`. All other ~80+ SQL calls use `cachedPrepare`. |
| SQL column names match schema? | **PASS** -- All column references verified against V10/V11 schema DDL (schema.ts). Checked: `session_events.timestamp_epoch`, `retrieval_events.artifact_id`, `retrieval_events.was_referenced`, `artifacts.activation_score`, `artifacts.superseded_by`, `pressure_scores.raw_pressure`, `pressure_scores.temperature`, `pressure_scores.last_touched_epoch`, `session_messages.created_at_epoch`, `session_messages.delivered_at_epoch`, `knowledge_gaps.resolved_at_epoch`, `learnings.fingerprint`, `learnings.promotion_count`, `decisions.fingerprint`, `decisions.timestamp_epoch`, `experience_patterns.trigger_context`, `experience_patterns.source_project`, `verified_facts.session_id` |
| SQL injection / missing parameterization? | **PASS** -- All user-data flows through `?` parameters. Dynamic IN clause in deduplicatePatterns uses `?` placeholders (not string interpolation). GROUP_CONCAT values are internal DB IDs, not user input. |
| `LIMIT` on UPDATE/DELETE supported? | **PASS** -- Verified that better-sqlite3 v11.7+ compiles SQLite with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. Tested live: `DELETE FROM t WHERE id > 0 LIMIT 2` works correctly. |
| Config types complete and defaults sensible? | **PASS** -- RetentionConfig has 17 fields with reasonable defaults. AngelConfig includes retention with spread defaults. |

---

## Architecture Assessment

### Strengths
- Clean separation: each guardian module owns one concern with a single `run*()` entry point
- Consistent non-throwing contract prevents heartbeat death spirals
- Rate limiting prevents tight loops -- each module independently throttled
- Batch limits prevent single-tick monopolization of the DB
- Safety contracts documented and enforced (importance >= 5 never deleted, angel_processed never deleted, summary entries never deleted)
- Transaction wrapping in cross-project-consolidator prevents partial state on multi-step dedup
- heartbeat.ts phases are ordered by priority: idle detection > pattern extraction > guardian duties > embedding backfill > consolidation > RL training > user profile sync > guardian-of-all-memory
- New TickResult fields aggregate cleanly with the existing telemetry structure

### Weaknesses
- Zero test coverage for the entire Angel subsystem (13 modules, ~4000 lines)
- Feature flags defined but not wired for 2 of 3 guardian toggle flags (H1)
- Observability gap -- guardian work not logged (H2)
- Some operations can repeat on already-processed targets (L2, L3)

---

## Files Reviewed

| File | Lines | Status |
|---|---|---|
| `src/angel/heartbeat.ts` | 565 | Good -- all phases wired, non-throwing, correct ordering |
| `src/angel/types.ts` | 166 | Good -- complete types, sensible defaults |
| `src/angel/retention-sweep.ts` | 426 | Good -- 8 pruning functions, batch-limited, safety guards |
| `src/angel/cross-project-consolidator.ts` | 489 | Good -- 4 phases in transactions, fingerprint dedup |
| `src/angel/data-quality.ts` | 386 | Good -- FTS validation, orphan cleanup, 0-obs fix |
| `src/angel/proactive-curator.ts` | 521 | Good -- 7 tasks, dual rate limits, health reports |
| `src/angel/user-profile-sync.ts` | 319 | Good -- stat-first, bounded I/O, mtime conflict resolution |
| `src/angel/index.ts` | 333 | OK -- missing new metric logging (H2) |
| `src/angel/pattern-extractor.ts` | 290 | Good -- dual LLM fallback (API then Ollama) |
| `src/angel/consolidator.ts` | 453 | Good -- union-find clustering, policy-driven merge decisions |
| `src/angel/session-monitor.ts` | 190 | Good -- escalation chain with anti-spam |
| `src/angel/message-sender.ts` | 93 | OK -- one raw db.prepare (M1) |
| `src/angel/memory-monitor.ts` | 299 | Good -- pinned section awareness, excess-only migration |

---

## Summary of Required Actions

| Priority | Issue | Action |
|---|---|---|
| **Fix now** | H1: Feature flags not checked | Add early-return guards in `runDataQualityChecks()` and `runProactiveCuration()` |
| **Fix now** | H2: Guardian metrics not logged | Add 7 new fields to `logTickResult()` in index.ts |
| **Fix soon** | M1: Raw db.prepare | Replace with `cachedPrepare` in message-sender.ts:71 |
| **Fix soon** | M3: Redundant WHERE clause | Remove `AND importance < 5` from cold tier query |
| **Fix soon** | M4: Aggressive embedding nulling | Add content-change detection to avoid nulling fresh embeddings |
| **Low priority** | L2: Repeated packing | Add `state != 'packed'` guard to archiveAbandonedProjects |
| **Low priority** | L3: Unbounded digests | Add 24h dedup check to prepareAwayDigests |
| **Backlog** | L1: No tests | Write tests for Angel modules |
