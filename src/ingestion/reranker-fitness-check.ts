/**
 * Phase 8 reranker fitness check (CONTEXT decision 4).
 *
 * Samples 50 transcript chunks at random; for each: derive a synthetic
 * query (first sentence of the chunk body), score the cross-encoder
 * (BGE-reranker-v2-m3 on port 7439) top-3 vs the bi-encoder
 * (snowflake-arctic-embed2 cosine) top-3 over a 20-chunk candidate pool,
 * compute overlap. Mean top-3 overlap is reported; the locked 60%
 * threshold is INFORMATIONAL — failure does NOT block ship; it sets P9's
 * reranker default.
 *
 * Writes one telemetry row of event_kind='reranker_fitness_check_completed'
 * with the summary on the success path. Reachability failure (3s timeout
 * on the cross-encoder service) returns gracefully with no telemetry.
 */

import type { Database } from 'better-sqlite3';
import { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { cachedPrepare } from '../core/stmt-cache.js';

const RERANKER_URL = 'http://127.0.0.1:7439/rerank';
export const RERANKER_TIMEOUT_MS = 3000;
export const PASS_THRESHOLD = 0.60;

export interface FitnessReportPerQuery {
  query: string;
  cross_top3: number[];      // chunk ids
  bi_top3: number[];
  overlap: number;            // |intersection| / 3
}

export interface FitnessReport {
  sample_size: number;
  mean_top3_overlap: number;
  pass: boolean;
  reranker_url: string;
  reranker_reachable: boolean;
  per_query: FitnessReportPerQuery[];
}

interface ChunkRow {
  id: number;
  body: string;
}

function deriveQuery(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return trimmed;
  const sentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  return sentence.slice(0, 200);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface CrossEncoderClient {
  rerank(query: string, documents: string[]): Promise<number[] | null>;
}

const defaultCrossEncoderClient: CrossEncoderClient = {
  async rerank(query: string, documents: string[]): Promise<number[] | null> {
    try {
      const res = await fetch(RERANKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.substring(0, 500), documents }),
        signal: AbortSignal.timeout(RERANKER_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = await res.json() as { scores?: number[]; indices?: number[] };
      if (!data?.scores || !data?.indices) return null;
      const scores = new Array<number>(documents.length).fill(0);
      for (let i = 0; i < data.indices.length; i++) {
        scores[data.indices[i]] = data.scores[i] ?? 0;
      }
      return scores;
    } catch {
      return null;
    }
  },
};

export interface FitnessOptions {
  sampleSize?: number;
  candidatePoolSize?: number;
  crossEncoderClient?: CrossEncoderClient;
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Compute the fitness report. Non-throwing on the embedding/reranker side
 * (each individual failure is caught) but propagates DB errors so callers
 * surface real schema problems rather than silent zero-result reports.
 */
export async function computeRerankerFitness(
  db: Database,
  options: FitnessOptions = {},
): Promise<FitnessReport> {
  const sampleSize = options.sampleSize ?? 50;
  const poolSize = options.candidatePoolSize ?? 20;
  const reranker = options.crossEncoderClient ?? defaultCrossEncoderClient;
  const provider = options.embeddingProvider ?? new EmbeddingProvider();

  const total = (cachedPrepare(db,
    `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6`,
  ).get() as { cnt: number }).cnt;

  if (total === 0) {
    return {
      sample_size: 0,
      mean_top3_overlap: 0,
      pass: false,
      reranker_url: RERANKER_URL,
      reranker_reachable: false,
      per_query: [],
    };
  }

  const samples = cachedPrepare(db,
    `SELECT id, body FROM transcript_chunk_v6 ORDER BY RANDOM() LIMIT ?`,
  ).all(Math.min(sampleSize, total)) as ChunkRow[];

  // Probe reachability with one cheap call. If it returns null we mark the
  // report unreachable and skip the per-query work — cheaper than 50 calls
  // in a loop.
  const probeQuery = samples[0].body.slice(0, 80) || 'probe';
  const probeDocs = [samples[0].body, samples[Math.min(1, samples.length - 1)].body];
  const probeScores = await reranker.rerank(probeQuery, probeDocs);
  if (probeScores === null) {
    return {
      sample_size: samples.length,
      mean_top3_overlap: 0,
      pass: false,
      reranker_url: RERANKER_URL,
      reranker_reachable: false,
      per_query: [],
    };
  }

  const perQuery: FitnessReportPerQuery[] = [];
  let overlapSum = 0;

  for (const sample of samples) {
    try {
      const query = deriveQuery(sample.body);
      if (query.length === 0) continue;

      // Build candidate pool: source chunk + (poolSize - 1) random others.
      const otherCandidates = (cachedPrepare(db,
        `SELECT id, body FROM transcript_chunk_v6 WHERE id != ? ORDER BY RANDOM() LIMIT ?`,
      ).all(sample.id, poolSize - 1) as ChunkRow[]);
      const pool: ChunkRow[] = [sample, ...otherCandidates];

      // Cross-encoder scores
      const docs = pool.map(p => p.body.slice(0, 1000));
      const ceScores = await reranker.rerank(query, docs);
      if (ceScores === null) continue;
      const ceTop3 = pool
        .map((p, idx) => ({ id: p.id, score: ceScores[idx] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.id);

      // Bi-encoder cosine
      const queryEmb = await provider.embed(query);
      if (queryEmb === null) continue;
      const docEmbs: Array<number[] | null> = await Promise.all(
        pool.map(p => provider.embed(p.body.slice(0, 1000))),
      );
      const biScored = pool.map((p, idx) => {
        const emb = docEmbs[idx];
        return { id: p.id, score: emb ? cosine(queryEmb, emb) : 0 };
      });
      const biTop3 = biScored.sort((a, b) => b.score - a.score).slice(0, 3).map(x => x.id);

      const intersect = ceTop3.filter(id => biTop3.includes(id)).length;
      const overlap = intersect / 3;
      overlapSum += overlap;
      perQuery.push({ query, cross_top3: ceTop3, bi_top3: biTop3, overlap });
    } catch {
      // Per-query failure — skip silently, do not corrupt mean.
    }
  }

  const mean = perQuery.length > 0 ? overlapSum / perQuery.length : 0;
  const pass = mean >= PASS_THRESHOLD;

  // Telemetry on the success path.
  try {
    cachedPrepare(db,
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES ('reranker-fitness', 'reranker_fitness_check_completed', ?, 'phase-8-fitness')`,
    ).run(JSON.stringify({
      sample_size: perQuery.length,
      mean_top3_overlap: mean,
      pass,
      threshold: PASS_THRESHOLD,
    }));
  } catch {
    // CHECK enum may not admit yet — do not let telemetry mask the report.
  }

  return {
    sample_size: perQuery.length,
    mean_top3_overlap: mean,
    pass,
    reranker_url: RERANKER_URL,
    reranker_reachable: true,
    per_query: perQuery,
  };
}
