/**
 * Transcript chunker — Phase 4 (P3) Plan 04-02.
 *
 * Consumes a completed session's `conversation_turns` and writes one or more
 * `artifact(kind='transcript_chunk', ...)` rows. Producer half of CONTEXT's
 * Recent Threads source.
 *
 * Pipeline:
 *   1. Load turns for the session ordered by `turn_number ASC`.
 *   2. Idempotency guard: if any `transcript_chunk` artifact already exists
 *      for this session, return `skipped:'already_chunked'`.
 *   3. For ≥3 turns, ask `callLocalLLM` for topic-coherent segments (strict
 *      JSON). Validate shape (full coverage, no gaps/overlaps).
 *   4. Enforce soft bounds [3,20] / hard cap 30 on LLM output.
 *   5. Insert one artifact per final segment. `embedding_ref` left null —
 *      Phase 6b `backfillEmbeddings` picks these up.
 *
 * Fallbacks (loud failure, clean fallback — CONTEXT §Handoff source):
 *   - <3 turns                     → single chunk, no LLM call.
 *   - LLM throws / times out       → single chunk, `errors:1`.
 *   - LLM response unparseable /
 *     shape-invalid (gaps etc.)    → single chunk, `errors:0` (deterministic).
 *   - Coverage invariant fails
 *     after merge+split (defensive)→ single chunk.
 *
 * Non-throwing at the top level — unexpected errors are logged and reflected
 * in `errors`. Embeddings are explicitly deferred to Phase 6b's backfill
 * path; no synchronous embed inside `/endsession`.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { callLocalLLM } from './llama-client.js';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChunkResult {
  inserted: number;
  skipped: 'already_chunked' | 'empty_session' | null;
  errors: number;
}

interface ConvTurn {
  turn_number: number;
  user_text: string | null;
  assistant_text: string | null;
  timestamp_epoch: number;
}

interface Segment {
  start: number;
  end: number;
  topic_label: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Chunk a completed session's transcript into topic-coherent artifact rows.
 *
 * Idempotent per session — a second call for the same `sessionId` returns
 * `skipped:'already_chunked'` without writes. Re-chunking requires explicit
 * action (out of scope here).
 *
 * Non-throwing at the top level. Callers (heartbeat, /endsession hook) treat
 * the returned `errors` count as diagnostic, not blocking.
 */
export async function chunkSessionTranscript(
  db: Database,
  sessionId: string,
  project: string,
): Promise<ChunkResult> {
  try {
    const turns = cachedPrepare(
      db,
      `SELECT turn_number, user_text, assistant_text, timestamp_epoch
         FROM conversation_turns
        WHERE session_id = ?
        ORDER BY turn_number ASC`,
    ).all(sessionId) as ConvTurn[];

    if (turns.length === 0) {
      return { inserted: 0, skipped: 'empty_session', errors: 0 };
    }

    const existing = cachedPrepare(
      db,
      `SELECT 1 FROM artifact WHERE kind = 'transcript_chunk' AND session_id = ? LIMIT 1`,
    ).get(sessionId);
    if (existing) {
      return { inserted: 0, skipped: 'already_chunked', errors: 0 };
    }

    // Segmentation + write path — filled in by later tasks.
    return { inserted: 0, skipped: null, errors: 0 };
  } catch (err) {
    console.error('[transcript-chunker] unexpected error:', err);
    return { inserted: 0, skipped: null, errors: 1 };
  }
}
