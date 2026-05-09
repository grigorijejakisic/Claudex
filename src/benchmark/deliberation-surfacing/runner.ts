import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runReplication, type RunReplicationOpts } from './harness.js';
import { computeReplicationVerdict, poolReplications } from './verdict.js';
import { appendReplication, appendPooledSummary, type AppendOpts } from './aggregator.js';
import { loadProbes } from './probe-loader.js';
import type { ReplicationRunResult, ReplicationSummary, BindVerdict } from './types.js';
import type { Probe } from './probe-schema.js';

export interface BindingMeasurementOpts {
  db: Database;
  replications: number;
  labelPrefix: string;
  useBiEncoderOnly: boolean;
  topK?: number;
  probesDir?: string;
  project?: string;
  /** Skip aggregator + report writes — for --dry-run. */
  noAggregatorWrite?: boolean;
  agentFetcher?: typeof fetch;
  judgeFetcher?: typeof fetch;
  rerankerFetcher?: typeof fetch;
  embeddingFetcher?: typeof fetch;
  aggregatorOpts?: AppendOpts;
  onProbeStart?: RunReplicationOpts['onProbeStart'];
  onProbeComplete?: RunReplicationOpts['onProbeComplete'];
  onReplicationComplete?: (label: string, verdict: BindVerdict) => void;
}

export interface BindingMeasurementResult {
  replications: ReplicationRunResult[];
  per_replication_verdicts: Array<{
    label: string;
    verdict: BindVerdict;
    ci: { lower: number; upper: number; point: number };
  }>;
  pooled: ReplicationSummary;
  reportPath?: string;
}

const SUBSTRATE_CHECK_SQL = `SELECT COUNT(*) as n FROM transcript_chunk_v6`;

/**
 * Sanity gate: vec_transcript_chunks_v6 must have rows for B-arm to be meaningful.
 * Throws with operator-actionable guidance if the substrate is empty.
 */
export function checkSubstrate(db: Database): { chunk_count: number } {
  try {
    const row = db.prepare(SUBSTRATE_CHECK_SQL).get() as { n: number };
    if (row.n === 0) {
      throw new Error(
        `transcript_chunk_v6 has 0 rows. Run \`bun run backfill:transcripts\` first ` +
          `to seed the substrate, then re-run the benchmark.`,
      );
    }
    return { chunk_count: row.n };
  } catch (err) {
    if (err instanceof Error && err.message.includes('no such table')) {
      throw new Error(
        `transcript_chunk_v6 table missing — V32 migration not applied. ` +
          `Inspect ~/.claudex/db/claudex.db schema before running this benchmark.`,
      );
    }
    throw err;
  }
}

/**
 * Orchestrates a binding measurement: N replications × locked probe-set.
 */
export async function runBindingMeasurement(
  opts: BindingMeasurementOpts,
): Promise<BindingMeasurementResult> {
  if (opts.replications < 1) {
    throw new Error(`replications must be ≥ 1; got ${opts.replications}`);
  }
  if (!opts.noAggregatorWrite) {
    checkSubstrate(opts.db);
  }

  const probes: Probe[] = loadProbes(opts.probesDir);
  const replications: ReplicationRunResult[] = [];
  const per_replication_verdicts: BindingMeasurementResult['per_replication_verdicts'] = [];

  for (let i = 0; i < opts.replications; i++) {
    const label = `${opts.labelPrefix}${i + 1}`;
    const result = await runReplication(opts.db, probes, {
      replication_label: label,
      useBiEncoderOnly: opts.useBiEncoderOnly,
      topK: opts.topK,
      project: opts.project,
      agentFetcher: opts.agentFetcher,
      judgeFetcher: opts.judgeFetcher,
      rerankerFetcher: opts.rerankerFetcher,
      embeddingFetcher: opts.embeddingFetcher,
      onProbeStart: opts.onProbeStart,
      onProbeComplete: opts.onProbeComplete,
    });
    const { verdict, delta_ci } = computeReplicationVerdict(result);
    if (!opts.noAggregatorWrite) {
      appendReplication(result, verdict, delta_ci, opts.aggregatorOpts);
    }
    replications.push(result);
    per_replication_verdicts.push({ label, verdict, ci: delta_ci });
    opts.onReplicationComplete?.(label, verdict);
  }

  const pooled = poolReplications(replications);
  if (!opts.noAggregatorWrite && replications.length > 1) {
    appendPooledSummary(pooled, opts.aggregatorOpts);
  }

  let reportPath: string | undefined;
  if (!opts.noAggregatorWrite) {
    const date = new Date().toISOString().slice(0, 10);
    reportPath = path.resolve(process.cwd(), 'context', 'measurements', `${date}-deliberation-surfacing.md`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, renderRunReport(replications, per_replication_verdicts, pooled));
  }

  return { replications, per_replication_verdicts, pooled, reportPath };
}

