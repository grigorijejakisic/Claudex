/**
 * v6 transcript chunker — pure function, turn-boundary primary.
 *
 * Phase 8 substrate (TRX-02 chunking + TRX-04 redaction). One chunk per
 * user/assistant turn naturally; turns whose body exceeds SOFT_TOKEN_LIMIT
 * (1500 tokens via the standard ~0.75 tokens-per-word proxy) are split at
 * sentence boundaries to preserve reranker top-K precision.
 *
 * Wrapper redaction fires here exactly once per turn via parseWrappers
 * (Phase 1 single-source-of-truth) — wrapper-tagged spans
 * (<system-reminder>, <experience-data>, <file-content>, <command-message>,
 * etc.) are stripped from the chunk body before any embedding or DB write.
 * The Mem0-trap stays structurally closed at the new write surface.
 *
 * Pure: no DB, no I/O, no clock reads. created_at_epoch_ms carries through
 * from the input turn.
 */

import { parseWrappers } from '../extraction/wrapper-parser.js';

export interface JsonlTurn {
  session_id: string;
  project_id: string;
  turn_index: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  body: string;
  created_at_epoch_ms: number;
  provenance: 'organic' | 'injected' | 'tool_result' | 'environmental';
}

export interface ChunkV6 {
  session_id: string;
  project_id: string;
  turn_index: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  provenance: 'organic' | 'injected' | 'tool_result' | 'environmental';
  /** 0 for single-chunk turns; 0..N-1 for sentence-boundary sub-chunks of long turns. */
  sub_index: number;
  body: string;
  created_at_epoch_ms: number;
  wrapper_redacted: boolean;
}

export const SOFT_TOKEN_LIMIT = 1500;
const TOKENS_PER_WORD = 0.75;

/**
 * Word-count proxy for token estimation. Same shape used elsewhere in the
 * codebase for assembly token-budget arithmetic. Conservative enough for
 * chunking decisions (off by ≤30% on technical text).
 */
function approxTokenCount(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.split(/\s+/).filter(Boolean).length / TOKENS_PER_WORD);
}

// POLISH-03 — Gemini Ingestion Finding #6: hard char-cap to bound any
// single sub-chunk against the embedder's context window. Embedders used in
// production have a 512-token limit; ~4 chars/token gives 2048; we use 1900
// for a 5% safety margin matching the chunker-side bound in ingest-session.ts.
// Sentences that exceed this bound are force-split on a character boundary
// during the offset-tracking pass below — no sentence is ever silently dropped
// or silently truncated by the embedder.
const HARD_CHAR_CAP = 1900;

/**
 * POLISH-03 — Gemini Ingestion Finding #5: format-preserving sentence-boundary
 * walker. Returns half-open `[start, end)` byte-offset pairs into the original
 * body so the caller can `body.slice(start, end)` without losing whitespace,
 * indentation, or intra-sentence punctuation. Backtick fences (`/```) suppress
 * boundary detection so code blocks (`const x = 1.5;`) are not split mid-block
 * on the dot. This replaces `body.split(/(?<=[.!?])\s+/)` which destroyed
 * formatting and split inside fenced code.
 *
 * The walker emits boundaries; the caller decides packing. No allocation of
 * intermediate string arrays before slicing — the original `body` is the
 * authoritative source.
 */
function sentenceBoundaries(body: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let inTripleFence = false;
  let inSingleFence = false;
  let sentenceStart = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '`') {
      // Triple-backtick fence has priority over single
      if (body.slice(i, i + 3) === '```') {
        inTripleFence = !inTripleFence;
        i += 2;
        continue;
      }
      if (!inTripleFence) {
        inSingleFence = !inSingleFence;
        continue;
      }
    }
    if (inTripleFence || inSingleFence) continue;
    if ((ch === '.' || ch === '!' || ch === '?')
        && i + 1 < body.length
        && /\s/.test(body[i + 1])) {
      // Walk past trailing whitespace to start of next sentence.
      let j = i + 1;
      while (j < body.length && /\s/.test(body[j])) j++;
      out.push({ start: sentenceStart, end: j });
      sentenceStart = j;
    }
  }
  if (sentenceStart < body.length) {
    out.push({ start: sentenceStart, end: body.length });
  }
  return out;
}

