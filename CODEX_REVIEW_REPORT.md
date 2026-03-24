# Codex Review Report

**Scope:** Uncommitted changes since 28f4f39 (8 files, ~133 lines added)
**Date:** 2026-03-24
**Reviewer:** Claude Opus 4.6 (1M context)
**Build:** PASS (65ms) | **Tests:** 1714/1714 PASS (7.65s)

---

## Summary

Six focused changes: per-session pattern suppression, hybrid pattern matching, importance probe on regular turns, file ingester embedding backfill, learning artifact embedding in compaction, and the experience-flags plumbing to support it all. One real bug found (ID mismatch in hybrid search). Everything else is clean.

---

## 1. Per-session pattern suppression in assembler.ts

**Verdict: PASS (minor observation)**

The `renderExperienceWarnings` function reads `session_injected_ids` from experience flags, builds a `Set`, filters out already-seen patterns, then in `applyEffects()` re-reads current flags and accumulates new IDs via `[...new Set([...current, ...new])]`.

**Race conditions:** Not a concern. CC hooks are single-threaded Node.js processes. The `applyEffects()` callback runs synchronously within a single hook invocation. SQLite is in WAL mode with `busy_timeout`, so concurrent sessions won't corrupt each other's flags (they have different `sessionId`). The read-modify-write gap between `getExperienceFlags` and `setExperienceFlags` inside `applyEffects` is safe because no other code path modifies `session_injected_ids` for the same session within the same process tick.

**Observation:** The `applyEffects` closure re-reads flags from DB (`getExperienceFlags`) even though the render phase already read them. This is intentional and correct -- the render phase read may be stale by the time effects are applied (e.g., in `assembleFullContext` where budget gating may defer application). The double-read costs one extra SELECT but guarantees correctness.

---

## 2. findMatchingPatternsHybrid in experience-patterns.ts

**Verdict: BUG -- ID type mismatch (dead code, no production impact)**

The async/sync boundary is clean: `findMatchingPatterns` (sync FTS5) runs first, then async Qdrant search augments results. Dynamic imports (`await import(...)`) are correct for optional dependencies.

**Bug:** The function uses `String(vr.id)` to look up patterns in the DB, but `vr.id` is a **numeric hash** (from `hashStringToInt(patternId)` in `upsertPatternEmbedding`), not the original ULID string. The original ULID is stored in `payload.pattern_id_str`, not in the point ID. The SQL query `WHERE id = ?` will never match because `experience_patterns.id` is a ULID string like `01HYZ3...`, not a number like `2847193`.

**Fix:** Replace `String(vr.id)` with `String(vr.payload?.pattern_id_str ?? vr.id)`.

**Production impact: NONE.** `findMatchingPatternsHybrid` is exported but never imported or called from any production code path. It's dead code -- the assembler still calls the sync `findMatchingPatterns`. This function was presumably added for future use. The bug will bite when it's wired in.

---

## 3. Importance probe in user-prompt-submit.ts

**Verdict: PASS**

The regular-turn materialization probe is correctly gated:
- Only fires on `else` branch (not assembly turns)
- Minimum prompt length: 30 chars (prevents FTS noise on short inputs)
- Search limited to 3 results (vs. 10 on assembly turns) -- respects budget
- Filter: `importance >= 4` -- only decisions and learnings, not ephemeral observations
- `materializeArtifacts` sets `state = 'materialized'` which makes them visible to the assembler on the next turn -- it does NOT inject directly

**Budget:** Materialization does not consume injection token budget. It sets a DB flag. The assembler's `formatMaterializationLayer` handles the actual rendering and budget check. This is correct.

**Concern (minor):** If a user sends many 30+ char prompts about the same topic, the same high-importance artifacts will be re-materialized every turn. `materializeArtifacts` is idempotent (sets `state = 'materialized'` which is already set), so this is wasteful but not harmful. Could add a check for `state != 'materialized'` in the query, but that's an optimization, not a bug.

---

## 4. File ingester embedding backfill

**Verdict: PASS (misleading comment)**

`Promise.allSettled` is correct: individual embedding failures don't reject the batch, and `allSettled` always resolves (never rejects). The batch is capped at 10 artifacts (`slice(0, 10)`) to limit latency.

**Blocking question:** Yes, it blocks session-start. `ingestFileArtifacts` is `await`ed in session-start (line 188), and the embedding backfill inside it is also `await`ed via `Promise.allSettled`. The comment says "fire-and-forget" but the code awaits. This is a **comment/code mismatch**, not a logic bug. Since hooks are ephemeral, awaiting is the correct behavior -- fire-and-forget would lose the work. The comment should say "awaited, capped to 10 for latency."

