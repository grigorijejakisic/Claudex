/**
 * Tests for Phase 6.5 HYBRID cross-project equivalence.
 *
 * Stage 1 thresholds, Stage 2 cosine bands, and the orchestration that
 * gates Stage 2 invocation on Stage 1 pass. Embedder is dependency-injected
 * so tests can drive deterministic vector similarity outcomes.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  stageOneHandleOverlap,
  stageTwoCosine,
  isCrossProjectEquivalent,
  STAGE_1_THRESHOLD,
  STAGE_2_MATCH_THRESHOLD,
  STAGE_2_AMBIGUOUS_FLOOR,
  type HandleSet,
  type EquivalenceCandidate,
  type EmbedderFn,
} from '../../core/cross-project-equivalence.js';

function emptyHandles(over: Partial<HandleSet> = {}): HandleSet {
  return {
    tools_used: [],
    files_touched: [],
    user_framing_tokens: [],
    errors_encountered: [],
    ...over,
  };
}

function candidate(id: number, project: string, salience: string, h: Partial<HandleSet> = {}): EquivalenceCandidate {
  return { id, project, salience, ...emptyHandles(h) };
}

/**
 * Make an embedder that returns two unit vectors with a target cosine.
 * Using only 4 dimensions because cosine is dimension-independent.
 */
function makeEmbedderForCosine(target: number): EmbedderFn {
  return async () => {
    // Vector A = [1, 0, 0, 0]; Vector B = [target, sqrt(1 - target^2), 0, 0]
    const a = [1, 0, 0, 0];
    const sin = Math.sqrt(Math.max(0, 1 - target * target));
    const b = [target, sin, 0, 0];
    return [a, b];
  };
}

const FAILING_EMBEDDER: EmbedderFn = async () => null;

describe('stageOneHandleOverlap', () => {
  it('returns 0 for two empty handle sets', () => {
    expect(stageOneHandleOverlap(emptyHandles(), emptyHandles())).toBe(0);
  });

  it('counts shared tokens across all four dimensions', () => {
    const a = emptyHandles({
      tools_used: ['Read', 'Bash'],
      files_touched: ['src/scraper.ts'],
      user_framing_tokens: ['rate', 'limit'],
      errors_encountered: ['429'],
    });
    const b = emptyHandles({
      tools_used: ['Read', 'Bash'],     // 2 shared
      files_touched: ['src/scraper.ts'], // 2 shared (basename + parent dir)
      user_framing_tokens: ['rate'],     // 1 shared
      errors_encountered: ['429'],       // 1 shared
    });
    expect(stageOneHandleOverlap(a, b)).toBe(6);
  });

  it('basename-and-parent normalization: scraper.ts and scraper-v2.ts share via parent', () => {
    const a = emptyHandles({ files_touched: ['src/scraper.ts'] });
    const b = emptyHandles({ files_touched: ['src/scraper-v2.ts'] });
    // scraper.ts vs scraper-v2.ts: different basenames; but share the 'src' parent.
    expect(stageOneHandleOverlap(a, b)).toBe(1);
  });

  it('identical paths share via both basename and parent', () => {
    const a = emptyHandles({ files_touched: ['src/scraper.ts'] });
    const b = emptyHandles({ files_touched: ['src/scraper.ts'] });
    expect(stageOneHandleOverlap(a, b)).toBe(2);
  });

  it('case-insensitive token comparison', () => {
    const a = emptyHandles({ tools_used: ['Read', 'BASH'] });
    const b = emptyHandles({ tools_used: ['read', 'bash'] });
    expect(stageOneHandleOverlap(a, b)).toBe(2);
  });

  it('returns 0 when no dimension overlaps', () => {
    const a = emptyHandles({
      tools_used: ['Read'],
      files_touched: ['src/a.ts'],
      user_framing_tokens: ['alpha'],
      errors_encountered: ['err1'],
    });
    const b = emptyHandles({
      tools_used: ['Edit'],
      files_touched: ['lib/b.ts'],
      user_framing_tokens: ['beta'],
      errors_encountered: ['err2'],
    });
    expect(stageOneHandleOverlap(a, b)).toBe(0);
  });
});

describe('stageTwoCosine', () => {
  it('returns the cosine of two near-identical vectors', async () => {
    const cos = await stageTwoCosine('A', 'B', makeEmbedderForCosine(0.99));
    expect(cos).toBeCloseTo(0.99, 4);
  });

  it('returns null when the embedder fails', async () => {
    const cos = await stageTwoCosine('A', 'B', FAILING_EMBEDDER);
    expect(cos).toBeNull();
  });

  it('returns null when the embedder returns the wrong number of vectors', async () => {
    const cos = await stageTwoCosine('A', 'B', async () => [[1, 0]]);
    expect(cos).toBeNull();
  });

  it('returns null when vectors have mismatched dimensions', async () => {
    const cos = await stageTwoCosine('A', 'B', async () => [[1, 0], [1, 0, 0]]);
    expect(cos).toBeNull();
  });
});

