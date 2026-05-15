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
import {
  labelPairs,
  labelPairsByTier,
  splitTrainTest,
  type LabeledPair,
} from './pair-labeling.js';
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

/**
 * Phase 2.1 widens the corpus_origin partition (CONTEXT.md decision 1c)
 * from two tiers to three. The HarnessRunResult shape gains explicit
 * `phase1_organic_pre_phase2_close` and `phase1_organic_post_phase2_close`
 * keys; Phase 2's already-published `02-results.json` uses the old
 * `phase1_organic` key as data on disk — that file is never re-rendered
 * and the aggregator reads it as untyped JSON, so the old key on disk
 * is intentional and append-only.
 */
export interface HarnessRunResult {
  ts_epoch: number;
  corpus_size: {
    total: number;
    v4_backfill: number;
    phase1_organic_pre_phase2_close: number;
    phase1_organic_post_phase2_close: number;
    projects: string[];
  };
  pairs: { total: number; train: number; test: number; seed: number };
  metrics: {
    pooled: PerSplitMetrics;
    v4_backfill: PerSplitMetrics;
    phase1_organic_pre_phase2_close: PerSplitMetrics;
    phase1_organic_post_phase2_close: PerSplitMetrics;
  };
  deltas: {
    pooled: PerSplitDeltas;
    v4_backfill: PerSplitDeltas;
    phase1_organic_pre_phase2_close: PerSplitDeltas;
    phase1_organic_post_phase2_close: PerSplitDeltas;
  };
  density: DensitySignal;
  decision_rule_inputs: DecisionRuleInputs;
}

