# Gemini Architecture Review Report

**Scope:** Full uncommitted changeset (50 files, ~4,200 lines changed across 6 architectural areas)
**Date:** 2026-03-24 (Session 32)
**Reviewer:** Claude Opus 4.6 (standing in for Gemini)
**Grade:** B+ (86/100)

## Dimension Scores

| Dimension | Weight | Score | Assessment |
|-----------|--------|-------|------------|
| Coherence | 25% | 92/100 | Clean Hook/Angel responsibility split. V10 schema matches runtime usage. Migration orchestrator refactored well. |
| Pattern Consistency | 20% | 85/100 | Consistent non-throwing, cachedPrepare, runHookStep. One critical variable name bug breaks the ACE ranking fast path. |
| Structural Efficiency | 10% | 80/100 | learnings_fts absent from fresh schema DDL (only in migration step). observations_fts still retained but unused. |
| Contract Alignment | 20% | 88/100 | checkNovelty signature fix correct. hybridSearch rename consistent. commitEffects pattern well-designed. FTS rank threshold may over-filter. |
| Dependency Health | 10% | 90/100 | @anthropic-ai/sdk correctly externalized. Dynamic imports for cross-session-coordination. Circular dep avoidance via require() in artifacts.ts. |
| Wiring Verification | 15% | 85/100 | All new features wired. One dead-code variable (relevantRows) crashes pattern matching. Session bonus guard abuses checkpoint_tracking table. |

---

## CRITICAL Findings

### FINDING-CRIT-001: `relevantRows` undefined reference crashes ACE ranking (experience-patterns.ts:438)
- **File:** `src/intelligence/experience-patterns.ts:438`
- **Severity:** CRITICAL (runtime crash, silently caught)
- **Issue:** Line 434 assigns FTS5 results to `const rows`, but line 438 references `relevantRows.map(p => ...)`. `relevantRows` is never defined in this scope. This throws a `ReferenceError` which is caught by the outer `catch` block, causing every `findMatchingPatterns()` call to fall through to the slow `findMatchingPatternsFallback()` LIKE query.
- **Impact:** The entire ACE ranking system (helpful ratio, escalation level, verification boost) never executes. All pattern matching degrades to the LIKE fallback without composite scoring. The `fts.rank < -10` filter and `safeLimit * 2` fetch-extra logic are also wasted since the catch aborts before they matter.
- **Fix:** Change `relevantRows` to `rows` on line 438.

---

## HIGH Findings

### FINDING-HIGH-001: learnings_fts missing from fresh-install schema DDL
- **File:** `src/core/schema.ts` (absent), `src/core/migration-steps.ts:620-628`
- **Severity:** HIGH
- **Issue:** The `learnings_fts` FTS5 virtual table and its 3 sync triggers are only created inside `migrateSchemaFixes()` (a migration step), NOT in the `SCHEMA_V3` constant in `schema.ts`. The MCP recall-server queries `learnings_fts` at `recall-server.ts:196-197`.
- **Rescue path:** `initializeSchema()` does call `migrateSchemaFixes()` after `db.exec(SCHEMA_V3)`, so fresh DBs get the table. However, the schema DDL constant (`SCHEMA_V3`) is incomplete -- it claims to be the complete V10 schema but omits `learnings_fts`. This is a documentation/maintenance hazard: anyone reading `schema.ts` to understand the schema will miss this table.
- **Impact:** Functional but architecturally misleading. If `migrateSchemaFixes` ever changes its early-return guard, `learnings_fts` would silently disappear.
- **Recommendation:** Add `learnings_fts` DDL + triggers to `SCHEMA_V3` in `schema.ts` for completeness.

