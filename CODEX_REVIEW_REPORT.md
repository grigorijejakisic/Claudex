# Codex Review Report

**Scope:** All uncommitted changes (50 files, ~4200 lines changed)
**Date:** 2026-03-24
**Reviewer:** Claude Opus 4.6 (1M context)
**Grade:** B-

---

## Executive Summary

Large changeset implementing the Angel System (persistent guardian process), Hook/Angel responsibility split, ACE pattern scoring, conversation turn storage, and multiple retrieval quality improvements. Architecture is sound -- ephemeral hooks do mechanical work, Angel does reflective work. Code quality is generally high, with proper non-throwing patterns, good security practices (Angel spawn path hardening, CWD safety), and well-thought-out deduplication logic.

One **critical runtime bug** and several moderate issues found.

---

## Critical Issues

### [BUG] `relevantRows` ReferenceError in `findMatchingPatterns` (experience-patterns.ts:438)

**Severity:** CRITICAL -- runtime crash
**File:** `src/intelligence/experience-patterns.ts:438`

The FTS5 query result is assigned to `rows` (line 434), but line 438 references `relevantRows` -- a variable that does not exist. This is a `ReferenceError` that will crash `findMatchingPatterns()` at runtime whenever the FTS5 query succeeds (i.e., whenever patterns match a user prompt).

The function falls into the `catch` block and calls `findMatchingPatternsFallback`, so the system degrades to LIKE-based matching rather than crashing the hook. But: **the entire ACE ranking logic (verification boost, helpful ratio, escalation sorting) is dead code** -- it never executes because the ReferenceError fires before it runs.

```typescript
// Line 434: result assigned to `rows`
).all(ftsQuery, project, GLOBAL_PROJECT_SCOPE, project, safeLimit * 2) as ExperiencePattern[];

// Line 438: references `relevantRows` -- DOES NOT EXIST
const ranked = relevantRows.map(p => {
```

**Fix:** Change `relevantRows` to `rows` on line 438.

---

## Major Issues

### [BUG] FTS rank filter comment/code mismatch (experience-patterns.ts:417-427)

Comment says "rank must be better (more negative) than -15" but the SQL filter is `fts.rank < -10`. This means the filter is MORE aggressive than documented -- it will exclude more matches than intended. Since the critical bug above prevents this code from functioning anyway, impact is deferred, but should be corrected alongside the fix.

### [DESIGN] `__bonus_guard__` session_id in checkpoint_tracking (stop.ts:250-265)

The session success bonus guard uses `checkpoint_tracking` table with synthetic session IDs like `__bonus_guard__<session_id>`. This pollutes the table with non-session rows, which could:
- Inflate row counts in queries that scan `checkpoint_tracking`
- Cause confusion during debugging
- Interact badly with any future code that assumes `session_id` in this table references real sessions

**Recommendation:** Use a dedicated guard table or a session-scoped flag (e.g., via `experience_flags`).

### [QUALITY] `learnings_fts` missing from SCHEMA_V3 DDL (schema.ts)

The `learnings_fts` FTS5 virtual table and its sync triggers are NOT declared in the main `SCHEMA_V3` constant in `schema.ts`. They are created by `migrateSchemaFixes()` which IS called during `initializeSchema()`, so fresh installs do get the table. However:
- The schema DDL is incomplete as documentation -- a reader of `schema.ts` won't see `learnings_fts`
- If `migrateSchemaFixes()` is ever refactored or its call order changes, fresh installs break

**Recommendation:** Add `learnings_fts` DDL to `SCHEMA_V3` for completeness.

### [TYPE] `unverified_patterns` event kind in types but not in CHECK constraint (observability/types.ts + schema.ts)

`EventKind` type includes `'unverified_patterns'` and `EventKindDetailMap` maps it, but the telemetry table's CHECK constraint doesn't allow it. Any attempt to emit this event kind would cause a SQLite constraint violation. Currently no code emits it, so impact is latent.

---

## Moderate Issues

### [QUALITY] `createTipAndStrategy` is now a dead export (experience-patterns.ts:810)

The stop hook removed all calls to `createTipAndStrategy` (moved to Angel). It's still exported from `experience-patterns.ts` but has no callers outside its own module. No Angel code calls it either -- the Angel uses `createPattern` directly.

### [DESIGN] `hybridSearchAsync` error handling regression (hybrid-retrieval.ts:550)

The old `hybridSearch` function fell back to `hybridSearchSync` on full pipeline failure:
```typescript
catch {
    return hybridSearchSync(db, query, project, options);
}
```

The new `hybridSearchAsync` returns an empty array on failure:
```typescript
catch {
    return [];
}
```

The recall-server's `claudex_search` tool calls `hybridSearchAsync` as its primary search, with no fallback to `hybridSearchSync` when the async version returns empty due to a non-query-related error. If Qdrant causes an exception during RRF merge (unlikely but possible), all search results are silently lost.

### [DESIGN] `markMessagesDelivered` uses raw `db.prepare` instead of `cachedPrepare` (message-sender.ts:71)

