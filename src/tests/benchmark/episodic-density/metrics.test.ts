/**
 * Phase 2 Plan 04 — quality metrics tests.
 */

import { describe, it, expect } from 'vitest';
import {
  evalQuery,
  aggregate,
  deltaCI,
  type PerQueryEval,
} from '../../../benchmark/episodic-density/metrics.js';
import type { RetrievalHit } from '../../../benchmark/episodic-density/retrieval.js';

function hits(...ids: number[]): RetrievalHit[] {
  return ids.map((id, i) => ({ episode_event_id: id, score: 1 / (i + 1), rank: i + 1 }));
}

describe('evalQuery', () => {
  it('precision@5 on a hand-checked tiny corpus: 2 of top-5 are positives -> 0.4', () => {
    const ev = evalQuery(
      1,
      'C_fused',
      [10, 20, 30, 40], // positives
      hits(10, 99, 20, 88, 77, 30), // top-3 positives at ranks 1, 3, 6
      'phase1_organic_pre_phase2_close',
      1.5,
    );
    expect(ev.precision_at_5).toBeCloseTo(2 / 5, 6); // ranks 1 & 3 -> 2 positives in top-5
    expect(ev.recall_at_10).toBeCloseTo(3 / 4, 6); // 3 of 4 positives in top-10
    expect(ev.reciprocal_rank).toBeCloseTo(1 / 1, 6);
  });

  it('reciprocal_rank=0 when no positive appears in top-k', () => {
    const ev = evalQuery(
      1,
      'A_semantic',
      [50, 60],
      hits(1, 2, 3, 4, 5),
      'phase1_organic_pre_phase2_close',
      1.0,
    );
    expect(ev.reciprocal_rank).toBe(0);
  });

  it('recall@10 with no positives returns 0 (avoids divide-by-zero)', () => {
    const ev = evalQuery(1, 'A_semantic', [], hits(1, 2, 3), 'phase1_organic_pre_phase2_close', 1.0);
    expect(ev.recall_at_10).toBe(0);
  });
});

describe('aggregate', () => {
  function mkPerQuery(): PerQueryEval[] {
    // 4 queries for variant A — 2 succeed at p@5, 3 succeed at r@10
    const out: PerQueryEval[] = [];
    for (let i = 0; i < 4; i++) {
      out.push({
        query_event_id: i,
        variant: 'A_semantic',
        positives: [100 + i],
        hits: i < 2 ? hits(100 + i) : i < 3 ? hits(99, 98, 97, 96, 95, 100 + i) : hits(99, 98),
        precision_at_5: i < 2 ? 0.2 : 0,
        recall_at_10: i < 3 ? 1 : 0,
        reciprocal_rank: i < 2 ? 1 : i < 3 ? 1 / 6 : 0,
        origin_bucket: 'phase1_organic_pre_phase2_close',
        latency_ms: 1.0 + i,
      });
    }
    return out;
  }

  it('precision_at_5 success count = number of queries with any positive in top-5', () => {
    const agg = aggregate(mkPerQuery(), 'A_semantic', 'pooled');
    // 2 of 4 queries have positives in top-5 -> p=0.5
    expect(agg.n).toBe(4);
    expect(agg.precision_at_5.point).toBeCloseTo(0.5, 6);
    expect(agg.recall_at_10.point).toBeCloseTo(0.75, 6);
  });

  it('latency percentiles computed correctly on small input', () => {
    const agg = aggregate(mkPerQuery(), 'A_semantic', 'pooled');
    expect(agg.latency_ms.p50).toBeGreaterThan(0);
    expect(agg.latency_ms.p99).toBeGreaterThanOrEqual(agg.latency_ms.p95);
    expect(agg.latency_ms.p95).toBeGreaterThanOrEqual(agg.latency_ms.p50);
  });

  it('origin_split filters queries by their bucket', () => {
    const queries = mkPerQuery();
    queries[0].origin_bucket = 'v4_backfill';
    const aggOrganic = aggregate(queries, 'A_semantic', 'phase1_organic_pre_phase2_close');
    const aggV4 = aggregate(queries, 'A_semantic', 'v4_backfill');
    const aggPooled = aggregate(queries, 'A_semantic', 'pooled');
    expect(aggOrganic.n + aggV4.n).toBe(aggPooled.n);
    expect(aggV4.n).toBe(1);
    expect(aggOrganic.n).toBe(3);
  });

  it('aggregate with n=0 returns wilsonCI for n=0 (no NaN)', () => {
    const agg = aggregate([], 'A_semantic', 'pooled');
    expect(agg.n).toBe(0);
    expect(agg.precision_at_5.point).toBe(0);
    expect(agg.recall_at_10.point).toBe(0);
  });
});

describe('deltaCI', () => {
  it('throws when baseline is not A_semantic', () => {
    const A: ReturnType<typeof aggregate> = aggregate([], 'B_fingerprint', 'pooled');
    const B: ReturnType<typeof aggregate> = aggregate([], 'C_fused', 'pooled');
    expect(() => deltaCI(A, B)).toThrow();
  });

  it('throws when variant is A_semantic', () => {
    const A: ReturnType<typeof aggregate> = aggregate([], 'A_semantic', 'pooled');
    expect(() => deltaCI(A, A)).toThrow();
  });
});