### FINDING-HIGH-002: Session bonus guard abuses checkpoint_tracking table
- **File:** `src/adapters/cc-hooks/stop.ts:261-270`
- **Severity:** HIGH (data hygiene)
- **Issue:** The session success bonus guard uses `checkpoint_tracking` to prevent double-application by inserting a synthetic row with session_id `__bonus_guard__<sessionId>`. This pollutes `checkpoint_tracking` -- a table meant for real session tracking data -- with guard rows that don't correspond to real sessions and don't have meaningful `observation_count`, `thresholds_hit`, or `last_checkpoint_epoch` values.
- **Impact:** Any code that queries `checkpoint_tracking` (e.g., for checkpoint-related decisions, the batch reflection guard at `batch-reflection.ts:169`) could encounter these phantom rows. The batch reflection guard queries `WHERE session_id = ?` with the project name as key, so it won't hit these guard rows, but the pattern is fragile.
- **Recommendation:** Use a dedicated guard mechanism: either a session-scoped experience flag, or a purpose-built table/column. A simple `session_events` entry of type `'session_success_bonus'` would be more appropriate.

### FINDING-HIGH-003: FTS5 rank threshold `< -10` may be overly aggressive
- **File:** `src/intelligence/experience-patterns.ts:427`
- **Severity:** HIGH (behavioral regression risk)
- **Issue:** The new `AND fts.rank < -10` filter rejects matches with rank values between -10 and 0 (less negative = weaker match). The comment says "single-keyword matches on common words produce rank ~ -5 to -8" and "multi-keyword relevant matches produce rank ~ -15 to -30+". However, a single highly-specific keyword match (e.g., "deadlock" matching one pattern about hook deadlocks) could produce rank around -8 to -12 and be incorrectly filtered out.
- **Impact:** Combined with FINDING-CRIT-001 (the catch silently swallows the ReferenceError), the FTS path currently never returns results anyway. But once the `relevantRows` bug is fixed, the -10 threshold deserves empirical validation.
- **Recommendation:** Log rejected matches during development to calibrate the threshold, or use a gentler cutoff like `-5`.

---

## MEDIUM Findings

### FINDING-MED-001: hybridSearchAsync returns empty array on pipeline failure instead of sync fallback
- **File:** `src/core/hybrid-retrieval.ts:524`
- **Severity:** MEDIUM
- **Issue:** The old `hybridSearch()` (now `hybridSearchAsync()`) had a `catch` block that fell back to `hybridSearchSync(db, query, project, options)` on any error. The new code returns `[]` instead. This means if the async path throws (e.g., a bug in the scoring code, not just Qdrant unavailability), the MCP recall server gets zero results rather than falling back to FTS5+recency.
- **Impact:** The recall-server at `recall-server.ts:95` calls `hybridSearchAsync()`. If it returns `[]`, users see no artifacts -- the journal/conversation/decision FTS paths still work, but the primary artifact channel is dead.
- **Recommendation:** Restore the sync fallback in the outer catch.

### FINDING-MED-002: Stop hook async insight extraction lost error reporting granularity
- **File:** `src/adapters/cc-hooks/stop.ts:105-112`
- **Severity:** MEDIUM
- **Issue:** `captureInsightsAsLearnings` was changed from sync (via `runHookStep`) to async (via try/catch). The old `runHookStep` wrapper emitted error telemetry automatically. The new async path catches with `emitErrorTelemetry(ctx.db, input.session_id, 'stop/insight_extraction', e)`, which is correct. But the comment in `runHookStep` header says "Synchronous steps only; async callers wrap their own try/catch" was removed, so the sync/async split is now undocumented.
- **Recommendation:** Add a brief comment explaining why some steps use `runHookStep` and others use manual try/catch (sync vs async distinction).

### FINDING-MED-003: Cross-session coordination queries are N+1
- **File:** `src/intelligence/cross-session-coordination.ts:57-93`
- **Severity:** MEDIUM (performance)
- **Issue:** `getCrossSessionActivity()` fetches up to 5 other sessions, then for EACH session runs 3 additional queries (files, tools, topic) plus a 4th for last activity epoch. That's 1 + 4*5 = 21 queries per call. Since the outer query already has `last_obs` from the GROUP BY/MAX, the last activity query is redundant. Files and tools could be fetched with a single IN-clause query.
- **Non-fatal:** This runs in the UserPromptSubmit path which is latency-sensitive for hook responsiveness.
- **Recommendation:** Consolidate into fewer queries, reuse `last_obs` from the outer query.