All other DB operations in the codebase use `cachedPrepare` for statement caching. `markMessagesDelivered` uses `db.prepare` directly, likely because the dynamic `IN (?,?,...?)` clause changes shape per call. This is functionally correct but creates a new prepared statement per invocation, which could leak if called frequently. Since delivery happens at most once per prompt, impact is minimal.

### [QUALITY] `os` import added but unused in worker-context.ts

Line 1 adds `import * as os from 'os';` but no `os.*` call is used in the changed code. The `readProjectPrimer` function changes only use `path` and `process.cwd()`.

---

## Minor Issues

### Comment accuracy issues

1. `stop.ts`: The doc comment still says "captures decisions, extracts insights, tracks thread, checks checkpoint threshold" -- the updated version lists more operations (conversation turn storage, pattern verification, etc.) but misses the new ones added below (artifact linking, activation decay).

2. `hybrid-retrieval.ts:756`: Spread activation docstring says "Unidirectional: source -> targets only" but the code below it only processes `source_id = A.id` queries, which is correct. The old comment mentioning "bidirectional" was wrong.

### Test coverage gaps

1. No tests for `ensureQdrantRunning()` or `ensureAngelRunning()` in session-start.
2. No tests for `storeConversationTurn()` in lifecycle.ts.
3. No tests for the ACE escalation logic (`escalatePattern`, `getHelpfulRatio`).
4. No tests for `getWeakDomains` or `getDomainPredictability`.
5. No tests for `upsertConversationEmbedding` or `searchConversations` in qdrant-client.

### `resetReferenceEmbeddings` removed from insight-extractor.ts

The test helper `resetReferenceEmbeddings()` was removed. No tests reference it (checked), so no breakage.

---

## Angel System Review (Requested)

### pattern-extractor.ts: callClaudeCli removed, callOllama added

**Correct.** The old `callClaudeCli` (Claude CLI subprocess) would trigger CC hooks and create phantom sessions -- the exact problem the Angel spec warns against. The new `callOllama` uses the HTTP API directly (localhost:11434), no hooks involved. The Anthropic API (Priority 1) + Ollama fallback (Priority 2) cascade is properly implemented.

The `callOllama` function correctly uses `stream: false` for synchronous response collection. The extraction prompt is well-structured with conservative guardrails ("only extract patterns you're confident represent real corrections").

### types.ts: model -> cloudModel + localModel

**Correct.** Clean split: `cloudModel` (default `claude-sonnet-4-6`) for complex reasoning via API, `localModel` (default `llama3.2`) for trivial classification via Ollama. The `model` field no longer exists.

### heartbeat.ts: updated config refs

**Correct.** All references use `ctx.config.cloudModel` and `ctx.config.localModel` appropriately. The heartbeat tick structure is clean: 5 phases with clear separation of concerns.

**Concern:** Phase 4b deletes patterns where `harmful_count > helpful_count` after 5+ triggers. This is aggressive -- a pattern with 3 helpful + 4 harmful (57% harmful) gets deleted. Consider a higher threshold or a minimum harmful_count floor.

### index.ts: updated auth logic

**Correct.** Auth priority is:
1. CliProxy on localhost:8317 (MAX subscription OAuth) -- checked via HTTP health
2. ANTHROPIC_API_KEY env var
3. No auth -- Angel runs Ollama-only

The fallback client (`new Anthropic({ apiKey: 'no-auth-ollama-only', baseURL: 'http://127.0.0.1:0' })`) is clever: it creates a valid SDK object that will fail on any API call, forcing the pattern-extractor to fall through to the Ollama path. The `baseURL: 'http://127.0.0.1:0'` ensures connection refused rather than hitting a real endpoint.

PID file management is correct: write on start, remove on SIGTERM/SIGINT/uncaughtException. Race condition between PID check and PID write is theoretically possible but benign (worst case: two Angels run briefly, both doing idempotent work).

---

## checkpoint/loader.ts: observation_count filter

**Correct.** The `AND s.observation_count > 0` filter in `loadCheckpoint` prevents phantom sessions (Angel CLI invocations that triggered session-start hooks but had no real user interaction) from being selected as the "last checkpoint." Without this filter, an Angel-spawned session with 0 observations could mask the real user's last checkpoint.

The change applies to both the project-scoped and unscoped queries, which is correct. Tests were updated to use `ensureSession(db, sessionId, project, obsCount=5)` to create valid session rows.

---

## Hook Return Value Compliance

| Hook | Return Value | CC Expected Schema | Status |
|------|-------------|-------------------|--------|
| SessionStart | `{}` | Empty object | PASS |
| UserPromptSubmit | `{ hookSpecificOutput: { hookEventName, additionalContext } }` or `{}` | hookSpecificOutput with hookEventName + additionalContext | PASS |
| Stop | `{ systemMessage }` or `{}` | systemMessage string (top-level) | PASS |
| SessionEnd | `{}` | Empty object | PASS |

All hook return values conform to CC's expected JSON schema.

---

## Async Operations in Ephemeral Contexts

