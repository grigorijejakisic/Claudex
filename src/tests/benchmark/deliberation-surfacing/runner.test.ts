import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as hybridRetrieval from '../../../core/hybrid-retrieval.js';
import {
  runBindingMeasurement,
  checkSubstrate,
} from '../../../benchmark/deliberation-surfacing/runner.js';
import { parseArgs } from '../../../cli/benchmark-deliberation-surfacing.js';

const ALL_PASS_JSON = JSON.stringify({
  prong_1: { verdict: 'PASS', justification: 'p' },
  prong_2: { verdict: 'PASS', justification: 'p' },
  prong_3: { verdict: 'PASS', justification: 'p' },
});

function buildLiveDb(seedRows = 10): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE transcript_chunk_v6 (
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
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
  if (seedRows > 0) {
    const insertChunk = db.prepare(`
      INSERT INTO transcript_chunk_v6 (session_id, project, turn_index, sub_index, role, provenance, body, created_at_epoch_ms, wrapper_redacted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const insertVec = db.prepare(`INSERT INTO vec_transcript_chunks_v6(rowid, embedding) VALUES (?, ?)`);
    for (let i = 0; i < seedRows; i++) {
      const info = insertChunk.run(`s-${i}`, 'p9', i, 0, 'assistant', 'organic', `body ${i}`, 1700000000 + i);
      const arr = new Float32Array(1024);
      for (let j = 0; j < 1024; j++) arr[j] = (i + j) % 7 / 10;
      insertVec.run(BigInt(info.lastInsertRowid as number | bigint), Buffer.from(arr.buffer));
    }
  }
  return db;
}

let tmpDir: string;
let probesDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-runner-'));
  probesDir = path.join(tmpDir, 'probes');
  fs.mkdirSync(probesDir, { recursive: true });
  // Copy the real probes into the tmp dir so loadProbes(probesDir) finds 30 fixtures.
  const realProbesDir = path.resolve(process.cwd(), '.planning', 'phases', '09-empirical-measurement', 'probes');
  for (const f of fs.readdirSync(realProbesDir)) {
    if (/^drift-[a-e]-(0[1-6])\.json$/.test(f)) {
      fs.copyFileSync(path.join(realProbesDir, f), path.join(probesDir, f));
    }
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('parses all supported flags', () => {
    const f = parseArgs(['--replications=3', '--label=foo', '--bi-encoder-only', '--top-k=8', '--dry-run', '--project=other']);
    expect(f.replications).toBe(3);
    expect(f.labelPrefix).toBe('foo');
    expect(f.biEncoderOnly).toBe(true);
    expect(f.topK).toBe(8);
    expect(f.dryRun).toBe(true);
    expect(f.project).toBe('other');
  });

  it('applies defaults when flags missing', () => {
    const f = parseArgs([]);
    expect(f.replications).toBe(2);
    expect(f.labelPrefix).toBe('r');
    expect(f.biEncoderOnly).toBe(false);
    expect(f.topK).toBe(5);
    expect(f.dryRun).toBe(false);
  });

  it('falls back to default 2 on malformed --replications', () => {
    const f = parseArgs(['--replications=abc']);
    expect(f.replications).toBe(2);
  });
});

describe('checkSubstrate', () => {
  it('throws with operator-actionable message when 0 rows', () => {
    const db = buildLiveDb(0);
    try {
      expect(() => checkSubstrate(db)).toThrow(/0 rows/);
    } finally {
      db.close();
    }
  });

  it('throws V32-migration message when transcript_chunk_v6 missing', () => {
    const db = new Database(':memory:');
    try {
      expect(() => checkSubstrate(db)).toThrow(/V32 migration/);
    } finally {
      db.close();
    }
  });

  it('returns chunk_count > 0 when seeded', () => {
    const db = buildLiveDb(5);
    try {
      const r = checkSubstrate(db);
      expect(r.chunk_count).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe('runBindingMeasurement', () => {
  it('runs N replications with mocked transports + writes aggregator + report when noAggregatorWrite=false', async () => {
    const db = buildLiveDb(20);
    const aggJson = path.join(tmpDir, 'agg.json');
    const aggMd = path.join(tmpDir, 'agg.md');
    try {
      vi.spyOn(hybridRetrieval, 'hybridSearchAsync').mockResolvedValue([]);
      const agentFetcher = vi.fn(async () => new Response(JSON.stringify({ message: { content: 'X' } }), { status: 200 }));
      const judgeFetcher = vi.fn(async () => new Response(JSON.stringify({ message: { content: ALL_PASS_JSON } }), { status: 200 }));
      const embeddingFetcher = vi.fn(async () => new Response(JSON.stringify({ embeddings: [new Array(1024).fill(0.01)] }), { status: 200 }));
      const rerankerFetcher = vi.fn(async () => new Response(JSON.stringify({ scores: Array(20).fill(0).map((_, i) => 1 - i / 20), indices: Array(20).fill(0).map((_, i) => i) }), { status: 200 }));

      const result = await runBindingMeasurement({
        db,
        replications: 2,
        labelPrefix: 'r',
        useBiEncoderOnly: false,
        probesDir,
        agentFetcher: agentFetcher as unknown as typeof fetch,
        judgeFetcher: judgeFetcher as unknown as typeof fetch,
        rerankerFetcher: rerankerFetcher as unknown as typeof fetch,
        embeddingFetcher: embeddingFetcher as unknown as typeof fetch,
        aggregatorOpts: { jsonPath: aggJson, mdPath: aggMd, isoDate: '2026-05-08' },
      });
      expect(result.replications).toHaveLength(2);
      expect(result.per_replication_verdicts).toHaveLength(2);
      expect(result.pooled.pooled_n).toBe(60);

      const agg = JSON.parse(fs.readFileSync(aggJson, 'utf-8'));
      // 2 per-replication entries + 1 pooled
      expect(agg.bound_experiences).toHaveLength(3);
      expect(result.reportPath).toBeDefined();
      expect(fs.existsSync(result.reportPath!)).toBe(true);
    } finally {
      db.close();
    }
  }, 30_000);

  it('respects noAggregatorWrite=true (no aggregator written, no report)', async () => {
    const db = buildLiveDb(20);
    const aggJson = path.join(tmpDir, 'agg2.json');
    try {
      vi.spyOn(hybridRetrieval, 'hybridSearchAsync').mockResolvedValue([]);
      const agentFetcher = vi.fn(async () => new Response(JSON.stringify({ message: { content: 'X' } }), { status: 200 }));
      const judgeFetcher = vi.fn(async () => new Response(JSON.stringify({ message: { content: ALL_PASS_JSON } }), { status: 200 }));
      const embeddingFetcher = vi.fn(async () => new Response(JSON.stringify({ embeddings: [new Array(1024).fill(0.01)] }), { status: 200 }));

      const result = await runBindingMeasurement({
        db,
        replications: 1,
        labelPrefix: 'r',
        useBiEncoderOnly: true,
        probesDir,
        noAggregatorWrite: true,
        agentFetcher: agentFetcher as unknown as typeof fetch,
        judgeFetcher: judgeFetcher as unknown as typeof fetch,
        embeddingFetcher: embeddingFetcher as unknown as typeof fetch,
        aggregatorOpts: { jsonPath: aggJson },
      });
      expect(result.replications).toHaveLength(1);
      expect(fs.existsSync(aggJson)).toBe(false);
      expect(result.reportPath).toBeUndefined();
    } finally {
      db.close();
    }
  }, 30_000);
});
