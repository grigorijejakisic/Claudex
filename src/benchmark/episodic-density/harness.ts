/**
 * Phase 2 IDX-01/02/04 — A/B/C measurement harness orchestrator.
 *
 * Decision rule (CONTEXT.md item 5; cited verbatim — non-negotiable):
 *
 *   ## 5. Decision rule — locked BEFORE measurement runs
 *
 *   Empirical-phase discipline: this rule is committed to CONTEXT.md and
 *   PLAN.md before the harness is built. **No moving goalposts after we
 *   see results.**
 *
 *   **GREEN-LIGHT Phase 3 — proceed with full multi-handle retrieval cutover:**
 *
 *   ALL three must hold on the **held-out test set**:
 *   1. RRF-fusion has measurable improvement over semantic-only — minimum
 *      **+5pp on either precision@5 OR recall@10**, AND the **Wilson 95%
 *      CI lower bound on the delta is ≥ 0** (i.e., the improvement is not
 *      statistically indistinguishable from zero at our sample size). The
 *      AND-CI-bound is the discipline that prevents green-lighting on
 *      noise — at n≈40-60 pairs, raw point-deltas of +5pp can be inside
 *      the CI of zero.
 *   2. Density at scale produces signal — ≥30% of high-similarity pairs
 *      (per #4) are intra-project recurrent.
 *   3. Latency p99 of fused retrieval < 2× semantic-only baseline. Cost
 *      discipline: a marginally-better signal that doubles tail latency
 *      is not worth shipping.
 *
 *   **SCOPE-DOWN to advisory — Phase 3 ships, but lighter than originally planned:**
 *   Improvement exists on specific subsets (e.g. only Python stack traces,
 *   only one project) but not broadly. Phase 3 ships an **advisory-only
 *   surface** ("you've hit a similar error before, see episode X") without
 *   aggressive RRF fusion in the production retrieval path. Phase 5
 *   density abstraction is de-scoped accordingly (advisory, not abstraction).
 *
 *   **KILL — pivot or stop:**
 *   No measurable improvement (criteria 1 fails on held-out CI bound) OR
 *   density is pure noise (criteria 2 fails). Phase 3 plan is rewritten
 *   or the multi-handle thesis is reconsidered at the milestone level.
 */

import type { Database } from 'better-sqlite3';
import { computeErrorFingerprint, type ErrorFingerprint } from '../../core/error-fingerprint.js';
import {
  retrieveSemanticOnly,
  retrieveFingerprintOnly,
  retrieveFused,
  type RetrievalQuery,
  type Variant,
} from './retrieval.js';
import {
  evalQuery,
  aggregate,
  deltaCI,
  type AggregateMetrics,
  type DeltaMetrics,
  type PerQueryEval,
} from './metrics.js';
import { labelPairs, splitTrainTest, type LabeledPair } from './pair-labeling.js';
import { computeDensitySignal, type DensitySignal } from './density.js';
import {
  FLOOR_FINGERPRINTED,
  FLOOR_PROJECTS,
  type CorpusOrigin,
  type IndexedEvent,
} from './types.js';

export interface PerSplitMetrics {
  A: AggregateMetrics;
  B: AggregateMetrics;
  C: AggregateMetrics;
}

export interface PerSplitDeltas {
  B_vs_A: DeltaMetrics;
  C_vs_A: DeltaMetrics;
}

export interface DecisionRuleInputs {
  held_out_test_n: number;
  fused_p5_minus_semantic_p5: { delta: number; ci_lower: number; ci_upper: number };
  fused_r10_minus_semantic_r10: { delta: number; ci_lower: number; ci_upper: number };
  intra_project_share: number;
  p99_fused_over_p99_semantic: number;
}

