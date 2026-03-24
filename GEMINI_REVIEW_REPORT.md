# Gemini Architecture Review Report

**Scope:** Uncommitted changes since 28f4f39 (6 substantive files, ~150 lines delta)
**Date:** 2026-03-24 (Session 33)
**Reviewer:** Claude Opus 4.6 (standing in for Gemini)
**Grade:** B+ (87/100)

## Dimension Scores

| Dimension | Weight | Score | Assessment |
|-----------|--------|-------|------------|
| Coherence | 25% | 92/100 | Per-session suppression integrates cleanly with the existing experience flag lifecycle. Importance probe is architecturally consistent with the existing assembly-turn materialization pattern. |
| Pattern Consistency | 20% | 88/100 | Consistent non-throwing, cachedPrepare, try/catch guards. session_injected_ids follows the same merge-on-write pattern as all other ExperienceFlags fields. |
| Structural Efficiency | 10% | 82/100 | File ingester embedding backfill adds ~10 embedding calls to session-start. Importance probe adds a DB query to every regular turn with prompt >= 30 chars. Both appropriately guarded. |
| Contract Alignment | 20% | 85/100 | findMatchingPatternsHybrid exported but never called — dead code. embedArtifact in lifecycle.ts correctly awaited. session_injected_ids type consistency (string[]) matches experience_patterns.id (TEXT). |
| Dependency Health | 10% | 90/100 | Dynamic import for embed-pipeline in file-ingester avoids circular dependency. Qdrant imports in findMatchingPatternsHybrid also use dynamic import. |
| Wiring Verification | 15% | 86/100 | Per-session suppression fully wired (write in applyEffects, read in renderExperienceWarnings). Importance probe wired to searchArtifactsGlobal + materializeArtifacts. findMatchingPatternsHybrid is dead code. |

---

## Review Question Answers

### Q1: Per-session pattern suppression + experience flag lifecycle

**Verdict: Clean integration, one minor concern.**

The new `session_injected_ids` field follows the exact same lifecycle as all other `ExperienceFlags` fields:
- Declared in the `ExperienceFlags` interface (experience-flags.ts:119-122)
- Default value `[]` in `getExperienceFlags()` (experience-flags.ts:154)
- Safe deserialization with `Array.isArray` guard (experience-flags.ts:178-180)
- Merge-on-write in `setExperienceFlags()` (experience-flags.ts:211)

The suppression logic in `renderExperienceWarnings()` (assembler.ts:149-159) reads `session_injected_ids` and filters already-seen patterns before rendering. The accumulation in `applyEffects()` (assembler.ts:185-191) correctly reads current flags, unions with new IDs via `new Set(...)`, and writes back.

**Minor concern:** `applyEffects()` calls `getExperienceFlags()` a second time inside the callback (assembler.ts:186) even though the caller in `assembleFullContext` just passed through `renderExperienceWarnings` which also reads flags (assembler.ts:153). This is 2 reads of the same data per pattern injection. Not a bug — the second read is necessary because `applyEffects()` is deferred and flags may have been modified between render and apply — but it's worth noting as a 2x read cost per injection event.

**Critical contract preserved:** The `injected_pattern_ids` (per-turn, cleared each turn) remains distinct from `session_injected_ids` (session-scoped, never cleared). The Stop hook's scoring logic reads `injected_pattern_ids` / `awaiting_feedback_ids`, not `session_injected_ids`, so the suppression mechanism does not interfere with the feedback scoring loop.

### Q2: findMatchingPatternsHybrid — dead code

**Verdict: Exported but never called. Dead code.**

`findMatchingPatternsHybrid` is defined at experience-patterns.ts:481 and exported, but grep confirms zero callers in the entire codebase. The assembler uses `findMatchingPatterns` (sync, FTS5-only) in `renderExperienceWarnings()`. The MCP recall-server uses `hybridSearchSync` / `hybridSearchAsync` from hybrid-retrieval.ts. No code path invokes the hybrid pattern matcher.

This appears to be scaffolding for a planned upgrade (pattern matching via FTS5 + Qdrant vector similarity), but the integration was not completed. The function itself is correctly implemented — it calls `findMatchingPatterns()` for FTS5 results, then augments with Qdrant `searchPatterns()` results, deduplicates by ID, and re-fetches full pattern rows from SQLite. The `SELECT * FROM experience_patterns WHERE id = ? AND score >= 2` query correctly enforces the minimum score gate.

**Recommendation:** Either wire it into `renderExperienceWarnings()` (replacing `findMatchingPatterns`) or remove it to avoid dead code accumulation.

