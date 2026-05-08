import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as hybridRetrieval from '../../../core/hybrid-retrieval.js';
import { runReplication } from '../../../benchmark/deliberation-surfacing/harness.js';
import type { Probe } from '../../../benchmark/deliberation-surfacing/probe-schema.js';

function makeProbe(id: string, kind: Probe['kind']): Probe {
  return {
    id,
    kind,
    source: 'real',
    prompt: `Should we still apply the past verdict for ${id}?`,
    past_artifact_ref: ['ref-1'],
    transcript_anchor: { session_id: `s-${id}`, turn_index_range: [0, 0], description: 'a fake source-moment for harness testing' },
    condition_shift: { past_state: 'past', current_state: 'now', delta: 'changed' },
    pass_criterion: 'Surface the divergence and recommend re-pooling explicitly.',
  };
}

function buildTestDb(): Database.Database {
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
  return db;
}

const ALL_PASS_JSON = JSON.stringify({
  prong_1: { verdict: 'PASS', justification: 'p' },
  prong_2: { verdict: 'PASS', justification: 'p' },
  prong_3: { verdict: 'PASS', justification: 'p' },
});

const ALL_FAIL_JSON = JSON.stringify({
  prong_1: { verdict: 'FAIL', justification: 'f' },
  prong_2: { verdict: 'FAIL', justification: 'f' },
  prong_3: { verdict: 'FAIL', justification: 'f' },
});

function judgeResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), { status: 200 });
}

function agentResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), { status: 200 });
}

const dummyEmbedding = new Array(1024).fill(0.01);
function embedFetcher() {
  return vi.fn(async () => new Response(JSON.stringify({ embeddings: [dummyEmbedding] }), { status: 200 }));
}

const PROBES_6: Probe[] = [
  makeProbe('drift-a-01', 'a'),
  makeProbe('drift-a-02', 'a'),
  makeProbe('drift-b-01', 'b'),
  makeProbe('drift-c-01', 'c'),
  makeProbe('drift-d-01', 'd'),
  makeProbe('drift-e-01', 'e'),
];

describe('runReplication', () => {
  it('orchestrates A-arm + B-arm + judge per probe with mocked transports', async () => {
    const db = buildTestDb();
    try {
      vi.spyOn(hybridRetrieval, 'hybridSearchAsync').mockResolvedValue([]);
      const agentFetcher = vi.fn(async () => agentResponse('agent says X'));
      const judgeFetcher = vi.fn(async () => judgeResponse(ALL_PASS_JSON));

      const result = await runReplication(db, PROBES_6, {
        replication_label: 'r1',
        agentFetcher: agentFetcher as unknown as typeof fetch,
        judgeFetcher: judgeFetcher as unknown as typeof fetch,
        embeddingFetcher: embedFetcher() as unknown as typeof fetch,
      });

      expect(result.outcomes).toHaveLength(6);
      expect(result.replication_label).toBe('r1');
      expect(result.summary_pass_count + result.transcript_pass_count).toBe(12);
      expect(result.retrieval_baseline).toBe('cross_encoder');
    } finally {
      db.close();
    }
  });

  it('records correct pass counts when judge says all-FAIL on summary, all-PASS on transcript', async () => {
    const db = buildTestDb();
    try {
      vi.spyOn(hybridRetrieval, 'hybridSearchAsync').mockResolvedValue([]);
      let judgeCallNum = 0;
      const agentFetcher = vi.fn(async () => agentResponse('agent says X'));
      const judgeFetcher = vi.fn(async () => {
        judgeCallNum++;
        // Order per probe: summary judge (odd), transcript judge (even).
        return judgeResponse(judgeCallNum % 2 === 1 ? ALL_FAIL_JSON : ALL_PASS_JSON);
      });

      const result = await runReplication(db, PROBES_6, {
        replication_label: 'r2',
        agentFetcher: agentFetcher as unknown as typeof fetch,
        judgeFetcher: judgeFetcher as unknown as typeof fetch,
        embeddingFetcher: embedFetcher() as unknown as typeof fetch,
      });

      expect(result.summary_pass_count).toBe(0);
      expect(result.transcript_pass_count).toBe(6);
    } finally {
      db.close();
    }
  });

  it('handles probe error gracefully (judge returns ERROR_JUDGE_VERDICT)', async () => {
    const db = buildTestDb();
    try {
      vi.spyOn(hybridRetrieval, 'hybridSearchAsync').mockResolvedValue([]);
      let agentCalls = 0;
      const agentFetcher = vi.fn(async () => {
        agentCalls++;
        if (agentCalls === 3) throw new Error('ollama dead on call 3');
        return agentResponse('agent says X');
      });
      const judgeFetcher = vi.fn(async () => judgeResponse(ALL_PASS_JSON));

      const result = await runReplication(db, PROBES_6, {
        replication_label: 'r3',
        agentFetcher: agentFetcher as unknown as typeof fetch,
        judgeFetcher: judgeFetcher as unknown as typeof fetch,
        embeddingFetcher: embedFetcher() as unknown as typeof fetch,
      });

      // One probe-arm errored — that arm's judge should be ERROR verdict.
      const erroredOutcome = result.outcomes.find(
        (o) => o.summary_arm.error || o.transcript_arm.error,
      );
      expect(erroredOutcome).toBeDefined();
      // The errored arm's judge has 'arm errored' in justifications.
      const erroredJudge = erroredOutcome!.summary_arm.error
        ? erroredOutcome!.summary_judge
        : erroredOutcome!.transcript_judge;
      expect(erroredJudge.prong_1.justification).toContain('arm errored');
    } finally {
      db.close();
    }
  });

  it('progress callbacks fire in order N times', async () => {
    const db = buildTestDb();
    try {
      vi.spyOn(hybridRetrieval, 'hybridSearchAsync').mockResolvedValue([]);
      const agentFetcher = vi.fn(async () => agentResponse('x'));
      const judgeFetcher = vi.fn(async () => judgeResponse(ALL_PASS_JSON));
      const onStart = vi.fn();
      const onComplete = vi.fn();

      await runReplication(db, PROBES_6, {
        replication_label: 'r4',
        agentFetcher: agentFetcher as unknown as typeof fetch,
        judgeFetcher: judgeFetcher as unknown as typeof fetch,
        embeddingFetcher: embedFetcher() as unknown as typeof fetch,
        onProbeStart: onStart,
        onProbeComplete: onComplete,
      });
      expect(onStart).toHaveBeenCalledTimes(6);
      expect(onComplete).toHaveBeenCalledTimes(6);
    } finally {
      db.close();
    }
  });

  it('useBiEncoderOnly produces retrieval_baseline=bi_encoder_fallback', async () => {
    const db = buildTestDb();
    try {
      vi.spyOn(hybridRetrieval, 'hybridSearchAsync').mockResolvedValue([]);
      const agentFetcher = vi.fn(async () => agentResponse('x'));
      const judgeFetcher = vi.fn(async () => judgeResponse(ALL_PASS_JSON));

      const result = await runReplication(db, PROBES_6, {
        replication_label: 'r5',
        useBiEncoderOnly: true,
        agentFetcher: agentFetcher as unknown as typeof fetch,
        judgeFetcher: judgeFetcher as unknown as typeof fetch,
        embeddingFetcher: embedFetcher() as unknown as typeof fetch,
      });
      expect(result.retrieval_baseline).toBe('bi_encoder_fallback');
    } finally {
      db.close();
    }
  });
});
