/**
 * Phase 2 IDX-02 — three retrieval variants for the A/B/C measurement.
 *
 *   Variant A — semantic-only baseline. The production retrieval path is
 *     `src/core/hybrid-retrieval.ts` (FTS5 + RRF over `artifacts`), but it
 *     scores ARTIFACTS, not the corpus's `IndexedEvent[]`. For Phase 2's
 *     measurement we need apples-to-apples retrieval over the same
 *     fingerprinted corpus, so A is implemented as an in-memory
 *     bag-of-words cosine over `raw_content`. This deliberately stays
 *     non-fingerprint so any lift in Variant C over A reflects the
 *     fingerprint signal, not implementation drift between paths.
 *     (CONTEXT.md item 3 spec uses A as a baseline, not as the production
 *     retrieval; honest baseline > realistic baseline for the measurement.)
 *
 *   Variant B — error-fingerprint-only. Sidecar lookup by shingle hash;
 *     score = (overlap shingle count) / (query shingle count).
 *
 *   Variant C — RRF-fused (k=60 constant). Run A and B, fuse by reciprocal
 *     rank: score(d) = Σ_v 1 / (60 + rank_v(d)).
 *
 * All three signatures share `RetrievalQuery` / `RetrievalResult`. Pure
 * compute over the in-memory `IndexedEvent[]` corpus + the V26 sidecar
 * table; no Ollama, no reranker, no hybrid-retrieval call.
 */

import type { Database } from 'better-sqlite3';
import type { ErrorFingerprint } from '../../core/error-fingerprint.js';
import type { IndexedEvent } from './types.js';

export const RRF_K = 60 as const;

export interface RetrievalQuery {
  /** Anchor event — find similar events to this one. */
  query_event_id: number;
  /** Raw error/trace string. */
  query_content: string;
  /** Pre-computed fingerprint (provided by harness from corpus). */
  query_fingerprint: ErrorFingerprint | null;
  /** Top-k to retrieve. */
  k: number;
}

export interface RetrievalHit {
  episode_event_id: number;
  score: number;
  rank: number;
}

export type Variant = 'A_semantic' | 'B_fingerprint' | 'C_fused';

export interface RetrievalResult {
  variant: Variant;
  hits: RetrievalHit[];
  latency_ms: number;
}

function nowMs(): number {
  return performance.now();
}

/* ------------------------------------------------------------------ */
/* Variant A — bag-of-words cosine over raw_content (no fingerprints)  */
/* ------------------------------------------------------------------ */

function tokenize(text: string): Map<string, number> {
  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (const v of a.values()) aMag += v * v;
  for (const v of b.values()) bMag += v * v;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (vb !== undefined) dot += va * vb;
  }
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

/** Variant A — semantic-only baseline (deliberately fingerprint-free). */
export function retrieveSemanticOnly(
  _db: Database,
  query: RetrievalQuery,
  corpus: IndexedEvent[],
): RetrievalResult {
  const start = nowMs();
  const queryTokens = tokenize(query.query_content);
  const scored: Array<{ id: number; score: number }> = [];
  for (const ev of corpus) {
    if (ev.episode_event_id === query.query_event_id) continue;
    const score = cosine(queryTokens, tokenize(ev.raw_content));
    if (score > 0) scored.push({ id: ev.episode_event_id, score });
  }
  scored.sort((x, y) => y.score - x.score);
  const top = scored.slice(0, query.k);
  return {
    variant: 'A_semantic',
    hits: top.map((s, i) => ({ episode_event_id: s.id, score: s.score, rank: i + 1 })),
    latency_ms: nowMs() - start,
  };
}

/* ------------------------------------------------------------------ */
/* Variant B — fingerprint sidecar lookup                              */
/* ------------------------------------------------------------------ */

const SIDECAR_LOOKUP = `
  SELECT episode_event_id, COUNT(DISTINCT shingle_hash) AS overlap_count
    FROM episodic_index_error_fingerprint
   WHERE shingle_hash IN (SELECT value FROM json_each(?))
     AND episode_event_id != ?
   GROUP BY episode_event_id
   ORDER BY overlap_count DESC
   LIMIT ?
`;

/** Variant B — error-fingerprint-only retrieval via the V26 sidecar. */
export function retrieveFingerprintOnly(
  db: Database,
  query: RetrievalQuery,
): RetrievalResult {
  const start = nowMs();
  const fp = query.query_fingerprint;
  if (!fp || fp.shingles.length === 0) {
    return {
      variant: 'B_fingerprint',
      hits: [],
      latency_ms: nowMs() - start,
    };
  }
  const queryShingleCount = Math.max(1, fp.shingles.length);
  const rows = db
    .prepare(SIDECAR_LOOKUP)
    .all(JSON.stringify(fp.shingles), query.query_event_id, query.k) as Array<{
      episode_event_id: number;
      overlap_count: number;
    }>;
  return {
    variant: 'B_fingerprint',
    hits: rows.map((r, i) => ({
      episode_event_id: r.episode_event_id,
      score: r.overlap_count / queryShingleCount,
      rank: i + 1,
    })),
    latency_ms: nowMs() - start,
  };
}

/* ------------------------------------------------------------------ */
/* Variant C — RRF-fused (k=60)                                        */
/* ------------------------------------------------------------------ */

/**
 * Variant C — RRF fusion of A and B. The fused latency is wall-clock for
 * the fused call (NOT a sum of A+B), reflecting realistic call cost.
 */
export function retrieveFused(
  db: Database,
  query: RetrievalQuery,
  corpus: IndexedEvent[],
): RetrievalResult {
  const start = nowMs();
  const a = retrieveSemanticOnly(db, query, corpus);
  const b = retrieveFingerprintOnly(db, query);
  const fused = new Map<number, number>();
  for (const hit of a.hits) {
    fused.set(hit.episode_event_id, (fused.get(hit.episode_event_id) ?? 0) + 1 / (RRF_K + hit.rank));
  }
  for (const hit of b.hits) {
    fused.set(hit.episode_event_id, (fused.get(hit.episode_event_id) ?? 0) + 1 / (RRF_K + hit.rank));
  }
  const sorted = Array.from(fused.entries())
    .sort((x, y) => y[1] - x[1])
    .slice(0, query.k);
  return {
    variant: 'C_fused',
    hits: sorted.map(([id, score], i) => ({ episode_event_id: id, score, rank: i + 1 })),
    latency_ms: nowMs() - start,
  };
}
