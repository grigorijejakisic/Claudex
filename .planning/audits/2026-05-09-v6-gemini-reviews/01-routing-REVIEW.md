# Gemini Review — v6 Routing Layer

**Date:** 2026-05-09
**Reviewer:** Gemini (via gemini-cli, model: gemini-3.1-pro-preview)
**Scope:** `src/retrieval/transcript-routing.ts` + `src/tests/retrieval/transcript-routing.test.ts`
**Overall grade:** **B-**
**Trigger:** v6.0.0 pre-push consultation

---

## Focus area analysis

- **Race conditions:** Clean. The deduplication map is locally scoped, SQLite `better-sqlite3` connections handle concurrent reads safely, and sequential iteration across artifacts avoids overwhelming the network stack.
- **Budget cap correctness:** Correct. `top_k_per_artifact` and `max_k_per_query` are strictly enforced via array slicing. The `token_pct_cap` is appropriately deferred to the downstream caller via the conservative aggregation of `bi_encoder_only` (if even one artifact degrades to bi-encoder, the whole batch signals the reduced budget).
- **Opt-in semantics:** Safe. This is a pure, pull-based utility with no implicit lifecycle hooks or side-effects. It can only be triggered explicitly per assembly site.
- **Error handling & non-throwing contract:** **Broken**. The layer fails its non-throwing contract in two critical edge cases where synchronous DB operations and string methods can throw and bypass the degradation paths.

---

## Findings

### 1. Unhandled type error on null chunk bodies — CRITICAL

- **Location:** `src/retrieval/transcript-routing.ts:153`
- **Code:** `const queryText = (artifact.query_text ?? rows[0].body).substring(0, QUERY_CHARS);`
- **Issue:** If an artifact is passed without `query_text`, the code falls back to `rows[0].body`. However, the internal ranker implementations defensively use `(c.body ?? '')` (lines 230, 290), acknowledging that DB text fields can be null/undefined. If `rows[0].body` is null, `.substring()` will throw a `TypeError`. This completely aborts the routing call, breaking the strict non-throwing contract.
- **Fix:** Add a coalescing fallback: `(artifact.query_text ?? rows[0].body ?? '').substring(...)`

### 2. Telemetry DB exception bypasses fallback logic — CRITICAL

- **Location:** `src/retrieval/transcript-routing.ts:337-338`
- **Code:** `incrementRerankerFallbackCounter(db, callerSessionId, ceFailureReason);`
- **Issue:** This synchronous SQLite insert occurs *outside* the `try/catch` block that manages the cross-encoder network fetch. If the database is busy, locked, or read-only, `incrementRerankerFallbackCounter` will throw an exception. This exception bubbles out, aborts the artifact loop, and crucially **skips the bi-encoder fallback entirely** (line 339). A minor telemetry failure destroys the retrieval attempt.
- **Fix:** Wrap the telemetry call in a dedicated `try { ... } catch {}` block to ensure `rankWithBiEncoder` is always reached.

### 3. Time-window selection blinds temporal proximity — RECOMMENDED

- **Location:** `src/retrieval/transcript-routing.ts:104`
- **Code:** `ORDER BY turn_index ASC, sub_index ASC LIMIT ${CANDIDATE_LIMIT}`
- **Issue:** The query looks 2 hours backward and 2 hours forward. Because of the `ASC` sort, if a session is chatty and produces >20 chunks in this window, the query will fetch the chronologically *first* 20 chunks (those from exactly 2 hours ago). It will systematically truncate chunks physically adjacent to the artifact's creation time.
- **Fix:** Change the sort to retrieve chunks immediately surrounding the artifact: `ORDER BY ABS(created_at_epoch_ms - ?) ASC` (passing `artifact.created_at_epoch_ms`).

### 4. Cross-encoder logits violate normalization contract — OBSERVATION

- **Location:** `src/retrieval/transcript-routing.ts:312`
- **Code:** `const maxScore = Math.max(...data.scores, 0.001);`
- **Issue:** Cross-encoders (like BGE) often output raw logits, which can be entirely negative. If all scores are negative, `maxScore` floors at `0.001`. Dividing moderate negative logits by `0.001` results in massive negative values (e.g., `-5000` or worse). While `sort` will still technically order them correctly, this directly violates the `0..1` normalized score contract documented on line 64 and could cause downstream threshold filters to fail unexpectedly.

### 5. Unbounded sequential network latency — OBSERVATION

- **Location:** `src/retrieval/transcript-routing.ts:191`
- **Code:** `for (const artifact of artifacts)`
- **Issue:** While iterating sequentially correctly prevents saturating Ollama, there is no upper bound check on `artifacts.length`. Routing 20 artifacts with a 3,000ms timeout per call introduces a theoretical ceiling of 60+ seconds of blocking I/O on a bad network path.

---

## Overall grade: B-

**Rationale:** The structural implementation of the fallback logic, budget signaling, and testing bounds are well executed and match architectural requirements. However, failing the non-throwing contract in two highly-probable edge cases drops the grade. Fixing the critical exceptions on lines 153 and 338 will easily elevate this to an A.