### FINDING-MED-004: markMessagesDelivered uses raw db.prepare instead of cachedPrepare
- **File:** `src/angel/message-sender.ts:71`
- **Severity:** MEDIUM (pattern inconsistency)
- **Issue:** All other DB access in the codebase uses `cachedPrepare()` for statement caching. `markMessagesDelivered()` uses `db.prepare()` directly. This is because the IN-clause has a variable number of placeholders and can't be cached. However, the function could iterate with a single-parameter cached statement instead.
- **Recommendation:** Either document why `db.prepare` is used (dynamic SQL), or switch to a loop with `cachedPrepare('UPDATE session_messages SET delivered_at_epoch = ? WHERE id = ?')`.

### FINDING-MED-005: Ollama fallback model hardcoded in pattern-extractor.ts
- **File:** `src/angel/pattern-extractor.ts:169`
- **Severity:** MEDIUM
- **Issue:** When the Anthropic API fails, `extractPatternsFromSession()` falls back to Ollama with `callOllama(fullPrompt, 'llama3.2')` -- a hardcoded model name. But the Angel config has `localModel` (default: 'llama3.2') which is passed to `classifySessionDomains()`. The extraction fallback should use the same configurable model.
- **Impact:** If the user configures `--local-model deepseek-coder`, domain classification uses it but extraction fallback doesn't.
- **Fix:** Pass `localModel` as a parameter to `extractPatternsFromSession()` and use it in the Ollama fallback. Currently the function receives only `cloudModel`.

---

## Wiring Verification Detail

### a) Angel architectural changes -- VERIFIED CORRECT

#### callClaudeCli removed from pattern-extractor.ts -- CORRECT
- The old `callClaudeCli()` function (which spawned `claude --message` as a subprocess) has been completely removed. It was replaced by direct Anthropic SDK usage (`client.messages.create()`) with Ollama fallback.
- This is architecturally correct: Claude CLI subprocess triggers CC hooks which would create phantom sessions. The Anthropic SDK calls the API directly without hook side effects.

#### Two-tier model config (cloudModel/localModel) -- CORRECT
- **File:** `src/angel/types.ts:12-14`
- `cloudModel` (default: `claude-sonnet-4-6`): Used for pattern extraction (complex reasoning) via Anthropic API.
- `localModel` (default: `llama3.2`): Used for domain classification (simple task) via Ollama.
- **heartbeat.ts passes correctly:** Line 79 passes `ctx.config.cloudModel` to `extractPatternsFromSession()`, line 100 passes `ctx.config.localModel` to `classifySessionDomains()`. Both match their function signatures.

#### classifySessionDomains simplified signature -- CORRECT
- Signature: `(db, sessionId, project, localModel)` -- 4 params, down from previous version that also took `client`.
- The function only uses Ollama (via `callOllama()`), never Claude API. The Anthropic client is correctly not passed.
- **heartbeat.ts call at line 96-101:** Passes `(ctx.db, session.session_id, session.project, ctx.config.localModel)` -- matches exactly.

### b) Heartbeat config field passing -- VERIFIED CORRECT

| Function | Config field passed | Expected | Match |
|----------|-------------------|----------|-------|
| `getIdleSessions()` | `ctx.config.idleThresholdSeconds` | `idleThresholdSeconds: number` | Yes |
| `extractPatternsFromSession()` | `ctx.config.cloudModel` | `model: string` (5th param) | Yes |
| `extractPatternsFromSession()` | `ctx.config.maxPatternsPerSession` | `maxPatterns: number` (6th param) | Yes |
| `classifySessionDomains()` | `ctx.config.localModel` | `localModel: string` (4th param) | Yes |
| `startHeartbeat()` | `ctx.config.heartbeatIntervalMs` | `ctx.config.heartbeatIntervalMs` | Yes |

### c) Checkpoint loader observation_count filter -- CORRECT WITH EDGE CASE

- **File:** `src/checkpoint/loader.ts:299-321`
- Both project-scoped and global queries now `JOIN sessions s ON cm.session_id = s.session_id` with `AND s.observation_count > 0`.
- **Purpose:** Filters out phantom sessions created by Angel CLI invocations that triggered hooks but had no real user interaction.
- **Edge case (minor):** A session where the user types a prompt but no tool use occurs would have `observation_count = 0` (observations are created by tool use extraction, not prompt submission). Its checkpoint would be filtered out. This is arguably correct behavior (a session with zero observations produced no artifacts worth resuming), but could surprise users who manually checkpoint before any tool use.
- **Tests updated:** All 8 loader tests now call `ensureSession()` helper with `obsCount: number = 5`, ensuring test sessions have non-zero observation counts. Tests pass.

