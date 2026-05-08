import type { Database } from 'better-sqlite3';
import type { Probe } from './probe-schema.js';
import type { ArmRunResult } from './types.js';
import { invokeAgent, type RunArmOpts } from './arm-summary.js';

export const DEFAULT_TOP_K = 5;

const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embed';
const RERANKER_URL = 'http://127.0.0.1:7439/rerank';
const FETCH_TIMEOUT_MS = 3_000;

interface TranscriptSpan {
  rowid: number;
  session_id: string;
  turn_index: number;
  body: string;
  score: number;
}

export interface RunTranscriptArmOpts extends RunArmOpts {
  topK?: number;
  /** P8 reranker-fitness verdict at run time. PASS → use cross-encoder; FAIL → bi-encoder fallback. */
  useBiEncoderOnly?: boolean;
  rerankerFetcher?: typeof fetch;
  embeddingFetcher?: typeof fetch;
}

interface VecRow {
  rowid: number;
  session_id: string;
  turn_index: number;
  body: string;
  distance: number;
}

async function embedQuery(
  query: string,
  fetcher: typeof fetch,
): Promise<number[] | null> {
  try {
    const res = await fetcher(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'snowflake-arctic-embed2', input: [query.substring(0, 500)] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length === 0) return null;
    return data.embeddings[0];
  } catch {
    return null;
  }
}

function knnTranscriptChunks(
  db: Database,
  embedding: number[],
  candidatePool: number,
): VecRow[] {
  try {
    const stmt = db.prepare(`
      SELECT t.rowid AS rowid,
             t.session_id AS session_id,
             t.turn_index AS turn_index,
             t.body AS body,
             v.distance AS distance
      FROM vec_transcript_chunks_v6 v
      JOIN transcript_chunk_v6 t ON t.rowid = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
      ORDER BY v.distance
      LIMIT ?
    `);
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    return stmt.all(buf, candidatePool, candidatePool) as VecRow[];
  } catch {
    return [];
  }
}

async function retrieveTopKSpans(
  db: Database,
  query: string,
  topK: number,
  opts: RunTranscriptArmOpts,
): Promise<{ spans: TranscriptSpan[]; retrieval_path: 'cross_encoder' | 'bi_encoder_fallback' | 'none' }> {
  const embeddingFetcher = opts.embeddingFetcher ?? fetch;
  const rerankerFetcher = opts.rerankerFetcher ?? fetch;

  const embedding = await embedQuery(query, embeddingFetcher);
  if (!embedding) return { spans: [], retrieval_path: 'none' };

  const candidates = knnTranscriptChunks(db, embedding, Math.max(20, topK * 4));
  if (candidates.length === 0) return { spans: [], retrieval_path: 'none' };

  // Initial vec-rank score: lower distance = better. Convert to a [0..1] score.
  const maxDist = Math.max(...candidates.map((c) => c.distance), 0.001);
  const vecScored = candidates.map((c) => ({
    rowid: c.rowid,
    session_id: c.session_id,
    turn_index: c.turn_index,
    body: c.body,
    score: 1 - c.distance / maxDist,
  }));

  if (opts.useBiEncoderOnly) {
    return {
      spans: vecScored.slice(0, topK),
      retrieval_path: 'bi_encoder_fallback',
    };
  }

  // Try cross-encoder rerank — same fetch shape as src/core/hybrid-retrieval.ts
  try {
    const documents = vecScored.map((c) => c.body.substring(0, 300));
    const ceResponse = await rerankerFetcher(RERANKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.substring(0, 500), documents }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!ceResponse.ok) {
      return { spans: vecScored.slice(0, topK), retrieval_path: 'bi_encoder_fallback' };
    }
    const ceData = (await ceResponse.json()) as { scores?: number[]; indices?: number[] };
    if (!ceData.scores || ceData.scores.length === 0 || !ceData.indices) {
      return { spans: vecScored.slice(0, topK), retrieval_path: 'bi_encoder_fallback' };
    }
    const scoreMap = new Map<number, number>();
    for (let i = 0; i < ceData.indices.length; i++) {
      scoreMap.set(ceData.indices[i], ceData.scores[i]);
    }
    const maxCE = Math.max(...ceData.scores, 0.001);
    const reranked = vecScored
      .map((c, i) => ({
        ...c,
        score: c.score * 0.6 + ((scoreMap.get(i) ?? 0) / maxCE) * 0.4,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { spans: reranked, retrieval_path: 'cross_encoder' };
  } catch {
    return { spans: vecScored.slice(0, topK), retrieval_path: 'bi_encoder_fallback' };
  }
}

/**
 * B-arm: queries vec_transcript_chunks_v6 via the same retrieval primitives
 * as production hybrid-retrieval.ts and injects top-K spans into the prompt
 * as labeled citations.
 */
export async function runTranscriptArm(
  db: Database,
  probe: Probe,
  opts: RunTranscriptArmOpts = {},
): Promise<ArmRunResult> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const { spans, retrieval_path } = await retrieveTopKSpans(db, probe.prompt, topK, opts);

  const renderedSpans = spans
    .map((s) => `[from session_id=${s.session_id}, turn_index=${s.turn_index}]\n${s.body.slice(0, 800)}`)
    .join('\n\n');

  const fullPrompt =
    `You are answering a question with the following verbatim transcript spans retrieved from a memory store:\n\n` +
    `${renderedSpans}\n\n---\n\nQuestion: ${probe.prompt}\n\n` +
    `Answer in 2-4 paragraphs. Cite specific session_ids and turn_indexes when referencing prior conversations.`;

  try {
    const inv = await invokeAgent(fullPrompt, opts);
    return {
      arm: 'transcript',
      probe_id: probe.id,
      agent_model: opts.agentModel ?? 'deepseek-coder-v2:16b',
      agent_response: inv.response,
      injected_context_summary: {
        artifact_count: 0,
        transcript_span_count: spans.length,
        retrieval_path,
      },
      latency_ms: inv.latency_ms,
    };
  } catch (err) {
    return {
      arm: 'transcript',
      probe_id: probe.id,
      agent_model: opts.agentModel ?? 'deepseek-coder-v2:16b',
      agent_response: '',
      injected_context_summary: { artifact_count: 0, transcript_span_count: spans.length, retrieval_path },
      latency_ms: 0,
      error: `agent invocation failed: ${String(err)}`,
    };
  }
}
