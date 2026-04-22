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
// LLM topic-segmenter
// ---------------------------------------------------------------------------

const SEGMENT_SYSTEM_PROMPT = `You are segmenting a conversation into topic-coherent chunks.

Rules:
- Each segment covers a contiguous range of turns [start, end] inclusive.
- Segments must cover all turns with no gaps or overlaps.
- Each segment gets a short topic_label (<= 60 chars).
- Aim for 3-20 turns per segment; absolute maximum 30.
- If the whole conversation is one topic, return one segment.

Output STRICT JSON matching:
{ "segments": [ { "start": N, "end": M, "topic_label": "..." } ] }`;

/**
 * Extract a JSON object from an LLM response using balanced-brace matching.
 * Tolerant of leading/trailing prose. Mirrors directive-detector's helper.
 */
function extractFirstJsonObject(raw: string): unknown | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(raw.substring(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parse a raw LLM response into a validated Segment[]. Returns null if:
 *   - response is unparseable JSON
 *   - `segments` is missing or empty or not an array
 *   - any element is shape-wrong (non-integer start/end, end<start, missing label)
 *   - coverage is incomplete (first/last turn mismatch) or has gaps/overlaps
 *
 * Shape validation here is strict. Bounds enforcement (soft-min merge,
 * hard-max split) is caller's responsibility (task 04-02-03).
 */
export function parseSegmentationResponse(
  raw: string,
  turnNumbers: number[],
): Segment[] | null {
  if (turnNumbers.length === 0) return null;
  const obj = extractFirstJsonObject(raw) as Record<string, unknown> | null;
  if (!obj) return null;
  const rawSegs = obj.segments;
  if (!Array.isArray(rawSegs) || rawSegs.length === 0) return null;

  const segs: Segment[] = [];
  for (const s of rawSegs) {
    if (!s || typeof s !== 'object') return null;
    const rec = s as Record<string, unknown>;
    const start = rec.start;
    const end = rec.end;
    const label = rec.topic_label;
    if (typeof start !== 'number' || !Number.isInteger(start)) return null;
    if (typeof end !== 'number' || !Number.isInteger(end)) return null;
    if (end < start) return null;
    if (typeof label !== 'string' || label.length === 0) return null;
    segs.push({ start, end, topic_label: label });
  }

  const firstTurn = turnNumbers[0];
  const lastTurn = turnNumbers[turnNumbers.length - 1];
  if (segs[0].start !== firstTurn) return null;
  if (segs[segs.length - 1].end !== lastTurn) return null;

  for (let i = 1; i < segs.length; i++) {
    if (segs[i].start !== segs[i - 1].end + 1) return null;
  }

  return segs;
}

/**
 * Ask the local LLM to segment a transcript into topic-coherent chunks.
 * Returns null on shape-invalid output; throws on transport errors so the
 * caller can distinguish transient failure (counted as `errors`) from
 * deterministic rejection.
 */
async function segmentViaLLM(turns: ConvTurn[]): Promise<Segment[] | null> {
  const preview = turns.map(t => ({
    n: t.turn_number,
    u: (t.user_text ?? '').slice(0, 200),
    a: (t.assistant_text ?? '').slice(0, 200),
  }));
  const userPrompt = `Turns:\n${JSON.stringify(preview)}`;

  const raw = await callLocalLLM({
    system: SEGMENT_SYSTEM_PROMPT,
    prompt: userPrompt,
    temperature: 0.2,
    maxTokens: 1024,
  });

  const turnNumbers = turns.map(t => t.turn_number);
  return parseSegmentationResponse(raw, turnNumbers);
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
