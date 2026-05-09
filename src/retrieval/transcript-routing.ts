/**
 * v6 transcript-routing surface (Phase 10 — ROU-01..03).
 *
 * Artifact → transcript-chunk fan-out. Given an artifact reference (CONTEXT.md
 * decision, SUMMARY.md outcome, learning, experience pattern, mental model,
 * directive rule, critical rule), join `transcript_chunk_v6` on `session_id`
 * + a configurable time window from `artifact.created_at_epoch_ms` and rank
 * the candidate chunks.
 *
 * Bi-encoder primary per 10-CONTEXT.md decision 1: P9 binding measurement
 * was conducted under `bi_encoder_fallback` baseline; cross-encoder fitness
 * re-check landed at 56.0% < 60% threshold on the conversation-distribution
 * corpus post-backfill. Cross-encoder remains code-reachable behind the
 * `v6.routing.reranker_mode='cross_encoder_primary'` flag for a future
 * re-bind on a grown / different-distribution corpus.
 *
 * Routing is artifact-kind-agnostic per 10-CONTEXT.md decision 2: ranking
 * depends only on join keys (session_id + time window) and the bi-encoder /
 * cross-encoder score. Per-kind weighting has zero measurement support and
 * would require runtime artifact classification — explicitly out of scope.
 *
 * Non-throwing across every external dependency: sqlite-vec absent, Ollama
 * unreachable, reranker unreachable → degrade to a smaller result set.
 * `bi_encoder_only=true` on the result is the signal Plan 10-02 reads to
 * apply the reduced `bi_encoder_budget_pct × token_pct_cap` budget instead
 * of the full `token_pct_cap`.
 *
 * Reranker fallback discipline matches `hybrid-retrieval.ts` (RETR-08):
 * one telemetry row per fallback event with the captured reason
 * (`unreachable` / `non_2xx` / `timeout` / `empty_response`).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { loadConfig } from '../shared/config.js';
import {
  incrementRerankerFallbackCounter,
  type RerankerFallbackReason,
} from '../core/telemetry-counters.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RoutingArtifact {
  /** Artifact's source session — join key for transcript_chunk_v6 */
  session_id: string;
  /** When the artifact was created — anchor for the time-window join */
  created_at_epoch_ms: number;
  /** Optional artifact-side context for ranking; falls back to first candidate body */
  query_text?: string;
}

export interface RoutingSpan {
  /** transcript_chunk_v6.id */
  chunk_id: number;
  session_id: string;
  turn_index: number;
  sub_index: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  body: string;
  created_at_epoch_ms: number;
  /** 0..1 — bi-encoder cosine OR cross-encoder normalized score */
  rank_score: number;
  /** Which ranker produced rank_score */
  ranker: 'bi_encoder' | 'cross_encoder';
}

export interface RoutingResult {
  /** Spans returned, ranked descending by rank_score, capped at top_k_per_artifact */
  spans: RoutingSpan[];
  /** True if the bi-encoder path produced these spans (Plan 10-02 reads this) */
  bi_encoder_only: boolean;
  /** Number of candidate chunks before ranking — observability */
  candidate_count: number;
}

