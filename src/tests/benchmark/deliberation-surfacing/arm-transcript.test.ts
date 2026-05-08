import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runTranscriptArm } from '../../../benchmark/deliberation-surfacing/arm-transcript.js';
import type { Probe } from '../../../benchmark/deliberation-surfacing/probe-schema.js';

const FAKE_PROBE: Probe = {
  id: 'drift-a-01',
  kind: 'a',
  source: 'real',
  prompt: 'Should we still treat the n=20 KILL verdict as binding?',
  past_artifact_ref: ['multi-handle.json'],
  transcript_anchor: { session_id: 'fake', turn_index_range: [0, 0], description: 'fake source' },
  condition_shift: { past_state: 'past', current_state: 'now', delta: 'changed' },
  pass_criterion: 'Agent must surface the corpus growth before re-applying.',
};

function buildTestDb(seedRowCount = 20): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE transcript_chunk_v6 (
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      sub_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      provenance TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at_epoch_ms INTEGER NOT NULL,
      wrapper_redacted INTEGER NOT NULL,
      UNIQUE(session_id, turn_index, role, sub_index)
    );
    CREATE VIRTUAL TABLE vec_transcript_chunks_v6 USING vec0(embedding float[1024]);
  `);

  if (seedRowCount > 0) {
    const insertChunk = db.prepare(`
      INSERT INTO transcript_chunk_v6
      (session_id, project_id, turn_index, sub_index, role, provenance, body, created_at_epoch_ms, wrapper_redacted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const insertVec = db.prepare(`INSERT INTO vec_transcript_chunks_v6(rowid, embedding) VALUES (?, ?)`);
    for (let i = 0; i < seedRowCount; i++) {
      const info = insertChunk.run(`session-${i}`, 'p9', i, 0, 'assistant', 'organic', `body chunk ${i}`, 1700000000 + i);
      const arr = new Float32Array(1024);
      for (let j = 0; j < 1024; j++) arr[j] = (i + j) % 7 / 10;
      insertVec.run(BigInt(info.lastInsertRowid as number | bigint), Buffer.from(arr.buffer));
    }
  }
  return db;
}

const mockEmbedFetcher = vi.fn(async () =>
  new Response(
    JSON.stringify({ embeddings: [new Array(1024).fill(0.01)] }),
    { status: 200 },
  ),
);

const mockAgentFetcher = vi.fn(async () =>
  new Response(JSON.stringify({ message: { content: 'AGENT_RESPONSE_B' } }), { status: 200 }),
);

describe('runTranscriptArm', () => {
  it('returns transcript spans + cross_encoder retrieval path with mocked fetchers', async () => {
    const db = buildTestDb(20);
    try {
      const rerankerFetcher = vi.fn(async () =>
        new Response(
          JSON.stringify({ scores: Array(20).fill(0).map((_, i) => 1 - i / 20), indices: Array(20).fill(0).map((_, i) => i) }),
          { status: 200 },
        ),
      );
      const out = await runTranscriptArm(db, FAKE_PROBE, {
        fetcher: mockAgentFetcher as unknown as typeof fetch,
        embeddingFetcher: mockEmbedFetcher as unknown as typeof fetch,
        rerankerFetcher: rerankerFetcher as unknown as typeof fetch,
        topK: 5,
      });
      expect(out.arm).toBe('transcript');
      expect(out.injected_context_summary.transcript_span_count).toBeGreaterThan(0);
      expect(out.injected_context_summary.retrieval_path).toBe('cross_encoder');
      expect(out.agent_response).toBe('AGENT_RESPONSE_B');
    } finally {
      db.close();
    }
  });

  it('falls back to bi_encoder_fallback when cross-encoder returns 503', async () => {
    const db = buildTestDb(20);
    try {
      const rerankerFetcher = vi.fn(async () => new Response('down', { status: 503 }));
      const out = await runTranscriptArm(db, FAKE_PROBE, {
        fetcher: mockAgentFetcher as unknown as typeof fetch,
        embeddingFetcher: mockEmbedFetcher as unknown as typeof fetch,
        rerankerFetcher: rerankerFetcher as unknown as typeof fetch,
        topK: 5,
      });
      expect(out.injected_context_summary.retrieval_path).toBe('bi_encoder_fallback');
      expect(out.injected_context_summary.transcript_span_count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('useBiEncoderOnly skips cross-encoder fetcher entirely', async () => {
    const db = buildTestDb(20);
    try {
      const rerankerFetcher = vi.fn();
      const out = await runTranscriptArm(db, FAKE_PROBE, {
        fetcher: mockAgentFetcher as unknown as typeof fetch,
        embeddingFetcher: mockEmbedFetcher as unknown as typeof fetch,
        rerankerFetcher: rerankerFetcher as unknown as typeof fetch,
        topK: 5,
        useBiEncoderOnly: true,
      });
      expect(out.injected_context_summary.retrieval_path).toBe('bi_encoder_fallback');
      expect(rerankerFetcher).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('returns retrieval_path=none with empty spans when no transcript chunks exist', async () => {
    const db = buildTestDb(0);
    try {
      const out = await runTranscriptArm(db, FAKE_PROBE, {
        fetcher: mockAgentFetcher as unknown as typeof fetch,
        embeddingFetcher: mockEmbedFetcher as unknown as typeof fetch,
        topK: 5,
      });
      expect(out.injected_context_summary.transcript_span_count).toBe(0);
      expect(out.injected_context_summary.retrieval_path).toBe('none');
    } finally {
      db.close();
    }
  });
});