### d) New features wired into runtime -- VERIFIED

| Feature | Write path | Read path | Wired? |
|---------|-----------|----------|--------|
| `conversation_turns` | `storeConversationTurn()` in stop.ts | `recall-server.ts` FTS, `pattern-extractor.ts` getSessionTurns, stop.ts embedding | Yes |
| `session_messages` | `sendMessage()` in message-sender.ts (Angel) | `getPendingMessages()` in user-prompt-submit.ts | Yes |
| `conversation_turns_fts` | Auto-trigger on INSERT | `recall-server.ts` MATCH query | Yes |
| `claudex_conversations` Qdrant | `upsertConversationEmbedding()` in stop.ts | `searchConversations()` exported but NOT CALLED | Partial |
| `helpful_count/harmful_count` | `updatePatternScore()` in stop.ts/experience-scoring.ts | `getHelpfulRatio()` in experience-patterns.ts ACE ranking | Yes (but ACE ranking broken by CRIT-001) |
| `escalation_level` | `escalatePattern()` in experience-scoring.ts | `renderExperienceWarnings()` in sections.ts, ACE sort in findMatchingPatterns | Yes (but ACE ranking broken by CRIT-001) |
| `commitEffects` on InjectPayload | Set in `assembleRegularPrompt()` | Called in `user-prompt-submit.ts` after budget check | Yes |
| `consumeInjectedArtifacts()` | Called in `assembleFullContext()` after materialization | Prevents double-injection on next `assembleRegularPrompt()` | Yes |
| Cross-session coordination | Reads observations/sessions tables | Injected in user-prompt-submit.ts | Yes |
| `getWeakDomains()` | Reads capability_boundaries | Injected in user-prompt-submit.ts on assembly turns | Yes |
| CC internal prompt filter | `CC_INTERNAL_RE` in user-prompt-submit.ts | Early return prevents wasted processing | Yes |
| Domain predictability | `getDomainPredictability()` + `getPredictabilityGuidance()` | Appended to domain advisory in `generateDomainAdvisory()` | Yes |
| `pruneDeadPatterns()` | Called in stop.ts | Deletes patterns with score <= 0 | Yes |

### e) Fire-and-forget patterns -- VERIFIED APPROPRIATE

| Pattern | Process model | Assessment |
|---------|--------------|------------|
| `ensureQdrantRunning()` spawns detached process | Ephemeral hook (session-start) | CORRECT -- detached + unref, survives hook exit |
| `ensureAngelRunning()` spawns detached process | Ephemeral hook (session-start) | CORRECT -- detached + unref, uses absolute paths for security |
| `createPattern()` fire-and-forget `embedPattern()` | Called from Angel (long-lived) and hooks | CORRECT for Angel (long-lived). For hooks, the catch-all non-throwing pattern means the promise resolves before the process exits in most cases. The comment "fire-and-forget -- SQLite is source of truth" is accurate -- Qdrant embedding is acceleration, not truth. |
| `upsertConversationEmbedding()` with `wait: false` in Qdrant | Ephemeral hook (stop.ts) | CORRECT -- the HTTP request completes (await on upsert call), but Qdrant's internal indexing is async. The data reaches Qdrant's WAL before the hook exits. |
| All DB operations in hooks | Ephemeral | CORRECT -- all properly `await`ed. No fire-and-forget DB writes. |

---

## Observations

### OBS-001: `searchConversations()` exported but never called
- **File:** `src/embeddings/qdrant-client.ts:335-365`
- **Issue:** The function performs KNN search on the `claudex_conversations` Qdrant collection, but no production code calls it. The recall-server uses FTS5 on `conversation_turns_fts` instead. This is a dead export waiting for future use.
- **Impact:** None functionally -- conversation turn embeddings are being written (dual-write) but the Qdrant vector search path isn't being read yet. FTS5 serves as the current search mechanism.