export interface HarnessRunResult {
  ts_epoch: number;
  corpus_size: {
    total: number;
    phase1_organic: number;
    v4_backfill: number;
    projects: string[];
  };
  pairs: { total: number; train: number; test: number; seed: number };
  metrics: {
    pooled: PerSplitMetrics;
    phase1_organic: PerSplitMetrics;
    v4_backfill: PerSplitMetrics;
  };
  deltas: {
    pooled: PerSplitDeltas;
    phase1_organic: PerSplitDeltas;
    v4_backfill: PerSplitDeltas;
  };
  density: DensitySignal;
  decision_rule_inputs: DecisionRuleInputs;
}

const CORPUS_LOAD_SQL = `
  SELECT id, project, ts_epoch, session_id, content, metadata_json
    FROM episodic_events
   WHERE metadata_json IS NOT NULL
     AND json_extract(metadata_json, '$.error_fingerprint') IS NOT NULL
   ORDER BY id ASC
`;

const SIDECAR_ORIGIN_LOOKUP = `
  SELECT episode_event_id, corpus_origin
    FROM episodic_index_error_fingerprint
`;

interface CorpusRow {
  id: number;
  project: string;
  ts_epoch: number;
  session_id: string;
  content: string;
  metadata_json: string;
}

function buildCorpus(db: Database): IndexedEvent[] {
  const originByEvent = new Map<number, CorpusOrigin>();
  for (const row of db.prepare(SIDECAR_ORIGIN_LOOKUP).all() as Array<{
    episode_event_id: number;
    corpus_origin: CorpusOrigin;
  }>) {
    originByEvent.set(row.episode_event_id, row.corpus_origin);
  }
  const rows = db.prepare(CORPUS_LOAD_SQL).all() as CorpusRow[];
  const out: IndexedEvent[] = [];
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.metadata_json);
    } catch {
      continue;
    }
    const fp = parsed.error_fingerprint as ErrorFingerprint | undefined;
    if (!fp || !Array.isArray(fp.shingles)) continue;
    const origin = originByEvent.get(row.id) ?? 'phase1_organic';
    out.push({
      episode_event_id: row.id,
      project: row.project,
      ts_epoch: row.ts_epoch,
      session_id: row.session_id,
      corpus_origin: origin,
      outer_exception: fp.outer_exception ?? null,
      shingles: fp.shingles,
      raw_content: row.content,
      source_table: 'episodic_events',
      source_row_id: row.id,
    });
  }
  return out;
}

function buildPositivesIndex(testPairs: LabeledPair[]): Map<number, number[]> {
  const positives = new Map<number, number[]>();
  function add(query: number, expected: number): void {
    const arr = positives.get(query) ?? [];
    arr.push(expected);
    positives.set(query, arr);
  }
  for (const pair of testPairs) {
    add(pair.a, pair.b);
    add(pair.b, pair.a);
  }
  return positives;
}

function originBucketFor(
  query: IndexedEvent,
  positives: number[],
  byId: Map<number, IndexedEvent>,
): CorpusOrigin | 'mixed' {
  const origins = new Set<CorpusOrigin>();
  origins.add(query.corpus_origin);
  for (const id of positives) {
    const ev = byId.get(id);
    if (ev) origins.add(ev.corpus_origin);
  }
  if (origins.size === 1) {
    const [only] = origins;
    return only;
  }
  return 'mixed';
}

/**
 * Top-level harness. Reads the V26 sidecar + episodic_events.metadata_json,
 * labels pairs, splits 80/20, runs A/B/C on the test set, aggregates with
 * Wilson + Newcombe CIs, and assembles `decision_rule_inputs` for Plan
 * 02-05's verdict module.
 *
 * Read-only against the corpus. Throws if the corpus is below the 50/3
 * floor — the runner in 02-05 catches and emits a `BLOCKED` verdict.
 */
