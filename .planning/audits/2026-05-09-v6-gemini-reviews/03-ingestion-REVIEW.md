# Gemini Review — v6 Ingestion Path

**Date:** 2026-05-09
**Reviewer:** Gemini (via gemini-cli)
**Scope:** `src/ingestion/ingest-session.ts` + `src/ingestion/upsert-chunk.ts` + `src/ingestion/transcript-chunker-v6.ts` + `src/tests/ingestion/ingest-session.test.ts`
**Overall grade:** **F**
**Trigger:** v6.0.0 pre-push consultation; review prompt explicitly framed as "find SIBLING bugs the wire test missed" given the three latent silent-fail bugs (vec0 BigInt, DELETE+INSERT, JSON predicate) discovered during P9 prep.

---

## Summary

The wire test missed multiple severe flaws, largely because the design enshrines silent failures and incorrectly handles idempotency and chunking limits.

---

## Findings

### 1. Silent DB Desync on Re-ingestion (Metadata vs Vectors) — CRITICAL

- **Files:** `src/ingestion/upsert-chunk.ts:30` (`ON CONFLICT... DO NOTHING`); `src/ingestion/ingest-session.ts:243-260`
- **Details:** `upsertChunk` uses `DO NOTHING`, meaning re-runs keep the *old* `body` text in `transcript_chunk_v6`. However, the loop continues and unconditionally generates a *new* vector from the *newly parsed* `chunk.body`, overwriting the `vec0` vector table. If redaction rules or parsing logic change, the text metadata and semantic vectors drift entirely out of sync.

### 2. Orphaned "Ghost" Chunks on Re-ingestion — CRITICAL

- **File:** `src/ingestion/ingest-session.ts:213` (Missing preamble DELETE)
- **Details:** If a session is re-ingested and the new parsing/redaction yields *fewer* chunks (e.g., `sub_index` 0 and 1 instead of 0, 1, and 2), there is no session-level cleanup prior to the loop. The old trailing sub-chunks are orphaned and remain permanently searchable in both tables as ghost data.

### 3. Ghost Vectors Left Behind for Emptied Chunks — CRITICAL

- **File:** `src/ingestion/ingest-session.ts:235-240`
- **Details:** If an updated redaction rule strips all content from a previously populated chunk, the `if (empty) continue;` check bypasses the `DELETE FROM vec_transcript_chunks_v6` statement. The old semantic vector remains in the DB indefinitely, pointing to a now-empty chunk and polluting top-K retrieval.

### 4. Missing File Returns Silent Success — CRITICAL

- **File:** `src/ingestion/ingest-session.ts:74-78`
- **Details:** If `enqueueSessionIngestion` fires with no `jsonlPath` (or the file is cleaned up before the background worker runs), `fs.readFileSync` throws. The catch block returns `turns: []`. `ingestSession` sees 0 turns, registers 0 errors, and silently returns a success state. A total pipeline failure is marked as complete. **The tests explicitly codify this bug** (`'non-existent JSONL path → 0 chunks'`).

### 5. Destructive Chunking Corrupts Code/Formatting — CRITICAL

- **Files:** `src/ingestion/transcript-chunker-v6.ts:57` & `75-83`
- **Details:** The chunker splits long blocks using `body.split(/(?<=[.!?])\s+/)`, which *consumes* the whitespace (including newlines and tabs). When sub-chunks are reassembled, they are blindly concatenated via `current.join(' ')`. For code snippets, JSON payloads, or stack traces, this permanently destroys all structural formatting and indentation.

### 6. Unbounded Chunks Cause Silent Embedding Drops — CRITICAL

- **Files:** `src/ingestion/transcript-chunker-v6.ts:86`; `src/ingestion/ingest-session.ts:243` & `270` (`catch { result.errors += 1; }`)
- **Details:** The chunker strictly requires `.!?` delimiters to split. If a turn contains a 5000-token block of code, it is emitted as a single massive chunk. When passed to `provider.embed()`, the provider will throw a context-limit error. The outer `try/catch` silently swallows this, skips the `vec0` insert, increments the counter, and continues. Huge blocks of critical code are left unsearchable.

### 7. Degraded Path is Completely Invisible — RECOMMENDED

- **File:** `src/ingestion/ingest-session.ts:245, 264, 270`
- **Details:** All fallback/degraded paths (embedding provider throwing, returning null, or SQLite `vec0` extension throwing) only increment `result.errors`. Because this worker runs out-of-band in a heartbeat, the operator receives no CLI warnings, telemetry, or logs indicating that vectors were dropped.

### 8. Unconditional Re-Embedding Wastes API Calls — RECOMMENDED

- **File:** `src/ingestion/ingest-session.ts:243`
- **Details:** Re-running an ingested session unconditionally re-embeds *every single chunk* without checking if the exact text/hash already exists in the vector DB. This makes idempotent retry tools extremely expensive.

### 9. Tool Inputs Silently Dropped — OBSERVATION

- **File:** `src/ingestion/ingest-session.ts:153-165` (`extractBody`)
- **Details:** If a turn contains standard tool payloads (e.g., `type: 'tool_use'`, `name`, `input`) without explicit `text` or `content` fields, `extractBody` returns `null`. This drops the tool execution context entirely from the transcript.

---

## Overall grade: F

This ingestion path acts as a silent black hole. It destroys structural formatting for code, routinely drifts out of sync with its own database on retries, pollutes the index with ghost vectors, and swallows catastrophic file-read or token-limit errors without raising alarms. **The fact that the test suite deliberately mocks and expects these silent failures points to a deeply flawed architectural approach to resilience.**

This is the v5.0.1 silent-fail pattern recurring at a deeper layer. The discipline that was supposed to close the lesson actually codified its recurrence.