const CORPUS_LOAD_SQL = `
  SELECT id, project, ts_epoch_ms AS ts_epoch, session_id, content, metadata_json
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

/**
 * Build the in-memory corpus from `episodic_events` + the V26/V27
 * sidecar. Exposed so non-harness consumers (Plan 02.1-03's audit, Plan
 * 02.1-04's runner-tiered.ts smoke output) can reuse the same loader
 * without duplicating the SQL.
 */
export function buildCorpus(db: Database): IndexedEvent[] {
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
    // Phase 2.1: every corpus event must carry a three-tier corpus_origin
    // from the sidecar (Plan 02.1-01 backfill). If a row has no sidecar
    // entry — which would mean a fingerprint exists in metadata_json but
    // the V26 sidecar wasn't written — skip the row rather than silently
    // mis-classify; the operator must re-run `cli backfill` to repopulate.
    const origin = originByEvent.get(row.id);
    if (!origin) continue;
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
 * Phase 2.1 — TieredHarnessResult shape (CONTEXT.md decision 2a + 4d).
 *
 * Two top-level keys: `strict_3frame` and `relaxed_2frame`. Each is a
 * full HarnessRunResult — own pair set, own metric tables, own
 * decision_rule_inputs. NO `combined`, `winning`, or `primary` key at
 * this level — the verdict module is called exactly twice (once per
 * tier) by Plan 02.1-04's runner; the schema test enforces this.
 */
export interface TieredHarnessResult {
  ts_epoch: number;
  strict_3frame: HarnessRunResult;
  relaxed_2frame: HarnessRunResult;
}

/**
 * Build a HarnessRunResult shaped like a normal one but populated with
 * zero-n Wilson sentinels everywhere. Used when a tier's labeled pair
 * set is empty (CONTEXT.md decision 6: corpus-too-sparse is the
 * primary outcome of that bound experience, not a problem to engineer
 * around). The downstream verdict runner translates
 * `decision_rule_inputs.held_out_test_n === 0` into BLOCKED for that
 * tier.
 */
function emptyTierResult(
  corpus: IndexedEvent[],
  projectSet: Set<string>,
  density: DensitySignal,
  seed: number,
): HarnessRunResult {
  const zeroVariant = (variant: PerQueryEval['variant']): AggregateMetrics => ({
    variant,
    origin_split: 'pooled',
    n: 0,
    precision_at_5: { point: 0, lower: 0, upper: 0, n: 0 },
    recall_at_10: { point: 0, lower: 0, upper: 0, n: 0 },
    mrr: { mean: 0, ci_lower: 0, ci_upper: 0, n: 0 },
    latency_ms: { p50: 0, p95: 0, p99: 0 },
  });
  const zeroSplit: PerSplitMetrics = {
    A: zeroVariant('A_semantic'),
    B: zeroVariant('B_fingerprint'),
    C: zeroVariant('C_fused'),
  };
  const zeroDelta = { point: 0, lower: 0, upper: 0, n: 0 };
  const zeroDeltas: PerSplitDeltas = {
    B_vs_A: { baseline: 'A_semantic', variant: 'B_fingerprint', origin_split: 'pooled', delta_precision_at_5: zeroDelta, delta_recall_at_10: zeroDelta },
    C_vs_A: { baseline: 'A_semantic', variant: 'C_fused', origin_split: 'pooled', delta_precision_at_5: zeroDelta, delta_recall_at_10: zeroDelta },
  };
  return {
    ts_epoch: Math.floor(Date.now() / 1000),
    corpus_size: {
      total: corpus.length,
      v4_backfill: corpus.filter(e => e.corpus_origin === 'v4_backfill').length,
      phase1_organic_pre_phase2_close: corpus.filter(
        e => e.corpus_origin === 'phase1_organic_pre_phase2_close',
      ).length,
      phase1_organic_post_phase2_close: corpus.filter(
        e => e.corpus_origin === 'phase1_organic_post_phase2_close',
      ).length,
      projects: Array.from(projectSet).sort(),
    },
    pairs: { total: 0, train: 0, test: 0, seed },
    metrics: {
      pooled: zeroSplit,
      v4_backfill: zeroSplit,
      phase1_organic_pre_phase2_close: zeroSplit,
      phase1_organic_post_phase2_close: zeroSplit,
    },
    deltas: {
      pooled: zeroDeltas,
      v4_backfill: zeroDeltas,
      phase1_organic_pre_phase2_close: zeroDeltas,
      phase1_organic_post_phase2_close: zeroDeltas,
    },
    density,
    decision_rule_inputs: {
      held_out_test_n: 0,
      fused_p5_minus_semantic_p5: { delta: 0, ci_lower: 0, ci_upper: 0 },
      fused_r10_minus_semantic_r10: { delta: 0, ci_lower: 0, ci_upper: 0 },
      intra_project_share: density.intra_project_share,
      p99_fused_over_p99_semantic: 0,
    },
  };
}

/**
 * Inner harness body — given a (corpus, allPairs, density) tuple, run
 * the A/B/C measurement pipeline and assemble a HarnessRunResult. Used
 * by both `runHarness` (single-tier strict, Phase 2 backwards-compat)
 * and `runHarnessTiered` (Phase 2.1 dual-tier).
 *
 * Pure given (corpus, allPairs, density). Reads from `db` for
 * retrieval variant evaluation. Does NOT enforce the corpus floor —
 * that's the caller's job.
 */
async function runHarnessForTier(
  db: Database,
  corpus: IndexedEvent[],
  projectSet: Set<string>,
  allPairs: LabeledPair[],
  density: DensitySignal,
  seed: number,
): Promise<HarnessRunResult> {
  // CONTEXT.md decision 6: empty pair set is a non-throwing sentinel —
  // verdict runner translates held_out_test_n=0 into BLOCKED.
  if (allPairs.length === 0) {
    return emptyTierResult(corpus, projectSet, density, seed);
  }

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
  const v4 = aggregateAll('v4_backfill');
  const organicPre = aggregateAll('phase1_organic_pre_phase2_close');
  const organicPost = aggregateAll('phase1_organic_post_phase2_close');

  function computeDeltas(splitMetrics: PerSplitMetrics): PerSplitDeltas {
    return {
      B_vs_A: deltaCI(splitMetrics.A, splitMetrics.B),
      C_vs_A: deltaCI(splitMetrics.A, splitMetrics.C),
    };
  }

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
      v4_backfill: corpus.filter(e => e.corpus_origin === 'v4_backfill').length,
      phase1_organic_pre_phase2_close: corpus.filter(
        e => e.corpus_origin === 'phase1_organic_pre_phase2_close',
      ).length,
      phase1_organic_post_phase2_close: corpus.filter(
        e => e.corpus_origin === 'phase1_organic_post_phase2_close',
      ).length,
      projects: Array.from(projectSet).sort(),
    },
    pairs: { total: allPairs.length, train: split.train.length, test: split.test.length, seed: split.seed },
    metrics: {
      pooled,
      v4_backfill: v4,
      phase1_organic_pre_phase2_close: organicPre,
      phase1_organic_post_phase2_close: organicPost,
    },
    deltas: {
      pooled: computeDeltas(pooled),
      v4_backfill: computeDeltas(v4),
      phase1_organic_pre_phase2_close: computeDeltas(organicPre),
      phase1_organic_post_phase2_close: computeDeltas(organicPost),
    },
    density,
    decision_rule_inputs,
  };
}

/**
 * Top-level harness. Reads the V26 sidecar + episodic_events.metadata_json,
 * labels pairs at the strict (≥3 frame) tier, splits 80/20, runs A/B/C
 * on the test set, aggregates with Wilson + Newcombe CIs, and assembles
 * `decision_rule_inputs` for the verdict module.
 *
 * Read-only against the corpus. Throws if the corpus is below the 50/3
 * floor — the runner catches and emits a `BLOCKED` verdict.
 *
 * Phase 2 backward-compat: this returns a SINGLE strict-tier result;
 * Phase 2.1's dual-tier path goes through `runHarnessTiered`.
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
  const density = computeDensitySignal(corpus, { seed: 4242 });
  return runHarnessForTier(db, corpus, projectSet, allPairs, density, seed);
}

/**
 * Phase 2.1 — dual-tier harness (CONTEXT.md decision 2a + 2c).
 *
 * Loads the corpus once, then runs the full A/B/C measurement pipeline
 * twice — once at the strict (≥3 frame) tier and once at the relaxed
 * (≥2 frame) tier — sharing the corpus snapshot AND the density signal
 * (corpus-wide, not pair-set-dependent) across tiers. Each tier
 * produces its own pair list, train/test split, per-query evals, and
 * decision_rule_inputs. The two HarnessRunResult objects are returned
 * under {strict_3frame, relaxed_2frame}.
 *
 * **CONTEXT.md decision 2c binding:** both tiers ALWAYS run, regardless
 * of strict's n. There is no early-exit branch.
 *
 * **CONTEXT.md decision 6 binding:** if a tier produces zero pairs
 * (e.g. relaxed labeling at a small corpus), `runHarnessForTier`
 * returns a zero-n sentinel HarnessRunResult — Plan 02.1-04's runner
 * sees `held_out_test_n === 0` and emits BLOCKED for that tier
 * specifically. The OTHER tier proceeds normally.
 *
 * **CONTEXT.md decision 2a verbatim:** "Two bound experiences > one.
 * Not a fallback." There is NO combined/winning/primary verdict at
 * this level; the schema test in Plan 02.1-04 enforces.
 */
export async function runHarnessTiered(
  db: Database,
  opts?: { seed?: number },
): Promise<TieredHarnessResult> {
  const seed = opts?.seed ?? 42;
  const corpus = buildCorpus(db);
  const projectSet = new Set(corpus.map(e => e.project));
  if (corpus.length < FLOOR_FINGERPRINTED || projectSet.size < FLOOR_PROJECTS) {
    throw new Error(
      `corpus floor not met — ${corpus.length} fingerprinted events across ${projectSet.size} projects (need >= ${FLOOR_FINGERPRINTED} and >= ${FLOOR_PROJECTS}). Run backfill first.`,
    );
  }

  // Density is corpus-wide; computed once and shared across tiers.
  const density = computeDensitySignal(corpus, { seed: 4242 });

  // CONTEXT.md decision 2c: both tiers always run.
  const strictPairs = labelPairsByTier(corpus, 'strict_3frame');
  const strictResult = await runHarnessForTier(
    db,
    corpus,
    projectSet,
    strictPairs,
    density,
    seed,
  );

  // Relaxed tier — uses SAME seed deliberately; per-tier pair lists are
  // independent inputs to splitTrainTest, so each tier's test set is
  // its own bound experience. The relaxed pair set is a strict
  // superset of strict's by construction (frame_overlap >= 2 implied
  // by >= 3).
  const relaxedPairs = labelPairsByTier(corpus, 'relaxed_2frame');
  const relaxedResult = await runHarnessForTier(
    db,
    corpus,
    projectSet,
    relaxedPairs,
    density,
    seed,
  );

  return {
    ts_epoch: Math.floor(Date.now() / 1000),
    strict_3frame: strictResult,
    relaxed_2frame: relaxedResult,
  };
}
