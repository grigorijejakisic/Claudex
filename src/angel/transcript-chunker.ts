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
// Bounds enforcement
// ---------------------------------------------------------------------------

const SOFT_MIN_TURNS = 3;
const HARD_MAX_TURNS = 30;

/**
 * Enforce post-LLM bounds on a validated, gap-free segment list:
 *
 *   1. Merge-up pass  — any segment shorter than soft-min (3 turns) that is
 *                       not the only segment is merged into its neighbor
 *                       (predecessor by default; first segment merges into
 *                       its successor and inherits the successor's label).
 *   2. Split-down pass — any segment longer than hard-max (30 turns) is
 *                        chopped into consecutive 30-turn spans; the first
 *                        span keeps the original label, continuations get
 *                        `<label> (cont.)`.
 *   3. Coverage invariant — first.start == firstTurn, last.end == lastTurn,
 *                           no gaps, no overlaps. If any fail after the
 *                           two passes (defensive only), fall back to a
 *                           single chunk covering the full range with the
 *                           supplied fallback label.
 *
 * `turnNumbers` is the full ordered list of turn IDs; the first and last
 * entries define the valid range.
 */
export function enforceBounds(
  segments: Segment[],
  turnNumbers: number[],
  fallbackLabel: string,
): Segment[] {
  if (turnNumbers.length === 0) return segments;
  const firstTurn = turnNumbers[0];
  const lastTurn = turnNumbers[turnNumbers.length - 1];

  if (segments.length === 0) {
    return [{ start: firstTurn, end: lastTurn, topic_label: fallbackLabel }];
  }

  // ── 1. Merge-up pass ──────────────────────────────────────────────
  let merged: Segment[] = segments.map(s => ({ ...s }));
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      const span = merged[i].end - merged[i].start + 1;
      if (span >= SOFT_MIN_TURNS) continue;
      if (merged.length === 1) break;
      if (i === 0) {
        // Merge first into successor; keep successor's label.
        merged[1] = {
          start: merged[0].start,
          end: merged[1].end,
          topic_label: merged[1].topic_label,
        };
        merged.splice(0, 1);
      } else {
        // Merge into predecessor; keep predecessor's label.
        merged[i - 1] = {
          start: merged[i - 1].start,
          end: merged[i].end,
          topic_label: merged[i - 1].topic_label,
        };
        merged.splice(i, 1);
      }
      changed = true;
      break; // restart scan — indices shifted
    }
  }

  // ── 2. Split-down pass ────────────────────────────────────────────
  const split: Segment[] = [];
  for (const seg of merged) {
    const span = seg.end - seg.start + 1;
    if (span <= HARD_MAX_TURNS) {
      split.push(seg);
      continue;
    }
    let s = seg.start;
    let firstSpan = true;
    while (s <= seg.end) {
      const e = Math.min(s + HARD_MAX_TURNS - 1, seg.end);
      split.push({
        start: s,
        end: e,
        topic_label: firstSpan ? seg.topic_label : `${seg.topic_label} (cont.)`,
      });
      s = e + 1;
      firstSpan = false;
    }
  }

  // ── 3. Coverage invariant ─────────────────────────────────────────
  const ok =
    split.length > 0 &&
    split[0].start === firstTurn &&
    split[split.length - 1].end === lastTurn &&
    split.every((seg, i) => i === 0 || seg.start === split[i - 1].end + 1);
  if (!ok) {
    return [{ start: firstTurn, end: lastTurn, topic_label: fallbackLabel }];
  }

  return split;
}

// ---------------------------------------------------------------------------
// Artifact insertion
// ---------------------------------------------------------------------------

/**
 * Insert one `artifact(kind='transcript_chunk')` row per segment.
 *
 * - `title` = segment.topic_label
 * - `body`  = joined full text of all turns in the segment
 *             (`user_text\nassistant_text` per turn; turns separated by `\n\n`).
 *             NOT truncated — full text is the source of truth for embeds.
 * - `created_at_epoch` = last in-segment turn's `timestamp_epoch`.
 * - `data` = `{turn_range:[start,end], topic_label}`.
 * - `embedding_ref` left null — Phase 6b's backfill picks these up.
 *
 * Returns the count inserted. No transaction — Angel is cooperative and a
 * partial write leaves readable artifacts, which is preferable to an
 * all-or-nothing abort on a benign mid-loop error.
 */
function insertChunks(
  db: Database,
  sessionId: string,
  project: string,
  turns: ConvTurn[],
  segments: Segment[],
): number {
  const byTurnNumber = new Map<number, ConvTurn>();
  for (const t of turns) byTurnNumber.set(t.turn_number, t);

  const stmt = db.prepare(
    `INSERT INTO artifact(
       id, kind, title, body, scope, status, confidence,
       created_at_epoch, updated_at_epoch, session_id, project_id, data
     ) VALUES (?, 'transcript_chunk', ?, ?, NULL, 'active', NULL, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  for (const seg of segments) {
    const segTurns: ConvTurn[] = [];
    for (let n = seg.start; n <= seg.end; n++) {
      const t = byTurnNumber.get(n);
      if (t) segTurns.push(t);
    }
    if (segTurns.length === 0) continue;

    const body = segTurns
      .map(t => [t.user_text, t.assistant_text].filter((s): s is string => !!s).join('\n'))
      .join('\n\n');
    const lastTs = segTurns[segTurns.length - 1].timestamp_epoch;
    const data = JSON.stringify({
      turn_range: [seg.start, seg.end],
      topic_label: seg.topic_label,
    });

    stmt.run(
      randomUUID(),
      seg.topic_label,
      body,
      lastTs,
      lastTs,
      sessionId,
      project,
      data,
    );
    inserted++;
  }
  return inserted;
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