**Latency impact:** With Ollama running locally, embedding 10 short texts takes ~1-2 seconds. This is within acceptable bounds for session-start (which already does checkpoint loading, assembly, etc). If Ollama is down, the try/catch returns immediately.

**Query correctness:** `WHERE embedding IS NULL AND artifact_type IN (...)` correctly targets only artifacts that haven't been embedded yet. The `ORDER BY importance DESC LIMIT 20` ensures highest-value artifacts get embedded first, and the `slice(0, 10)` further caps concurrency.

---

## 5. Learning artifact embedding in lifecycle.ts

**Verdict: PASS**

`embedArtifact` is properly `await`ed (line 1042). The comment explicitly says "awaited because hooks are ephemeral." The try/catch with empty catch block is consistent with the project pattern of non-throwing embedding operations.

The `artId > 0` check is valid -- `createArtifact` returns `Number(result.lastInsertRowid)` which is always positive for successful inserts.

Static import at line 40 (`import { embedArtifact } from '../../embeddings/embed-pipeline.js'`) is correct and avoids the overhead of dynamic import on every compaction.

---

## 6. experience-flags.ts -- session_injected_ids merge

**Verdict: PASS**

Three changes, all correct:

1. **Interface**: `session_injected_ids: string[]` added to `ExperienceFlags` with docs.
2. **getExperienceFlags**: Default value `[]`, parsed with `Array.isArray()` guard. Falls through to default on parse failure.
3. **setExperienceFlags**: Uses `updates.session_injected_ids ?? current.session_injected_ids` for merge. This means if the caller doesn't include `session_injected_ids` in updates, the existing value is preserved.

**Correctness of merge in assembler:** The assembler calls `setExperienceFlags` with all three fields (`injected_pattern_ids`, `injected_topic_keys`, `session_injected_ids`). The `session_injected_ids` value is the deduplicated accumulation of current + new. The `injected_pattern_ids` and `injected_topic_keys` are the **current turn's** IDs (not accumulated) -- this is correct because the Stop hook needs to know which patterns were injected on this specific turn for scoring.

---

## 7. Import and call-site verification

| Import | Source | Real? | Called from production? |
|---|---|---|---|
| `getExperienceFlags` | experience-flags.ts:142 | YES | YES (assembler.ts:153, :186) |
| `setExperienceFlags` | experience-flags.ts:195 | YES | YES (assembler.ts:188) |
| `findMatchingPatternsHybrid` | experience-patterns.ts:481 | YES | **NO -- dead code** |
| `embedArtifact` (static) | embed-pipeline.ts:136 | YES | YES (lifecycle.ts:260, :1042) |
| `embedArtifact` (dynamic) | embed-pipeline.ts:136 | YES | YES (file-ingester.ts:322) |
| `searchArtifactsGlobal` | artifacts.ts:476 | YES | YES (user-prompt-submit.ts:179) |
| `materializeArtifacts` | artifacts.ts (existing) | YES | YES (user-prompt-submit.ts:182) |
| `searchPatterns` | qdrant-client.ts:433 | YES | NO (only used inside dead `findMatchingPatternsHybrid`) |
| `embedQuery` | embed-pipeline.ts:284 | YES | NO (only used inside dead `findMatchingPatternsHybrid`) |

All imports resolve to real exported functions. Two functions (`searchPatterns`, `embedQuery`) are only reachable through the dead `findMatchingPatternsHybrid` code path.

---

## Findings Summary

| # | Severity | File | Finding |
|---|---|---|---|
| 1 | **BUG** | experience-patterns.ts:499 | `String(vr.id)` uses numeric hash instead of ULID from `payload.pattern_id_str`. Pattern DB lookups will always miss. Dead code -- no production impact yet. |
| 2 | **WARN** | file-ingester.ts:306 | Comment says "fire-and-forget" but code awaits `Promise.allSettled`. Comment/code mismatch. |
| 3 | **INFO** | experience-patterns.ts:481 | `findMatchingPatternsHybrid` is exported but never called. Dead code awaiting wiring. |
| 4 | **INFO** | user-prompt-submit.ts:179 | Importance probe re-materializes already-materialized artifacts. Idempotent but wasteful on repeated same-topic prompts. |

---

## Grade: **A-**

One real bug in dead code, one misleading comment, zero production-path defects. All 1714 tests pass. Build clean. The suppression accumulation logic is correct and race-free. The importance probe respects budget boundaries. Embedding in lifecycle.ts is properly awaited. Experience flags merge is sound.

The A- (not A) is for shipping dead code with a latent bug. The `findMatchingPatternsHybrid` function will silently return FTS-only results when wired in (Qdrant matches will never resolve from DB). Fix the ID lookup before connecting it to the assembler.