export interface RoutingOptions {
  /** Time window from artifact.created_at_epoch_ms; default ±2h */
  window_ms_before?: number;
  window_ms_after?: number;
  /** Override top_k_per_artifact for this call (falls back to config) */
  top_k?: number;
  /** Session id passed to telemetry on reranker fallback */
  caller_session_id?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h
const CANDIDATE_LIMIT = 20; // SQL fetch upper bound before ranking
const MAX_BODY_CHARS = 500; // mirror hybrid-retrieval reranker payload trim
const QUERY_CHARS = 500;
const RANKER_TIMEOUT_MS = 3000;

// POLISH-01 — Gemini Routing Finding #3: pick the 20 *temporally closest*
// candidates inside the ±window, not the 20 earliest by turn_index. The SELECT
// below binds artifact.created_at_epoch_ms as the 4th param so the ORDER BY
// expresses absolute time-distance from the artifact's creation timestamp.
// Downstream callers that rely on turn-index iteration ergonomics get a
// post-fetch in-JS re-sort by (turn_index, sub_index) before ranking.
const CANDIDATE_SQL = `
  SELECT id, session_id, turn_index, sub_index, role, body, created_at_epoch_ms
  FROM transcript_chunk_v6
  WHERE session_id = ?
    AND created_at_epoch_ms BETWEEN ? AND ?
  ORDER BY ABS(created_at_epoch_ms - ?) ASC
  LIMIT ${CANDIDATE_LIMIT}
`;

interface CandidateRow {
  id: number;
  session_id: string;
  turn_index: number;
  sub_index: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  body: string;
  created_at_epoch_ms: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Single artifact → ranked transcript spans. Non-throwing.
 */
export async function routeFromArtifact(
  db: Database,
  artifact: RoutingArtifact,
  opts: RoutingOptions = {},
): Promise<RoutingResult> {
  const cfg = loadConfig().v6.routing;
  const topK = opts.top_k ?? cfg.top_k_per_artifact;
  const windowBefore = opts.window_ms_before ?? DEFAULT_WINDOW_MS;
  const windowAfter = opts.window_ms_after ?? DEFAULT_WINDOW_MS;
  const lo = artifact.created_at_epoch_ms - windowBefore;
  const hi = artifact.created_at_epoch_ms + windowAfter;

  // 1. Candidate fetch — straight SELECT, sqlite-vec absent is irrelevant here
  //    because we do not use vec0 for routing; ranking happens via the network.
  let rows: CandidateRow[] = [];
  try {
    rows = cachedPrepare(db, CANDIDATE_SQL).all(
      artifact.session_id, lo, hi, artifact.created_at_epoch_ms,
    ) as CandidateRow[];
  } catch {
    // transcript_chunk_v6 absent on a pre-V32 DB — degrade silently to empty
    return { spans: [], bi_encoder_only: true, candidate_count: 0 };
  }

  if (rows.length === 0) {
    return { spans: [], bi_encoder_only: true, candidate_count: 0 };
  }

  // SQL fetched the 20 temporally closest; re-sort in JS by (turn_index, sub_index)
  // so any downstream caller that iterates expecting turn order keeps its ergonomics.
  rows.sort((a, b) =>
    a.turn_index !== b.turn_index
      ? a.turn_index - b.turn_index
      : a.sub_index - b.sub_index,
  );

  // 2. Build query text for ranking — caller-provided wins; else fall back to
  //    the first candidate's body (still useful as a topic anchor). Three-stage
  //    coalesce defends against NULL body rows (Gemini Routing Finding #1) — an
  //    empty-string fallback yields a degraded zero-similarity ranking, which
  //    preserves the non-throwing contract from Plan 10-01.
  const queryText = (artifact.query_text ?? rows[0]?.body ?? '').substring(0, QUERY_CHARS);

  // 3. Branch on reranker_mode. Both branches return RoutingSpan[] sorted desc.
  let spans: RoutingSpan[];
  let biEncoderOnly: boolean;

  if (cfg.reranker_mode === 'cross_encoder_primary') {
    const ce = await rankWithCrossEncoder(
      queryText, rows, db, opts.caller_session_id ?? 'unknown-session',
    );
    spans = ce.spans;
    biEncoderOnly = ce.bi_encoder_only;
  } else {
    spans = await rankWithBiEncoder(queryText, rows);
    biEncoderOnly = true;
  }

  spans.sort((a, b) => b.rank_score - a.rank_score);

  return {
    spans: spans.slice(0, topK),
    bi_encoder_only: biEncoderOnly,
    candidate_count: rows.length,
  };
}

/**
 * Multi-artifact fan-out with `max_k_per_query` budget enforcement.
 * Sequential per-artifact calls (mirrors hybrid-retrieval discipline — these
 * are I/O-bound network calls, parallel would saturate Ollama). Non-throwing.
 */
export async function routeFromArtifacts(
  db: Database,
  artifacts: RoutingArtifact[],
  opts: RoutingOptions = {},
): Promise<RoutingResult> {
  if (!artifacts || artifacts.length === 0) {
    return { spans: [], bi_encoder_only: true, candidate_count: 0 };
  }

  const cfg = loadConfig().v6.routing;
  const allSpans: RoutingSpan[] = [];
  let candidateTotal = 0;
  let anyBiOnly = false;

  for (const artifact of artifacts) {
    try {
      const r = await routeFromArtifact(db, artifact, opts);
      candidateTotal += r.candidate_count;
      if (r.bi_encoder_only) anyBiOnly = true;
      allSpans.push(...r.spans);
    } catch {
      // Routing per-artifact is already non-throwing; defensive guard for
      // truly unexpected errors so a single artifact never sinks the batch.
    }
  }

  // Deduplicate by chunk_id; keep highest rank_score on collision.
  const byId = new Map<number, RoutingSpan>();
  for (const s of allSpans) {
    const existing = byId.get(s.chunk_id);
    if (!existing || s.rank_score > existing.rank_score) {
      byId.set(s.chunk_id, s);
    }
  }
  const deduped = Array.from(byId.values());
  deduped.sort((a, b) => b.rank_score - a.rank_score);

  return {
    spans: deduped.slice(0, cfg.max_k_per_query),
    bi_encoder_only: anyBiOnly,
    candidate_count: candidateTotal,
  };
}

// ---------------------------------------------------------------------------
// Internal ranker helpers (private — not exported)
// ---------------------------------------------------------------------------

/**
 * Bi-encoder cosine ranking via Ollama snowflake-arctic-embed2. On any
 * failure (Ollama unreachable, non-200, timeout, malformed response):
 * return the candidates with rank_score=0 so the caller still sees the
 * spans — degraded but non-throwing per CONTEXT decision 1.
 */
async function rankWithBiEncoder(
  query: string,
  candidates: CandidateRow[],
): Promise<RoutingSpan[]> {
  const fallback = (): RoutingSpan[] =>
    candidates.map((c) => ({
      chunk_id: c.id,
      session_id: c.session_id,
      turn_index: c.turn_index,
      sub_index: c.sub_index,
      role: c.role,
      body: c.body,
      created_at_epoch_ms: c.created_at_epoch_ms,
      rank_score: 0,
      ranker: 'bi_encoder' as const,
    }));

  try {
    const texts = [query, ...candidates.map((c) => (c.body ?? '').substring(0, MAX_BODY_CHARS))];
    const response = await fetch('http://localhost:11434/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'snowflake-arctic-embed2', input: texts }),
      signal: AbortSignal.timeout(RANKER_TIMEOUT_MS),
    });
    if (!response.ok) return fallback();
    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) return fallback();

