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

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/**
 * Split a long body into sentence-boundary sub-chunks of <= SOFT_TOKEN_LIMIT
 * tokens. Greedy packing: append sentences to the current sub-chunk until
 * adding another would exceed the limit; then start a new one. Sentences
 * that themselves exceed the limit stay intact (do NOT word-split — sentence
 * integrity matters for retrieval; this case is rare in practice).
 */
function splitAtSentences(body: string): string[] {
  if (approxTokenCount(body) <= SOFT_TOKEN_LIMIT) return [body];
  const sentences = body.split(SENTENCE_SPLIT).filter(s => s.length > 0);
  const subChunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const sentence of sentences) {
    const sentenceTokens = approxTokenCount(sentence);
    if (current.length > 0 && currentTokens + sentenceTokens > SOFT_TOKEN_LIMIT) {
      subChunks.push(current.join(' '));
      current = [sentence];
      currentTokens = sentenceTokens;
    } else {
      current.push(sentence);
      currentTokens += sentenceTokens;
    }
  }
  if (current.length > 0) subChunks.push(current.join(' '));
  // Defensive: if splitting produced nothing (one giant sentence), keep the
  // original body as a single chunk so the turn does not silently drop.
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