describe('isCrossProjectEquivalent — orchestration', () => {
  it('Stage 1 fails (shared < 3) → no Stage 2 call, returns stage1-fail', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    let embedderCalled = false;
    const trackingEmbedder: EmbedderFn = async () => {
      embedderCalled = true;
      return null;
    };
    const a = candidate(1, 'projA', 'salience A', { tools_used: ['Read'] });
    const b = candidate(2, 'projB', 'salience B', { tools_used: ['Read'] });
    const result = await isCrossProjectEquivalent(a, b, db, 'sess', trackingEmbedder);
    expect(result.band).toBe('stage1-fail');
    expect(result.match).toBe(false);
    expect(result.stage1Shared).toBeLessThan(STAGE_1_THRESHOLD);
    expect(result.stage2Cosine).toBeNull();
    expect(embedderCalled).toBe(false);
    db.close();
  });

  it('Stage 1 passes + Stage 2 cosine ≥ 0.85 → match band', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const a = candidate(1, 'projA', 'salience A', {
      tools_used: ['Read', 'Bash'],
      files_touched: ['src/scraper.ts'],
      user_framing_tokens: ['rate', 'limit'],
    });
    const b = candidate(2, 'projB', 'salience B', {
      tools_used: ['Read', 'Bash'],
      files_touched: ['src/scraper.ts'],
      user_framing_tokens: ['rate'],
    });
    const result = await isCrossProjectEquivalent(a, b, db, 'sess', makeEmbedderForCosine(0.92));
    expect(result.band).toBe('match');
    expect(result.match).toBe(true);
    expect(result.stage1Shared).toBeGreaterThanOrEqual(STAGE_1_THRESHOLD);
    expect(result.stage2Cosine).toBeCloseTo(0.92, 4);
    db.close();
  });

  it('Stage 2 cosine in 0.70-0.85 band → ambiguous; logs telemetry; reject', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const a = candidate(1, 'projA', 'salience A', {
      tools_used: ['Read', 'Bash', 'Edit'],
    });
    const b = candidate(2, 'projB', 'salience B', {
      tools_used: ['Read', 'Bash', 'Edit'],
    });
    const result = await isCrossProjectEquivalent(a, b, db, 'sess-amb', makeEmbedderForCosine(0.78));
    expect(result.band).toBe('ambiguous');
    expect(result.match).toBe(false);
    expect(result.stage2Cosine).toBeCloseTo(0.78, 4);

    const row = db.prepare(
      `SELECT detail FROM telemetry WHERE session_id = 'sess-amb' AND event_kind = 'cross_project_ambiguous'`
    ).get() as { detail: string };
    expect(row).toBeDefined();
    const parsed = JSON.parse(row.detail);
    expect(parsed.a_id).toBe(1);
    expect(parsed.b_id).toBe(2);
    expect(parsed.cosine).toBeCloseTo(0.78, 4);
    expect(parsed.project_a).toBe('projA');
    expect(parsed.project_b).toBe('projB');
    db.close();
  });

  it('Stage 2 cosine < 0.70 → reject; no telemetry row', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const a = candidate(1, 'projA', 'salience A', { tools_used: ['Read', 'Bash', 'Edit'] });
    const b = candidate(2, 'projB', 'salience B', { tools_used: ['Read', 'Bash', 'Edit'] });
    const result = await isCrossProjectEquivalent(a, b, db, 'sess-rej', makeEmbedderForCosine(0.55));
    expect(result.band).toBe('reject');
    expect(result.match).toBe(false);
    expect(result.stage2Cosine).toBeCloseTo(0.55, 4);

    const ambig = db.prepare(
      `SELECT 1 AS one FROM telemetry WHERE session_id = 'sess-rej' AND event_kind = 'cross_project_ambiguous'`
    ).get();
    expect(ambig).toBeUndefined();
    db.close();
  });

  it('embedder failure → reject band; logs reranker_fallback telemetry', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const a = candidate(1, 'projA', 'salience A', { tools_used: ['Read', 'Bash', 'Edit'] });
    const b = candidate(2, 'projB', 'salience B', { tools_used: ['Read', 'Bash', 'Edit'] });
    const result = await isCrossProjectEquivalent(a, b, db, 'sess-emb-fail', FAILING_EMBEDDER);
    expect(result.band).toBe('reject');
    expect(result.match).toBe(false);
    expect(result.stage2Cosine).toBeNull();

    const fallback = db.prepare(
      `SELECT 1 AS one FROM telemetry WHERE session_id = 'sess-emb-fail' AND event_kind = 'reranker_fallback'`
    ).get();
    expect(fallback).toBeDefined();
    db.close();
  });

  it('boundary: cosine exactly 0.85 → match; exactly 0.70 → ambiguous', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const a = candidate(1, 'projA', 'a', { tools_used: ['Read', 'Bash', 'Edit'] });
    const b = candidate(2, 'projB', 'b', { tools_used: ['Read', 'Bash', 'Edit'] });

    const matchAt85 = await isCrossProjectEquivalent(a, b, db, 'sess-85', makeEmbedderForCosine(STAGE_2_MATCH_THRESHOLD));
    expect(matchAt85.band).toBe('match');

    const ambigAt70 = await isCrossProjectEquivalent(a, b, db, 'sess-70', makeEmbedderForCosine(STAGE_2_AMBIGUOUS_FLOOR));
    expect(ambigAt70.band).toBe('ambiguous');
    db.close();
  });
});

describe('isCrossProjectEquivalent — boundary cases', () => {
  it('Stage 1 boundary: shared exactly 3 still calls Stage 2', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    let calls = 0;
    const tracking: EmbedderFn = async () => {
      calls++;
      return [[1, 0], [1, 0]];
    };
    const a = candidate(1, 'projA', 'a', { tools_used: ['t1', 't2', 't3'] });
    const b = candidate(2, 'projB', 'b', { tools_used: ['t1', 't2', 't3'] });
    const result = await isCrossProjectEquivalent(a, b, db, 'sess', tracking);
    expect(result.stage1Shared).toBe(3);
    expect(calls).toBe(1);
    expect(result.band).toBe('match'); // cosine = 1.0
    db.close();
  });
});