| Operation | Hook | Awaited? | Status |
|-----------|------|----------|--------|
| `ensureQdrantRunning()` | session-start | Yes | PASS |
| `ensureAngelRunning()` | session-start | Yes | PASS |
| `captureDecisionsWithClassifier()` | stop | Yes | PASS |
| `captureInsightsAsLearnings()` | stop | Yes (newly async) | PASS |
| `embedText()` (conversation turn) | stop | Yes | PASS |
| `upsertConversationEmbedding()` | stop | Yes | PASS |
| `embedJournalEntry()` | stop | Yes | PASS |
| `linkArtifactToRelated()` | stop | Yes | PASS |
| Cross-session coordination import | user-prompt-submit | Yes (dynamic import) | PASS |
| `hybridSearchAsync()` | recall-server | Yes | PASS |

All async operations in ephemeral hook processes are properly awaited. No fire-and-forget patterns in hooks.

---

## New Export Wiring Check

| Export | Module | Imported & Called? | Status |
|--------|--------|-------------------|--------|
| `storeConversationTurn` | lifecycle.ts | Yes (stop.ts) | PASS |
| `consumeInjectedArtifacts` | artifacts.ts | Yes (assembler.ts) | PASS |
| `upsertConversationEmbedding` | qdrant-client.ts | Yes (stop.ts) | PASS |
| `searchConversations` | qdrant-client.ts | **No** -- exported but unused | WARN |
| `hybridSearchAsync` | hybrid-retrieval.ts | Yes (recall-server.ts) | PASS |
| `extractInsightsCombined` | insight-extractor.ts | Yes (lifecycle.ts) | PASS |
| `getWeakDomains` | capability-tracker.ts | Yes (user-prompt-submit.ts) | PASS |
| `getDomainPredictability` | capability-tracker.ts | **No** -- exported but only used internally | WARN |
| `getPredictabilityGuidance` | capability-tracker.ts | Used internally via `generateDomainAdvisory` | PASS |
| `escalatePattern` | experience-patterns.ts | Yes (experience-scoring.ts) | PASS |
| `getHelpfulRatio` | experience-patterns.ts | Used internally in `findMatchingPatterns` | PASS |
| `createTipAndStrategy` | experience-patterns.ts | **No** -- dead export | WARN |
| `getCrossSessionActivity` | cross-session-coordination.ts | Yes (user-prompt-submit.ts, dynamic) | PASS |
| `detectFileConflicts` | cross-session-coordination.ts | Yes (user-prompt-submit.ts, dynamic) | PASS |
| `formatCrossSessionAwareness` | cross-session-coordination.ts | Yes (user-prompt-submit.ts, dynamic) | PASS |
| `getPendingMessages` | message-sender.ts | Yes (user-prompt-submit.ts) | PASS |
| `markMessagesDelivered` | message-sender.ts | Yes (user-prompt-submit.ts) | PASS |
| `commitEffects` | InjectPayload type | Set in assembler, called in user-prompt-submit | PASS |

---

## Build & Test Results

- **Build:** PASS (61ms, all hooks smoke-tested)
- **Tests:** 92 files, 1714 tests, ALL PASSING
- **New test files:** 3 (angel/message-sender, angel/pattern-extractor, angel/session-monitor)

---

## Summary of Required Fixes

| Priority | Issue | File | Fix |
|----------|-------|------|-----|
| **P0** | `relevantRows` ReferenceError | experience-patterns.ts:438 | Change `relevantRows` to `rows` |
| P1 | FTS rank filter comment mismatch | experience-patterns.ts:417 | Update comment to match code (`-10` not `-15`) |
| P2 | `learnings_fts` missing from SCHEMA_V3 | schema.ts | Add DDL to maintain schema completeness |
| P2 | `__bonus_guard__` table pollution | stop.ts | Consider dedicated guard mechanism |
| P3 | `unverified_patterns` type/constraint mismatch | observability/types.ts + schema.ts | Add to CHECK or remove from types |
| P3 | Dead export `createTipAndStrategy` | experience-patterns.ts | Remove or mark @deprecated |
| P3 | Unused `os` import | worker-context.ts | Remove |
| P3 | `searchConversations` exported but unused | qdrant-client.ts | Keep (future use) or remove |

---

## Grade Rationale: B-

**Strengths:**
- Architectural clarity: Hook/Angel split is well-designed and correctly implemented
- Security: Angel spawn uses absolute paths, safe CWD, hardened against PATH hijacking
- Robustness: Comprehensive non-throwing patterns, proper async await in ephemeral contexts
- Data integrity: conversation_turns dual-write (SQLite + Qdrant), dedup guards, staleness filters
- Test discipline: all 1714 tests pass, new Angel modules have test coverage

**Weaknesses:**
- P0 bug: `relevantRows` ReferenceError makes the entire ACE ranking system dead code
- ACE ranking never executes in production (masked by fallback, but the feature is silently broken)
- Schema completeness gap (`learnings_fts` not in DDL)
- Some dead exports left behind from the Hook->Angel migration
- Test coverage gaps for new Angel spawn logic and ACE escalation paths