// ===========================================================================
// POLISH-13 (Plan 11-06) — Q1 within-corpus paired-McNemar orchestration
// ===========================================================================
//
// `runQ1` is the methodology-clean replacement for `runBindingMeasurement` for
// Phase 11 W3 measurement runs. The existing `runBindingMeasurement` stays for
// backward compat with Phase 9 historical comparisons; W3 callers must opt
// into `runQ1` explicitly.
//
// Orchestration shape:
//   1. Pre-flight reranker health check at port 7439 (fail closed → INCONCLUSIVE).
//   2. Run r1 (fresh seed) + r2 (fresh seed) sequentially against the locked
//      30-probe set.
//   3. Track per-judge error counts; trigger run-level fallback per CONTEXT
//      § Methodology critique #6 (drop one judge if >10%, INCONCLUSIVE if >1).
//   4. Track bi-encoder fallback rate; INCONCLUSIVE if >10% per § critique #5.
//   5. Pair r1 + r2 outcomes into PerProbeOutcome[]; compute pairedMcNemar;
//      apply minimum-discordant-pair threshold (≥5).
//   6. Emit `q1-verdict.json` (machine-readable) + append aggregator rows.
//
// Resumability: per-probe checkpoint JSONL — interrupted runs resume by
// skipping probe IDs already completed in either replication.
//
// Live LLM dispatch is pluggable via the existing JudgeDispatcher / VerdictParser
// from `judge-ensemble.ts`. Tests mock the dispatcher; production runs plumb
// the actual cloud passthroughs.

import {
  pairedMcNemar,
} from './verdict.js';
import {
  computeRunFallback,
  type JudgeDispatcher,
  type VerdictParser,
} from './judge-ensemble.js';
import type {
  PerProbeOutcome,
  McNemarVerdict,
  JudgeIdentity,
} from './types.js';

const RERANKER_HEALTH_URL = 'http://127.0.0.1:7439/rerank';
const RERANKER_HEALTH_TIMEOUT_MS = 5_000;

export const Q1_DEFAULT_MIN_DISCORDANT = 5;
export const Q1_DEFAULT_FALLBACK_RATE_THRESHOLD_PCT = 10;
export const Q1_DEFAULT_PER_JUDGE_ERROR_THRESHOLD_PCT = 10;

export interface Q1Config {
  /** Path to locked 30-probe fixture directory (defaults to P9 probes/). */
  probesDir?: string;
  /** Output dir for q1-verdict.json + checkpoint (defaults to phase 11 dir). */
  outDir: string;
  /** Fresh seeds for r1 + r2 — pre-committed at runQ1 invocation time. */
  r1Seed: number;
  r2Seed: number;
  /** Pluggable dispatchers (production: live cloud; tests: mocked). */
  dispatcher: JudgeDispatcher;
  parser: VerdictParser;
  /** Bi-encoder fallback rate above which run is INCONCLUSIVE (CONTEXT § Methodology critique #5). */
  fallbackRateThresholdPct?: number;
  /** Per-judge error rate above which the judge is dropped or run is INCONCLUSIVE (§ critique #6). */
  perJudgeErrorThresholdPct?: number;
  /** Minimum discordant pairs for paired-McNemar to bind (§ critique #2). */
  minDiscordantThreshold?: number;
  /** Skip the reranker health pre-flight (test scaffolding only). */
  skipRerankerHealthCheck?: boolean;
  /** Override the reranker health fetcher (test scaffolding). */
  rerankerHealthFetcher?: typeof fetch;
  /** Override the per-replication driver (test scaffolding — see runQ1Replication). */
  replicationDriver?: Q1ReplicationDriver;
}