export async function runHarness(
  db: Database,
  opts?: { seed?: number },
): Promise<HarnessRunResult> {
  const seed = opts?.seed ?? 42;
  const corpus = buildCorpus(db);
  const projectSet = new Set(corpus.map(e => e.project));
  if (corpus.length < FLOOR_FINGERPRINTED || projectSet.size < FLOOR_PROJECTS) {
    throw new Error(
      `corpus floor not met — ${corpus.length} fingerprinted events across ${projectSet.size} projects (need >= ${FLOOR_FINGERPRINTED} and >= ${FLOOR_PROJECTS}). Run backfill first.`,
    );
  }

  const allPairs = labelPairs(corpus);
  const split = splitTrainTest(allPairs, { seed, testFraction: 0.2 });

  const byId = new Map<number, IndexedEvent>();
  for (const ev of corpus) byId.set(ev.episode_event_id, ev);
  const positivesByQuery = buildPositivesIndex(split.test);

  const perQuery: PerQueryEval[] = [];
  for (const [queryId, positives] of positivesByQuery) {
    const queryEv = byId.get(queryId);
    if (!queryEv) continue;
    const queryFp = computeErrorFingerprint(queryEv.raw_content);
    const q: RetrievalQuery = {
      query_event_id: queryId,
      query_content: queryEv.raw_content,
      query_fingerprint: queryFp,
      k: 10,
    };
    const origin = originBucketFor(queryEv, positives, byId);

    const a = retrieveSemanticOnly(db, q, corpus);
    perQuery.push(evalQuery(queryId, 'A_semantic', positives, a.hits, origin, a.latency_ms));
    const b = retrieveFingerprintOnly(db, q);
    perQuery.push(evalQuery(queryId, 'B_fingerprint', positives, b.hits, origin, b.latency_ms));
    const c = retrieveFused(db, q, corpus);
    perQuery.push(evalQuery(queryId, 'C_fused', positives, c.hits, origin, c.latency_ms));
  }

  function aggregateAll(originSplit: 'pooled' | CorpusOrigin): PerSplitMetrics {
    return {
      A: aggregate(perQuery, 'A_semantic', originSplit),
      B: aggregate(perQuery, 'B_fingerprint', originSplit),
      C: aggregate(perQuery, 'C_fused', originSplit),
    };
  }
  const pooled = aggregateAll('pooled');
  const organic = aggregateAll('phase1_organic');
  const v4 = aggregateAll('v4_backfill');

  function computeDeltas(splitMetrics: PerSplitMetrics): PerSplitDeltas {
    return {
      B_vs_A: deltaCI(splitMetrics.A, splitMetrics.B),
      C_vs_A: deltaCI(splitMetrics.A, splitMetrics.C),
    };
  }

  const density = computeDensitySignal(corpus, { seed: 4242 });

  const cVsAPooled = deltaCI(pooled.A, pooled.C);
  const decision_rule_inputs: DecisionRuleInputs = {
    held_out_test_n: pooled.A.n,
    fused_p5_minus_semantic_p5: {
      delta: cVsAPooled.delta_precision_at_5.point,
      ci_lower: cVsAPooled.delta_precision_at_5.lower,
      ci_upper: cVsAPooled.delta_precision_at_5.upper,
    },
    fused_r10_minus_semantic_r10: {
      delta: cVsAPooled.delta_recall_at_10.point,
      ci_lower: cVsAPooled.delta_recall_at_10.lower,
      ci_upper: cVsAPooled.delta_recall_at_10.upper,
    },
    intra_project_share: density.intra_project_share,
    p99_fused_over_p99_semantic:
      pooled.A.latency_ms.p99 === 0
        ? 0
        : pooled.C.latency_ms.p99 / pooled.A.latency_ms.p99,
  };

  return {
    ts_epoch: Math.floor(Date.now() / 1000),
    corpus_size: {
      total: corpus.length,
      phase1_organic: corpus.filter(e => e.corpus_origin === 'phase1_organic').length,
      v4_backfill: corpus.filter(e => e.corpus_origin === 'v4_backfill').length,
      projects: Array.from(projectSet).sort(),
    },
    pairs: { total: allPairs.length, train: split.train.length, test: split.test.length, seed: split.seed },
    metrics: { pooled, phase1_organic: organic, v4_backfill: v4 },
    deltas: {
      pooled: computeDeltas(pooled),
      phase1_organic: computeDeltas(organic),
      v4_backfill: computeDeltas(v4),
    },
    density,
    decision_rule_inputs,
  };
}