### Q3: File ingester embedding backfill — will it run?

**Verdict: Yes, the async/await chain is correct. It will run and block session-start.**

Call chain:
1. `session-start.ts:188` — `await ingestFileArtifacts(ctx.db, ...)` (properly awaited)
2. `file-ingester.ts:304` — `ingestTx()` completes synchronously (better-sqlite3 transaction)
3. `file-ingester.ts:308-336` — Embedding backfill executes after the transaction
4. `file-ingester.ts:322` — `await import('../embeddings/embed-pipeline.js')` (dynamic import, properly awaited)
5. `file-ingester.ts:325` — `await Promise.allSettled(batch.map(...))` (properly awaited)

The `await` on `Promise.allSettled` means session-start will wait for all 10 embedding calls to complete (or fail) before returning the assembled context. This is correct for ephemeral hooks — fire-and-forget would lose the embeddings.

**Performance concern:** Each `embedArtifact` call makes an HTTP request to Ollama for embedding generation + a Qdrant upsert. With batch size 10, this could add 2-5 seconds to session-start latency (depending on Ollama throughput). The `LIMIT 20` on the SQL query and `slice(0, 10)` cap are reasonable bounds.

**Comment accuracy issue:** The comment says "fire-and-forget — session-start has time budget" (file-ingester.ts:306) but the code does `await Promise.allSettled(...)` which is NOT fire-and-forget — it blocks until all embeddings complete or fail. The comment is misleading. The behavior (awaited) is correct; the comment is wrong.

### Q4: Importance probe on regular turns — interference with materialization

**Verdict: No interference. Additive only.**

The importance probe (user-prompt-submit.ts:173-184) runs on the `else` branch — only when `!isPostCompaction && !topicShift?.shifted`. It calls `searchArtifactsGlobal()` (FTS5 search) then `materializeArtifacts()` on results with `importance >= 4`.

The existing materialization on assembly turns (user-prompt-submit.ts:160-172) runs on the `if (isPostCompaction || topicShift?.shifted)` branch. These are mutually exclusive code paths.

`materializeArtifacts()` sets artifact state to `'materialized'`. The assembler's `assembleRegularPrompt()` at step 5 (assembler.ts:622) calls `getMaterializedArtifacts()` which reads materialized artifacts. `assembleFullContext()` at priority 3 also reads them. Both paths call `consumeInjectedArtifacts()` after injection, which packs the artifacts so they don't re-inject next turn.

**Net effect:** The importance probe can materialize high-importance artifacts on regular turns. If the assembler's experience warning injection (step 4, assembler.ts:601-615) fires, it returns before step 5, so the materialized artifacts would carry over to the next turn. If step 4 doesn't fire, step 5 picks up the materialized artifacts and injects them. Either way, the artifacts get consumed after injection. No double-injection or interference.

**One edge case:** If the importance probe materializes artifacts AND the assembler's experience warnings fire on the same turn, the experience warnings take priority (step 4 returns early), and the materialized artifacts sit until next turn's step 5. This is correct behavior — experience warnings are higher priority — but the materialized artifacts persist one extra turn.

### Q5: Fire-and-forget patterns — file ingester Promise.allSettled

**Verdict: NOT fire-and-forget. Correctly awaited. Does NOT block the session-start hook's return.**

Wait — correction. It DOES block session-start. Let me trace precisely:

1. `session-start.ts:188` — `await ingestFileArtifacts(...)` — **blocks until complete**
2. Inside `ingestFileArtifacts`, the `await Promise.allSettled(...)` at line 325 — **blocks until all embeddings resolve/reject**
3. Session-start continues to line 198 (`assembleFullContext`) only after ingestion + embedding completes

So embedding backfill DOES block session-start. Each Ollama embedding call takes ~200-500ms. With 10 embeddings, that's 2-5 seconds of blocking. However, `Promise.allSettled` runs them in parallel, and the concurrency is capped at 10 by the `slice(0, 10)`.

**Assessment: Appropriate but should be documented.** Ephemeral hooks MUST await all async work because the process exits after returning. Fire-and-forget would silently lose the embedding work. The blocking cost is bounded (10 parallel calls, Ollama is local, ~2-5s worst case, only on files lacking embeddings). First session-start after a schema upgrade or fresh install would be slowest (all artifacts unembedded); subsequent starts would find most artifacts already embedded.

**The lifecycle.ts embedArtifact call (line 1042) is also correctly awaited** for the same reason — ephemeral hook processes can't fire-and-forget.