export interface Q1ReplicationOutcome {
  probe_id: string;
  kind?: 'a' | 'b' | 'c' | 'd' | 'e';
  a_arm_pass: boolean;
  b_arm_pass: boolean;
  /** True if the ensemble could not produce a verdict for this probe (>1 judge errored on this probe). */
  ensemble_error: boolean;
  /** Number of judges that errored on this probe. */
  judge_error_count: number;
  /** Per-judge error names — for run-level error aggregation. */
  errored_judges: JudgeIdentity['name'][];
  /** True if the routing call fell back to bi-encoder (degraded retrieval). */
  bi_encoder_fallback: boolean;
}

export interface Q1ReplicationResult {
  seed: number;
  replication_index: 1 | 2;
  outcomes: Q1ReplicationOutcome[];
  reranker_calls: number;
  bi_encoder_fallbacks: number;
  started_at_iso: string;
  completed_at_iso: string;
}

export type Q1ReplicationDriver = (params: {
  db: Database;
  probeIds: string[];
  seed: number;
  replicationIndex: 1 | 2;
  dispatcher: JudgeDispatcher;
  parser: VerdictParser;
  droppedJudge?: JudgeIdentity['name'];
}) => Promise<Q1ReplicationResult>;

export interface Q1Verdict {
  verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE';
  reason?: string;
  paired_mcnemar?: McNemarVerdict;
  fallback_rate_pct: number;
  per_judge_errors_pct: Record<string, number>;
  dropped_judge?: JudgeIdentity['name'];
  r1?: Q1ReplicationResult;
  r2?: Q1ReplicationResult;
  q1_started_at: string;
  q1_completed_at: string;
  preflight: { reranker_health: 'ok' | 'fail' | 'skipped' };
}

/**
 * Pre-flight reranker health check. Returns true on a 200 from a synthetic
 * /rerank request; false on any other outcome. Per CONTEXT § Methodology
 * critique #5, the gate fails closed: if the reranker is unreachable, the
 * run cannot start (bi-encoder-only measurements would conflate retrieval
 * quality with engagement quality).
 */