    const queryEmb = data.embeddings[0];
    const queryNorm = Math.sqrt(queryEmb.reduce((s, v) => s + v * v, 0)) || 1;

    return candidates.map((c, i) => {
      const docEmb = data.embeddings![i + 1];
      const docNorm = Math.sqrt(docEmb.reduce((s, v) => s + v * v, 0)) || 1;
      let dot = 0;
      for (let d = 0; d < queryEmb.length; d++) dot += queryEmb[d] * docEmb[d];
      const cosine = dot / (queryNorm * docNorm);
      return {
        chunk_id: c.id,
        session_id: c.session_id,
        turn_index: c.turn_index,
        sub_index: c.sub_index,
        role: c.role,
        body: c.body,
        created_at_epoch_ms: c.created_at_epoch_ms,
        rank_score: cosine,
        ranker: 'bi_encoder' as const,
      };
    });
  } catch {
    return fallback();
  }
}

/**
 * Cross-encoder ranking via the BGE-reranker-v2-m3 service on port 7439.
 * On failure: capture the reason, write one telemetry row, fall through
 * to the bi-encoder path. Mirrors `hybrid-retrieval.ts` reranker
 * discipline exactly (RETR-08).
 */
async function rankWithCrossEncoder(
  query: string,
  candidates: CandidateRow[],
  db: Database,
  callerSessionId: string,
): Promise<{ spans: RoutingSpan[]; bi_encoder_only: boolean }> {
  let ceFailureReason: RerankerFallbackReason | null = null;
  const documents = candidates.map((c) => (c.body ?? '').substring(0, MAX_BODY_CHARS));

  try {
    const response = await fetch('http://127.0.0.1:7439/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.substring(0, QUERY_CHARS), documents }),
      signal: AbortSignal.timeout(RANKER_TIMEOUT_MS),
    });
    if (!response.ok) {
      ceFailureReason = 'non_2xx';
    } else {
      const data = (await response.json()) as { scores?: number[]; indices?: number[] };
      if (!data.scores || data.scores.length === 0 || !data.indices) {
        ceFailureReason = 'empty_response';
      } else {
        const maxScore = Math.max(...data.scores, 0.001);
        const scoreByIdx = new Map<number, number>();
        for (let i = 0; i < data.indices.length; i++) {
          scoreByIdx.set(data.indices[i], data.scores[i] / maxScore);
        }
        const spans: RoutingSpan[] = candidates.map((c, i) => ({
          chunk_id: c.id,
          session_id: c.session_id,
          turn_index: c.turn_index,
          sub_index: c.sub_index,
          role: c.role,
          body: c.body,
          created_at_epoch_ms: c.created_at_epoch_ms,
          rank_score: scoreByIdx.get(i) ?? 0,
          ranker: 'cross_encoder' as const,
        }));
        return { spans, bi_encoder_only: false };
      }
    }
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    ceFailureReason =
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
  }

  // Cross-encoder failed — record telemetry, fall through to bi-encoder.
  // Gemini Routing Finding #2: telemetry-write exception must NOT escape and
  // bypass the bi-encoder fallback. Isolate the counter increment in its own
  // try/catch so a DB-locked / missing-table telemetry error never sinks the
  // user-facing routing call.
  if (ceFailureReason !== null) {
    try {
      incrementRerankerFallbackCounter(db, callerSessionId, ceFailureReason);
    } catch (telemetryErr) {
      if (process.env.CLAUDEX_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error('[transcript-routing] telemetry write failed:', telemetryErr);
      }
    }
  }
  const spans = await rankWithBiEncoder(query, candidates);
  return { spans, bi_encoder_only: true };
}