### Q6: Cross-session coordination N+1 fix — batch IN-clause queries

**Verdict: The N+1 fix was committed in 28f4f39, not in the uncommitted changes. The batch queries are correct.**

`getCrossSessionActivity()` was consolidated from 21 queries (1 + 4xN) to 3 queries in commit 28f4f39. The uncommitted changes do NOT modify `cross-session-coordination.ts`.

The batch IN-clause queries at lines 69-82 are correct:
- `db.prepare(...)` is used instead of `cachedPrepare(...)` because the IN-clause has a variable number of placeholders — correct rationale (dynamic SQL can't be cached by text).
- The `...sessionIds, oneHourAgo` spread passes session IDs followed by the epoch cutoff — parameter order matches the SQL.
- The 0-sessions case is handled by the early return at line 63: `if (sessions.length === 0) return [];` — the batch queries never execute with an empty IN-clause.

**`detectFileConflicts` still has N+1:** Lines 137-157 loop over `myFiles` and run a per-file query. However, this is bounded by the result count of the initial query (files edited by current session in last 5 minutes) and is non-critical — it runs once per prompt, the file count is typically small (< 5), and the query uses `cachedPrepare` for statement caching.

---

## FINDINGS

### FINDING-HIGH-001: findMatchingPatternsHybrid is dead code
- **File:** `src/intelligence/experience-patterns.ts:481-515`
- **Severity:** HIGH (dead code, exported public function)
- **Issue:** Exported async function with no callers. Adds ~35 lines of untested code to the module. The function is architecturally sound but unwired.
- **Risk:** Without tests, it may silently break when the Qdrant client API changes. The `String(vr.id)` cast assumes Qdrant returns numeric IDs for patterns, but experience_patterns uses TEXT primary keys — the Qdrant upsert in `createPattern()` would need to use the TEXT id as the point ID, not a numeric one.
- **Recommendation:** Wire into `renderExperienceWarnings()` or remove.

### FINDING-MED-001: Misleading "fire-and-forget" comment in file ingester
- **File:** `src/core/file-ingester.ts:306`
- **Severity:** MEDIUM (misleading documentation)
- **Issue:** Comment says "fire-and-forget — session-start has time budget" but the code uses `await Promise.allSettled(...)` which blocks until completion. The behavior is correct; the comment is wrong.
- **Fix:** Change comment to "Embed newly ingested artifacts — awaited because hooks are ephemeral."

### FINDING-MED-002: Double read of experience flags in applyEffects
- **File:** `src/assembly/assembler.ts:153 + 186`
- **Severity:** MEDIUM (minor performance)
- **Issue:** `renderExperienceWarnings()` reads flags at line 153 (for suppression check), then the deferred `applyEffects()` closure reads flags again at line 186 (for accumulation). The second read is correct (flags may change between render and apply), but in practice both happen within the same hook invocation with no concurrent writers.
- **Impact:** 2 extra DB reads per pattern injection event. Negligible for SQLite.

### FINDING-MED-003: detectFileConflicts retains per-file N+1 pattern
- **File:** `src/intelligence/cross-session-coordination.ts:137-157`
- **Severity:** MEDIUM (performance, bounded)
- **Issue:** While `getCrossSessionActivity` was consolidated to 3 queries, `detectFileConflicts` still loops per file. Bounded by recent file edit count (typically < 5) and uses `cachedPrepare`.
- **Recommendation:** Could be consolidated into a single query with IN-clause on file paths, but low priority given the bounded loop.

### FINDING-LOW-001: Importance probe threshold (>= 30 chars) differs from experience pattern threshold (>= 20 chars)
- **File:** `src/adapters/cc-hooks/user-prompt-submit.ts:173` vs `src/assembly/assembler.ts:601`
- **Severity:** LOW (inconsistency)
- **Issue:** The importance probe requires `prompt.length >= 30` while experience pattern matching in `assembleRegularPrompt()` requires `prompt.length >= 20`. No technical reason for the difference — both use FTS5 queries. The 30-char threshold is slightly more conservative, which is reasonable for a supplementary feature, but the inconsistency could confuse future maintainers.

---

## Wiring Verification Detail

### Per-session pattern suppression — FULLY WIRED

| Component | Location | Role | Verified |
|-----------|----------|------|----------|
| `session_injected_ids` field | experience-flags.ts:119-122 | Interface declaration | Yes |
| Default value `[]` | experience-flags.ts:154 | Safe default | Yes |
| Deserialization guard | experience-flags.ts:178-180 | `Array.isArray` check | Yes |
| Merge-on-write | experience-flags.ts:211 | `??` preserves existing | Yes |
| Read for suppression | assembler.ts:153-154 | Filter already-seen patterns | Yes |
| Write for accumulation | assembler.ts:186-191 | Union new IDs into session set | Yes |
| Stop hook scoring | stop.ts (uses `awaiting_feedback_ids`) | Does NOT use `session_injected_ids` | Correct separation |

### Importance probe — WIRED

| Component | Location | Role | Verified |
|-----------|----------|------|----------|
| Trigger condition | user-prompt-submit.ts:173 | `else if (prompt && prompt.length >= 30)` | Yes |
| Search | user-prompt-submit.ts:179 | `searchArtifactsGlobal(db, routedProject, prompt, 3)` | Yes |
| Filter | user-prompt-submit.ts:180 | `a.importance >= 4` | Yes |
| Materialization | user-prompt-submit.ts:182 | `materializeArtifacts(db, highImportance.map(a => a.id), ctx.project)` | Yes |
| Consumption | assembler.ts:448 | `consumeInjectedArtifacts()` after injection | Yes (existing) |

### File ingester embedding backfill — WIRED

| Step | Location | Await chain | Verified |
|------|----------|-------------|----------|
| session-start calls | session-start.ts:188 | `await ingestFileArtifacts(...)` | Yes |
| Transaction completes | file-ingester.ts:304 | `ingestTx()` sync | Yes |
| Query unembedded | file-ingester.ts:309-316 | `cachedPrepare(...).all(project)` sync | Yes |
| Dynamic import | file-ingester.ts:322 | `await import(...)` | Yes |
| Parallel embed | file-ingester.ts:325 | `await Promise.allSettled(...)` | Yes |
| Ollama connection | embed-pipeline.ts | HTTP to localhost:11434 | Yes |
| Qdrant upsert | qdrant-client.ts | HTTP to localhost:6333 | Yes |

### Lifecycle learning artifact embedding — WIRED

| Step | Location | Verified |
|------|----------|----------|
| `createArtifact` returns ID | artifacts.ts:116 | `Number(result.lastInsertRowid)` — always > 0 on success |
| Guard check | lifecycle.ts:1040 | `if (artId > 0)` | Yes |
| Await embed | lifecycle.ts:1042 | `await embedArtifact(...)` | Yes |
| Import | lifecycle.ts:40 | Static import (not dynamic) | Yes |

### findMatchingPatternsHybrid — NOT WIRED

| Caller | Location | Status |
|--------|----------|--------|
| (none) | — | Dead code |

---

## Test Results

All **1714 tests** pass across **92 test files**. Duration: 9.57s.

No new tests were added for the uncommitted changes (per-session suppression, importance probe, file ingester embedding backfill, findMatchingPatternsHybrid). The existing test suite covers the underlying functions but not the new integration points.

---

## Summary

This changeset adds four features to the uncommitted working tree:

1. **Per-session pattern suppression** (assembler.ts + experience-flags.ts): Prevents the same experience warning from appearing on every prompt within a session. Clean integration with the existing flag lifecycle. Session_injected_ids accumulates across turns, never cleared. Correctly separated from the per-turn injected_pattern_ids used by Stop hook scoring.

2. **Importance probe on regular turns** (user-prompt-submit.ts): Materializes high-importance artifacts (importance >= 4) even when no topic-shift or compaction triggered full materialization. Additive-only — no interference with existing materialization paths. Mutually exclusive code path with assembly-turn materialization.

3. **File ingester embedding backfill** (file-ingester.ts): Embeds newly ingested file artifacts at session-start. Correctly awaited (not fire-and-forget despite the misleading comment). Bounded at 10 parallel embeddings with graceful failure. Adds 2-5s to first session-start after fresh install; minimal cost on subsequent starts.

4. **findMatchingPatternsHybrid** (experience-patterns.ts): Dead code. Exported but never called. Architecturally sound implementation of FTS5 + Qdrant hybrid pattern matching, but not wired into any caller.

5. **Learning artifact embedding** (lifecycle.ts): New learning artifacts created during compaction are now embedded immediately. Correctly awaited. Properly guarded by `artId > 0` check.

**Grade rationale:** B+ (87/100). All features are non-breaking, correctly guarded with try/catch, and follow existing patterns. One dead export (findMatchingPatternsHybrid) and one misleading comment are the main issues. No critical bugs. No test regressions.