export async function preflightRerankerHealth(
  fetcher: typeof fetch = fetch,
  timeoutMs: number = RERANKER_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetcher(RERANKER_HEALTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'preflight', documents: ['preflight'] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Build PerProbeOutcome[] by pairing r1 + r2 outcomes by probe_id. Probes
 * present in r1 but missing from r2 (or vice versa) are conservatively
 * marked as fail in the missing replication — preserves the strictest
 * discordant-pair signal.
 */
export function pairReplicationOutcomes(
  r1: Q1ReplicationResult,
  r2: Q1ReplicationResult,
): PerProbeOutcome[] {
  const r1Map = new Map(r1.outcomes.map((o) => [o.probe_id, o]));
  const r2Map = new Map(r2.outcomes.map((o) => [o.probe_id, o]));
  const allProbeIds = new Set([...r1Map.keys(), ...r2Map.keys()]);
  const out: PerProbeOutcome[] = [];
  for (const probeId of allProbeIds) {
    const o1 = r1Map.get(probeId);
    const o2 = r2Map.get(probeId);
    out.push({
      probe_id: probeId,
      kind: o1?.kind ?? o2?.kind,
      r1_a_arm_pass: o1?.a_arm_pass ?? false,
      r1_b_arm_pass: o1?.b_arm_pass ?? false,
      r2_a_arm_pass: o2?.a_arm_pass ?? false,
      r2_b_arm_pass: o2?.b_arm_pass ?? false,
    });
  }
  return out;
}

/**
 * Aggregate per-judge error counts across replications. Returns a map keyed
 * by judge name with the total error count summed over r1 + r2.
 */
export function aggregateJudgeErrors(
  replications: Q1ReplicationResult[],
): Record<JudgeIdentity['name'], number> {
  const errors: Record<JudgeIdentity['name'], number> = {
    'gemini-3-flash': 0,
    'claude-opus-4-7': 0,
    'glm-5.1': 0,
    'kimi-k2.6': 0,
  };
  for (const rep of replications) {
    for (const outcome of rep.outcomes) {
      for (const judge of outcome.errored_judges) {
        errors[judge] = (errors[judge] ?? 0) + 1;
      }
    }
  }
  return errors;
}

function inconclusiveResult(
  reason: string,
  partial: Partial<Q1Verdict>,
  startedAt: string,
): Q1Verdict {
  return {
    verdict: 'INCONCLUSIVE',
    reason,
    fallback_rate_pct: 0,
    per_judge_errors_pct: {},
    q1_started_at: startedAt,
    q1_completed_at: new Date().toISOString(),
    preflight: { reranker_health: 'ok' },
    ...partial,
  };
}

/**
 * Q1 — within-corpus paired-McNemar bind on the locked 30-probe set.
 *
 * **Engineering scaffolding only.** Live cloud LLM dispatch is the operator's
 * job at run-time — pass a real `JudgeDispatcher` to plumb endpoints. Tests
 * pass a mocked dispatcher.
 *
 * Operator-actionable failure modes (returns INCONCLUSIVE; does not throw):
 *   - reranker health pre-flight failed
 *   - >1 judge exceeded 10% error rate (ensemble integrity compromised)
 *   - bi-encoder fallback rate exceeded 10% (retrieval-quality conflation)
 *   - paired-McNemar discordant_pairs < threshold (insufficient power)
 */
export async function runQ1(db: Database, config: Q1Config): Promise<Q1Verdict> {
  const startedAt = new Date().toISOString();
  const minDiscordant = config.minDiscordantThreshold ?? Q1_DEFAULT_MIN_DISCORDANT;
  const fallbackRateThresholdPct = config.fallbackRateThresholdPct ?? Q1_DEFAULT_FALLBACK_RATE_THRESHOLD_PCT;
  const perJudgeErrorThresholdPct = config.perJudgeErrorThresholdPct ?? Q1_DEFAULT_PER_JUDGE_ERROR_THRESHOLD_PCT;

  // (1) Pre-flight reranker health.
  let preflightHealth: 'ok' | 'fail' | 'skipped' = 'ok';
  if (config.skipRerankerHealthCheck) {
    preflightHealth = 'skipped';
  } else {
    const healthy = await preflightRerankerHealth(config.rerankerHealthFetcher ?? fetch);
    if (!healthy) {
      return {
        verdict: 'INCONCLUSIVE',
        reason: 'Reranker pre-flight failed — service at port 7439 unreachable. Cannot run Q1 without confirmed reranker access (CONTEXT § Methodology critique #5).',
        fallback_rate_pct: 0,
        per_judge_errors_pct: {},
        q1_started_at: startedAt,
        q1_completed_at: new Date().toISOString(),
        preflight: { reranker_health: 'fail' },
      };
    }
  }

  // (2) Load probes.
  const probes: Probe[] = loadProbes(config.probesDir);
  if (probes.length !== 30) {
    return inconclusiveResult(
      `Q1 expects exactly 30 locked probes per CONTEXT § Implementation Decisions § W2 (Q3); got ${probes.length}. Fixture is byte-immutable.`,
      { preflight: { reranker_health: preflightHealth } },
      startedAt,
    );
  }

  if (!config.replicationDriver) {
    return inconclusiveResult(
      'Q1 requires a replicationDriver (production: cloud-LLM-plumbed; tests: mocked). The driver is not embedded in scaffolding because it depends on live endpoint plumbing the operator wires at run-time.',
      { preflight: { reranker_health: preflightHealth } },
      startedAt,
    );
  }

  const probeIds = probes.map((p) => p.id);

  // (3) Run r1 + r2 sequentially.
  const r1 = await config.replicationDriver({
    db,
    probeIds,
    seed: config.r1Seed,
    replicationIndex: 1,
    dispatcher: config.dispatcher,
    parser: config.parser,
  });

  // Mid-run fallback evaluation: if any judge exceeded threshold during r1,
  // drop them for r2 (3-of-3 fallback per CONTEXT § Locked Decisions #3).
  const r1Errors = aggregateJudgeErrors([r1]);
  const r1Fallback = computeRunFallback({
    errorsByJudge: r1Errors,
    totalProbes: r1.outcomes.length,
    thresholdPct: perJudgeErrorThresholdPct,
  });
  if (r1Fallback.inconclusive) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: `>1 judge exceeded ${perJudgeErrorThresholdPct}% error rate during r1; ensemble integrity compromised (CONTEXT § Methodology critique #6).`,
      fallback_rate_pct: 0,
      per_judge_errors_pct: percentages(r1Errors, r1.outcomes.length),
      r1,
      q1_started_at: startedAt,
      q1_completed_at: new Date().toISOString(),
      preflight: { reranker_health: preflightHealth },
    };
  }

  const r2 = await config.replicationDriver({
    db,
    probeIds,
    seed: config.r2Seed,
    replicationIndex: 2,
    dispatcher: config.dispatcher,
    parser: config.parser,
    droppedJudge: r1Fallback.dropped_judge,
  });

  // (4) Aggregate fallback rates and per-judge errors across both replications.
  const totalCalls = r1.reranker_calls + r2.reranker_calls;
  const totalFallbacks = r1.bi_encoder_fallbacks + r2.bi_encoder_fallbacks;
  const fallbackPct = totalCalls > 0 ? (totalFallbacks / totalCalls) * 100 : 0;
  const allErrors = aggregateJudgeErrors([r1, r2]);
  const totalProbeJudgeOps = (r1.outcomes.length + r2.outcomes.length);

  if (fallbackPct > fallbackRateThresholdPct) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: `Reranker fallback rate ${fallbackPct.toFixed(1)}% exceeded ${fallbackRateThresholdPct}% threshold (CONTEXT § Methodology critique #5). Measurement conflates retrieval-quality with engagement-quality.`,
      fallback_rate_pct: fallbackPct,
      per_judge_errors_pct: percentages(allErrors, totalProbeJudgeOps),
      r1,
      r2,
      q1_started_at: startedAt,
      q1_completed_at: new Date().toISOString(),
      preflight: { reranker_health: preflightHealth },
    };
  }

  // (5) Final per-judge error check across full run (defensive — single-judge
  // budget might still bust on r2 alone if the dropped-judge call wasn't honored).
  const finalFallback = computeRunFallback({
    errorsByJudge: allErrors,
    totalProbes: totalProbeJudgeOps,
    thresholdPct: perJudgeErrorThresholdPct,
  });
  if (finalFallback.inconclusive) {
    return {
      verdict: 'INCONCLUSIVE',
      reason: `>1 judge exceeded ${perJudgeErrorThresholdPct}% error rate over the full run; ensemble integrity compromised (CONTEXT § Methodology critique #6).`,
      fallback_rate_pct: fallbackPct,
      per_judge_errors_pct: percentages(allErrors, totalProbeJudgeOps),
      r1,
      r2,
      q1_started_at: startedAt,
      q1_completed_at: new Date().toISOString(),
      preflight: { reranker_health: preflightHealth },
    };
  }

  // (6) Pair outcomes + compute paired-McNemar.
  const paired = pairReplicationOutcomes(r1, r2);
  const mcnemar = pairedMcNemar(paired, { min_discordant_threshold: minDiscordant });

  return {
    verdict: mcnemar.verdict,
    paired_mcnemar: mcnemar,
    fallback_rate_pct: fallbackPct,
    per_judge_errors_pct: percentages(allErrors, totalProbeJudgeOps),
    dropped_judge: r1Fallback.dropped_judge,
    r1,
    r2,
    q1_started_at: startedAt,
    q1_completed_at: new Date().toISOString(),
    preflight: { reranker_health: preflightHealth },
  };
}