/**
 * Split a long body into sentence-boundary sub-chunks of <= SOFT_TOKEN_LIMIT
 * tokens. Greedy packing on offset pairs (so slicing the original body
 * preserves whitespace and capitalization byte-for-byte). Sentences whose
 * own char-length exceeds HARD_CHAR_CAP are force-split on character
 * boundaries before packing — no sentence is silently truncated by the
 * embedder downstream (POLISH-03 / Gemini Ingestion Finding #6).
 */
function splitAtSentences(body: string): string[] {
  if (approxTokenCount(body) <= SOFT_TOKEN_LIMIT && body.length <= HARD_CHAR_CAP) {
    return [body];
  }

  // Step 1: offset-tracking sentence boundaries (format-preserving).
  const boundaries = sentenceBoundaries(body);
  // Step 2: force-split any boundary whose width exceeds HARD_CHAR_CAP.
  const safeBoundaries: Array<{ start: number; end: number }> = [];
  for (const b of boundaries) {
    const width = b.end - b.start;
    if (width <= HARD_CHAR_CAP) {
      safeBoundaries.push(b);
      continue;
    }
    // Force-split on char boundaries; a sub-window is at most HARD_CHAR_CAP chars.
    for (let pos = b.start; pos < b.end; pos += HARD_CHAR_CAP) {
      safeBoundaries.push({ start: pos, end: Math.min(pos + HARD_CHAR_CAP, b.end) });
    }
  }

  // Step 3: greedy-pack safe boundaries into sub-chunks of <= SOFT_TOKEN_LIMIT
  // tokens, sliced from the original body to preserve formatting.
  const subChunks: string[] = [];
  let currentStart = -1;
  let currentEnd = -1;
  let currentTokens = 0;
  for (const b of safeBoundaries) {
    const slice = body.slice(b.start, b.end);
    const sliceTokens = approxTokenCount(slice);
    if (currentStart === -1) {
      currentStart = b.start;
      currentEnd = b.end;
      currentTokens = sliceTokens;
      continue;
    }
    if (currentTokens + sliceTokens > SOFT_TOKEN_LIMIT) {
      subChunks.push(body.slice(currentStart, currentEnd));
      currentStart = b.start;
      currentEnd = b.end;
      currentTokens = sliceTokens;
    } else {
      currentEnd = b.end;
      currentTokens += sliceTokens;
    }
  }
  if (currentStart !== -1) subChunks.push(body.slice(currentStart, currentEnd));
  // Defensive: if splitting produced nothing (empty body), keep the original
  // body as a single chunk so the turn does not silently drop.
  return subChunks.length > 0 ? subChunks : [body];
}

/**
 * Pure-function chunker: turns → ChunkV6[]. parseWrappers fires exactly once
 * per turn; wrapper_redacted is set when at least one wrapper-tagged span
 * was stripped. Sub-chunk emission keeps (session_id, turn_index, role)
 * stable and uses ascending `sub_index` (0..N-1) to disambiguate via the
 * V32 UNIQUE(session_id, turn_index, role, sub_index) constraint.
 */
export function chunkTranscript(turns: JsonlTurn[]): ChunkV6[] {
  if (turns.length === 0) return [];
  const chunks: ChunkV6[] = [];
  for (const turn of turns) {
    const { organic, injected } = parseWrappers(turn.body);
    const wrapperRedacted = injected.length > 0;
    const subBodies = splitAtSentences(organic);
    for (let i = 0; i < subBodies.length; i++) {
      chunks.push({
        session_id: turn.session_id,
        project_id: turn.project_id,
        turn_index: turn.turn_index,
        role: turn.role,
        provenance: turn.provenance,
        sub_index: i,
        body: subBodies[i],
        created_at_epoch_ms: turn.created_at_epoch_ms,
        wrapper_redacted: wrapperRedacted,
      });
    }
  }
  return chunks;
}