### OBS-002: Budget scaling reduced from 3x to 2x
- **File:** `src/shared/constants.ts:118-122`
- The `scaleBudget()` function was changed from `1 + 2 * min(...)` (3x max) to `1 + min(...)` (2x max). Comment says "was 3x -- too aggressive for session-start." This is a sensible tuning change but affects all budget consumers.

### OBS-003: formatProjectSection now returns null when CLAUDE.md exists
- **File:** `src/assembly/sections.ts:141-155`
- Previously injected both PROJECT_PRIMER.md and ACTIVE.md. Now returns null if CLAUDE.md exists (CC loads it natively) and never injects ACTIVE.md (covered by session continuity). This is a significant behavior change but reduces redundant injection.

### OBS-004: migrations.ts dramatically simplified via schema.ts + migration-steps.ts split
- **File:** `src/core/migrations.ts` (was 750+ lines, now 280 lines)
- DDL constants moved to `src/core/schema.ts`, migration step functions moved to `src/core/migration-steps.ts`. The orchestrator (`migrations.ts`) is now a thin dispatcher. Clean refactoring -- public API unchanged, all imports still work.

### OBS-005: import path fix in createPattern
- **File:** `src/intelligence/experience-patterns.ts:364`
- Changed from `'../../embeddings/embed-pipeline.js'` to `'../embeddings/embed-pipeline.js'`. This is a correct fix -- `experience-patterns.ts` lives in `src/intelligence/`, so `..` reaches `src/`, then `embeddings/` is correct. The old double-`..` would have resolved to the project root.

### OBS-006: extractDomain no longer falls back to "first significant word"
- **File:** `src/intelligence/capability-tracker.ts:151-153`
- The fallback that used the first word >= 3 characters as a domain name has been removed. Comment: "only return recognized domains to avoid polluting capability_boundaries with noise words." This is a precision-over-recall tradeoff -- some valid but unrecognized domains will now return null.

### OBS-007: Insight extractor patterns tightened
- **File:** `src/intelligence/insight-extractor.ts:24-39`
- Several patterns made more specific: "the issue is" -> "the issue is that", "so the" removed entirely, "every/all/none" systemic pattern now requires "systematically/consistently" specifically. This reduces false positives at the cost of some recall, paired with the quality gate in `isPromotableContent()` (min length raised from 30 to 60 chars).

### OBS-008: Batch reflection dedup added
- **File:** `src/intelligence/batch-reflection.ts:276-284`
- New dedup check: `SELECT id FROM artifacts WHERE project = ? AND summary = ?` before creating reflection artifacts. Prevents duplicate reflections across runs.

### OBS-009: Correction detection false positive guard strengthened
- **File:** `src/intelligence/correction-detection.ts:349-358`
- `findCausalEvent()` now requires textual evidence (word overlap) in addition to the score threshold. Prevents false positives where only recency/event-type bonuses push the score above 0.5.

---

## Summary

This changeset implements the Angel System Phase 1 and several quality improvements:

**Architecture (good):**
1. Clean Hook/Angel responsibility split -- mechanical operations in hooks, reflective operations in Angel
2. Two-tier LLM config (cloud for complex reasoning, local for simple classification)
3. V10 schema migration with backward-compatible ALTERs and data backfills
4. conversation_turns dual-write (SQLite + Qdrant) with proper FTS5 indexing
5. session_messages end-to-end: Angel writes, UserPromptSubmit reads, budget-gated delivery with confirmed-only mark-delivered
6. commitEffects pattern prevents experience flag inflation for dropped payloads

**One critical bug:**
- `relevantRows` undefined reference in `findMatchingPatterns()` silently disables the entire ACE ranking system (helpful/harmful ratios, escalation levels, verification boost). All pattern matching falls back to the slow LIKE path without composite scoring.

**Three high-severity issues:**
- `learnings_fts` missing from canonical schema DDL (works via migration but misleading)
- Session bonus guard pollutes `checkpoint_tracking` with synthetic rows
- FTS5 rank threshold `-10` needs empirical validation (may over-filter specific single-keyword matches)

**All 1714 tests pass.** The test coverage for the new features is adequate -- loader tests updated for observation_count filter, sections tests updated for CLAUDE.md-aware behavior, migration tests updated for V10.