/**
 * Persist Q1 verdict to disk for Plan 11-07 + 11-08 conditional gates.
 * Called by the operator-driven runner after `runQ1` returns.
 */
export function writeQ1Verdict(verdict: Q1Verdict, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'q1-verdict.json');
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2));
  return outPath;
}

function percentages<K extends string>(
  counts: Record<K, number>,
  total: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    out[k] = total > 0 ? ((v as number) / total) * 100 : 0;
  }
  return out;
}

// ===========================================================================
// POLISH-14 (Plan 11-07) — Q2 disjoint-probe gate-reader
// ===========================================================================

export interface Q2GateOutcome {
  proceed: boolean;
  /** When proceed=false, the reason string for q2-skipped.json emission. */
  skipReason?: string;
  /** When proceed=true, the loaded q1-verdict reference. */
  q1Verdict?: Q1Verdict;
}

/**
 * Plan 11-07 entry gate. Reads `q1-verdict.json` and decides whether Q2 should
 * run. Per CONTEXT § Implementation Decisions § W3 (Q2):
 *   - q1-verdict.json missing → skip Q2 (Q1 hasn't run yet).
 *   - verdict !== 'BIND_POSITIVE' → skip Q2; Plan 11-08 KILL/inconclusive path.
 *   - verdict === 'BIND_POSITIVE' → proceed.
 */
export function readQ1Gate(outDir: string): Q2GateOutcome {
  const verdictPath = path.join(outDir, 'q1-verdict.json');
  if (!fs.existsSync(verdictPath)) {
    return {
      proceed: false,
      skipReason: `q1-verdict.json missing at ${verdictPath}. Q1 (Plan 11-06) must run before Q2 (Plan 11-07).`,
    };
  }
  let q1: Q1Verdict;
  try {
    q1 = JSON.parse(fs.readFileSync(verdictPath, 'utf8')) as Q1Verdict;
  } catch (err) {
    return {
      proceed: false,
      skipReason: `q1-verdict.json could not be parsed: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
  if (q1.verdict !== 'BIND_POSITIVE') {
    return {
      proceed: false,
      skipReason: `Q1 verdict is ${q1.verdict}, not BIND_POSITIVE. Per CONTEXT § Implementation Decisions § W3 (Q2): Q2 only runs when Q1 BIND_POSITIVE. Plan 11-08 takes the substrate-only-ship + KILL receipt path.`,
      q1Verdict: q1,
    };
  }
  return { proceed: true, q1Verdict: q1 };
}

export function writeQ2Skipped(reason: string, outDir: string, q1Verdict?: Q1Verdict): string {
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'q2-skipped.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        skipped_at: new Date().toISOString(),
        skip_reason: reason,
        q1_verdict: q1Verdict?.verdict ?? null,
      },
      null,
      2,
    ),
  );
  return outPath;
}

// ===========================================================================
// POLISH-15 (Plan 11-08) — conditional outcomes table applier
// ===========================================================================

export type Phase11Branch =
  | 'engineering_close_strong_bind'        // Q1+Q2+Q3 BIND_POSITIVE
  | 'engineering_close_within_corpus_bind' // Q1+Q2 BIND_POSITIVE, Q3 INCONCLUSIVE/SKIPPED
  | 'engineering_close_recursive_echo'     // Q1+Q2 BIND_POSITIVE, Q3 BIND_NEGATIVE
  | 'kill_receipt_q2_negative'             // Q1 BIND_POSITIVE, Q2 BIND_NEGATIVE
  | 'p11_1_corpus_expansion'               // Q1 BIND_POSITIVE, Q2 INCONCLUSIVE
  | 'kill_receipt_q1_negative'             // Q1 BIND_NEGATIVE
  | 'kill_receipt_q1_inconclusive'         // Q1 INCONCLUSIVE (low-power signal)
  | 'incomplete';                          // Q1 missing

export interface Phase11VerdictTriple {
  q1?: Q1Verdict;
  q2?: { verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE'; skipped?: boolean; reason?: string };
  q3?: { verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE'; skipped?: boolean; reason?: string };
}

/**
 * Apply the spec's pre-committed conditional outcomes table
 * (`.planning/research/2026-05-09-v6-polish.md` lines 88-99) to the
 * (Q1, Q2, Q3) verdict triple. Returns the structured branch identifier
 * Plan 11-08's STATE/ROADMAP/REQUIREMENTS update logic + retag annotation
 * applier consume.
 *
 * Pre-commit: this is the conditional outcomes table operationalized. No
 * goalpost shifting — the function applies the locked rule and returns
 * whichever branch the data produced.
 */
export function applyConditionalOutcomes(triple: Phase11VerdictTriple): Phase11Branch {
  if (!triple.q1) return 'incomplete';
  const q1v = triple.q1.verdict;
  if (q1v === 'BIND_NEGATIVE') return 'kill_receipt_q1_negative';
  if (q1v === 'INCONCLUSIVE') return 'kill_receipt_q1_inconclusive';
  // q1v === 'BIND_POSITIVE'
  if (!triple.q2 || triple.q2.skipped) return 'incomplete'; // Q1 positive but Q2 not run yet
  const q2v = triple.q2.verdict;
  if (q2v === 'BIND_NEGATIVE') return 'kill_receipt_q2_negative';
  if (q2v === 'INCONCLUSIVE') return 'p11_1_corpus_expansion';
  // q2v === 'BIND_POSITIVE'
  if (!triple.q3) {
    // Q3 hasn't been authored/run — the within-corpus bind stands; cross-corpus deferred.
    return 'engineering_close_within_corpus_bind';
  }
  if (triple.q3.skipped) return 'engineering_close_within_corpus_bind';
  const q3v = triple.q3.verdict;
  if (q3v === 'BIND_POSITIVE') return 'engineering_close_strong_bind';
  if (q3v === 'BIND_NEGATIVE') return 'engineering_close_recursive_echo';
  return 'engineering_close_within_corpus_bind'; // INCONCLUSIVE
}

/**
 * Read q1-verdict.json + (q2-verdict.json | q2-skipped.json) + optional q3
 * artifacts from disk, build a Phase11VerdictTriple, and return the branch.
 */
export function loadAndClassifyPhase11(outDir: string): {
  triple: Phase11VerdictTriple;
  branch: Phase11Branch;
} {
  const triple: Phase11VerdictTriple = {};
  const q1Path = path.join(outDir, 'q1-verdict.json');
  if (fs.existsSync(q1Path)) {
    try { triple.q1 = JSON.parse(fs.readFileSync(q1Path, 'utf8')); } catch {}
  }
  const q2Path = path.join(outDir, 'q2-verdict.json');
  const q2SkipPath = path.join(outDir, 'q2-skipped.json');
  if (fs.existsSync(q2Path)) {
    try {
      const v = JSON.parse(fs.readFileSync(q2Path, 'utf8')) as { verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE' };
      triple.q2 = { verdict: v.verdict };
    } catch {}
  } else if (fs.existsSync(q2SkipPath)) {
    try {
      const v = JSON.parse(fs.readFileSync(q2SkipPath, 'utf8')) as { skip_reason: string };
      triple.q2 = { verdict: 'INCONCLUSIVE', skipped: true, reason: v.skip_reason };
    } catch {}
  }
  const q3Path = path.join(outDir, 'q3-verdict.json');
  const q3SkipPath = path.join(outDir, 'q3-skipped.json');
  if (fs.existsSync(q3Path)) {
    try {
      const v = JSON.parse(fs.readFileSync(q3Path, 'utf8')) as { verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE' };
      triple.q3 = { verdict: v.verdict };
    } catch {}
  } else if (fs.existsSync(q3SkipPath)) {
    try {
      const v = JSON.parse(fs.readFileSync(q3SkipPath, 'utf8')) as { skip_reason: string };
      triple.q3 = { verdict: 'INCONCLUSIVE', skipped: true, reason: v.skip_reason };
    } catch {}
  }
  return { triple, branch: applyConditionalOutcomes(triple) };
}

// ===========================================================================
// Existing helpers continue below
// ===========================================================================

function renderRunReport(
  reps: ReplicationRunResult[],
  perRep: BindingMeasurementResult['per_replication_verdicts'],
  pooled: ReplicationSummary,
): string {
  const repBaselines = reps.map((r) => `${r.replication_label}=${r.retrieval_baseline}`).join(', ');
  return [
    `# Deliberation-surfacing run report`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `Retrieval baselines per replication: ${repBaselines || '—'}.`,
    ``,
    `## Per-replication verdicts`,
    ``,
    ...perRep.map((p) => `- **${p.label}**: ${p.verdict} (Δ CI ${p.ci.lower.toFixed(4)} .. ${p.ci.upper.toFixed(4)})`),
    ``,
    `## Pooled verdict`,
    ``,
    `**${pooled.verdict}** at n=${pooled.pooled_n}, Δ CI [${pooled.delta_ci.lower.toFixed(4)}, ${pooled.delta_ci.upper.toFixed(4)}]`,
    ``,
    `## Per-kind descriptive breakdown (NOT a gate)`,
    ``,
    `| Kind | Summary pass rate | Transcript pass rate | Δ |`,
    `|------|-------------------|----------------------|---|`,
    ...pooled.per_kind.map(
      (k) => `| ${k.kind} | ${k.summary_pass_rate.toFixed(3)} | ${k.transcript_pass_rate.toFixed(3)} | ${k.delta.toFixed(3)} |`,
    ),
    ``,
  ].join('\n');
}
