/**
 * Phase 2 IDX-02 / IDX-04 — top-level runner.
 *
 * Orchestrates: open DB -> run harness -> compute verdict -> persist verdict
 * to disk -> apply verdict-driven side effects (Vesna probe activation/
 * disablement + DEFAULT_CONFIG.features.error_fingerprint flag flip on
 * KILL/SCOPE_DOWN).
 *
 * **Ordering is non-negotiable** (team-lead non-negotiable #4): the verdict
 * is decided and persisted to BOTH 02-results.json AND 02-RESULTS.md
 * BEFORE any code or config the verdict depends on is mutated. The
 * tests in `verdict.test.ts` enforce this with a fs spy.
 *
 * Idempotent: re-runs reproduce the side-effect state from the latest
 * verdict. The renderer/writer overwrites results files. The probe move
 * is "ensure-state" not "transfer-once" — if a probe is already in the
 * right location, the move is a no-op.
 */

import type { Database } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHarness, type HarnessRunResult } from './harness.js';
import { computeVerdict, blockedVerdict, type Verdict, type VerdictKind } from './verdict.js';

export interface RunSummary {
  verdict: Verdict;
  results_md_path: string;
  results_json_path: string;
  vesna_probe_state: 'activated' | 'disabled';
  flag_state: 'true_default' | 'false_default';
}

const PHASE_DIR = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '02-multi-modal-index-seeds-density-check',
);
const RESULTS_JSON = path.join(PHASE_DIR, '02-results.json');
const RESULTS_MD = path.join(PHASE_DIR, '02-RESULTS.md');

const PROBES_DIR = path.resolve(process.cwd(), 'src', 'benchmark', 'vesna', 'probes');
const DISABLED_DIR = path.join(PROBES_DIR, '.disabled');
const PROBE_FILES = ['episodic-fingerprint-fires.json', 'fusion-non-regression.json'];

const CONSTANTS_PATH = path.resolve(process.cwd(), 'src', 'shared', 'constants.ts');

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function ensureProbeAt(target: 'enabled' | 'disabled'): void {
  for (const file of PROBE_FILES) {
    const enabledPath = path.join(PROBES_DIR, file);
    const disabledPath = path.join(DISABLED_DIR, file);
    if (target === 'enabled') {
      if (fs.existsSync(disabledPath) && !fs.existsSync(enabledPath)) {
        fs.renameSync(disabledPath, enabledPath);
      }
    } else {
      if (fs.existsSync(enabledPath) && !fs.existsSync(disabledPath)) {
        fs.renameSync(enabledPath, disabledPath);
      }
    }
  }
}

/**
 * Idempotently set DEFAULT_CONFIG.features.error_fingerprint in
 * src/shared/constants.ts to the desired value. Reads, regex-replaces,
 * writes back atomically. The line shape is `error_fingerprint: <bool>,`.
 */
function setErrorFingerprintFlag(target: 'true_default' | 'false_default'): void {
  const desired = target === 'true_default' ? 'true' : 'false';
  const src = fs.readFileSync(CONSTANTS_PATH, 'utf8');
  const replaced = src.replace(
    /error_fingerprint:\s*(true|false)/,
    `error_fingerprint: ${desired}`,
  );
  if (replaced !== src) atomicWrite(CONSTANTS_PATH, replaced);
}

function renderResultsMarkdown(harness: HarnessRunResult, verdict: Verdict, seed: number): string {
  const generated = new Date(verdict.computed_at_ts_epoch * 1000).toISOString();
  const c1 = verdict.criteria.criterion_1;
  const c2 = verdict.criteria.criterion_2;
  const c3 = verdict.criteria.criterion_3;
  const dri = harness.decision_rule_inputs;

  function metricRow(
    variant: string,
    m: { precision_at_5: { point: number; lower: number; upper: number; n: number }; recall_at_10: { point: number; lower: number; upper: number; n: number }; mrr: { mean: number; ci_lower: number; ci_upper: number; n: number }; n: number },
  ): string {
    const p5 = `${m.precision_at_5.point.toFixed(4)} [${m.precision_at_5.lower.toFixed(4)}, ${m.precision_at_5.upper.toFixed(4)}]`;
    const r10 = `${m.recall_at_10.point.toFixed(4)} [${m.recall_at_10.lower.toFixed(4)}, ${m.recall_at_10.upper.toFixed(4)}]`;
    const mrr = `${m.mrr.mean.toFixed(4)} [${m.mrr.ci_lower.toFixed(4)}, ${m.mrr.ci_upper.toFixed(4)}]`;
    return `| ${variant} | ${p5} | ${r10} | ${mrr} | ${m.n} |`;
  }

  function deltaRow(
    label: string,
    d: { delta_precision_at_5: { point: number; lower: number; upper: number }; delta_recall_at_10: { point: number; lower: number; upper: number } },
    split: string,
  ): string {
    const dp5 = `${d.delta_precision_at_5.point.toFixed(4)} [${d.delta_precision_at_5.lower.toFixed(4)}, ${d.delta_precision_at_5.upper.toFixed(4)}]`;
    const dr10 = `${d.delta_recall_at_10.point.toFixed(4)} [${d.delta_recall_at_10.lower.toFixed(4)}, ${d.delta_recall_at_10.upper.toFixed(4)}]`;
    return `| ${label} | ${dp5} | ${dr10} | ${split} |`;
  }

  function metricsTable(label: string, set: HarnessRunResult['metrics']['pooled']): string {
    return [
      `### ${label}`,
      `| Variant | precision@5 (Wilson 95% CI) | recall@10 (Wilson 95% CI) | MRR (mean ± bootstrap CI) | n |`,
      `|---------|------------------------------|----------------------------|----------------------------|---|`,
      metricRow('A semantic-only', set.A),
      metricRow('B fingerprint-only', set.B),
      metricRow('C RRF-fused (k=60)', set.C),
    ].join('\n');
  }

  return `# Phase 2 Results: Multi-modal index seeds + density-at-scale check

**Generated:** ${generated}
**Harness seed:** ${seed}
**Verdict:** **${verdict.kind}** — ${verdict.kind === 'BLOCKED' ? verdict.blocked_reason : verdict.criteria.criterion_1.passed && verdict.criteria.criterion_2.passed && verdict.criteria.criterion_3.passed ? 'GREEN_LIGHT triple pass' : 'see reasoning below'}

---

## Decision rule (CONTEXT.md item 5, locked BEFORE measurement)

${verdict.decision_rule_quote
  .split('\n')
  .map((line) => `> ${line}`)
  .join('\n')}

---

## Criterion checks (held-out test set)

| # | Criterion | Threshold | Observed | Passed | Evidence |
|---|-----------|-----------|----------|--------|----------|
| 1 | Fusion improvement (max(Δp@5,Δr@10) ≥ +5pp AND CI lower ≥ 0 on the same metric) | ${c1.threshold} / CI≥0 | ${c1.observed.toFixed(4)} | ${c1.passed ? 'YES' : 'NO'} | ${c1.evidence} |
| 2 | Density signal (intra-project share of high-similarity pairs ≥ 30%) | ${c2.threshold} | ${c2.observed.toFixed(4)} | ${c2.passed ? 'YES' : 'NO'} | ${c2.evidence} |
| 3 | Latency budget (p99 fused / p99 semantic < 2.0) | ${c3.threshold} | ${c3.observed.toFixed(4)} | ${c3.passed ? 'YES' : 'NO'} | ${c3.evidence} |

---

## Quality metrics — held-out test set

${metricsTable('Pooled', harness.metrics.pooled)}

${metricsTable('v4_backfill only', harness.metrics.v4_backfill)}

${metricsTable('phase1_organic_pre_phase2_close only', harness.metrics.phase1_organic_pre_phase2_close)}

${metricsTable('phase1_organic_post_phase2_close only', harness.metrics.phase1_organic_post_phase2_close)}

### Deltas vs A (Newcombe 95% CI)
| Comparison | Δ precision@5 (CI) | Δ recall@10 (CI) | Origin split |
|------------|--------------------|------------------|--------------|
${deltaRow('C - A', harness.deltas.pooled.C_vs_A, 'pooled')}
${deltaRow('C - A', harness.deltas.v4_backfill.C_vs_A, 'v4_backfill')}
${deltaRow('C - A', harness.deltas.phase1_organic_pre_phase2_close.C_vs_A, 'phase1_organic_pre_phase2_close')}
${deltaRow('C - A', harness.deltas.phase1_organic_post_phase2_close.C_vs_A, 'phase1_organic_post_phase2_close')}
${deltaRow('B - A', harness.deltas.pooled.B_vs_A, 'pooled')}

---

## Latency

| Variant | p50 (ms) | p95 (ms) | p99 (ms) |
|---------|----------|----------|----------|
| A | ${harness.metrics.pooled.A.latency_ms.p50.toFixed(3)} | ${harness.metrics.pooled.A.latency_ms.p95.toFixed(3)} | ${harness.metrics.pooled.A.latency_ms.p99.toFixed(3)} |
| B | ${harness.metrics.pooled.B.latency_ms.p50.toFixed(3)} | ${harness.metrics.pooled.B.latency_ms.p95.toFixed(3)} | ${harness.metrics.pooled.B.latency_ms.p99.toFixed(3)} |
| C | ${harness.metrics.pooled.C.latency_ms.p50.toFixed(3)} | ${harness.metrics.pooled.C.latency_ms.p95.toFixed(3)} | ${harness.metrics.pooled.C.latency_ms.p99.toFixed(3)} |

p99(C) / p99(A) = ${dri.p99_fused_over_p99_semantic.toFixed(4)} (criterion 3 threshold = 2.0)

---

## Density signal (CONTEXT item 4)

- Random-pair sample size: ${harness.density.random_pair_sample_size}
- Noise floor (95th percentile of random pair Jaccard): ${harness.density.noise_floor.toFixed(4)}
- Sample stddev (σ): ${harness.density.noise_sigma.toFixed(4)}
- Cluster threshold (noise floor + 2σ): ${harness.density.cluster_threshold.toFixed(4)}
- Weak clusters (K=2..4): ${harness.density.cluster_count.weak_K2}
- Strong clusters (K≥5): ${harness.density.cluster_count.strong_K5}
- Intra-project share of high-similarity pairs: ${harness.density.intra_project_share.toFixed(4)} (CONTEXT item 4 threshold = 0.30)
- Density meaningful: ${harness.density.density_meaningful ? 'YES' : 'NO'}

---

## Corpus

- Total fingerprinted episodes: ${harness.corpus_size.total}
- v4_backfill: ${harness.corpus_size.v4_backfill}
- phase1_organic_pre_phase2_close: ${harness.corpus_size.phase1_organic_pre_phase2_close}
- phase1_organic_post_phase2_close: ${harness.corpus_size.phase1_organic_post_phase2_close}
- Projects covered: ${harness.corpus_size.projects.join(', ')}
- Test set size: ${harness.pairs.test} pairs

See: 02-03-corpus-audit.md for source breakdown and 20-pair spot-check.

---

## Verdict reasoning

${verdict.reasoning}

---

## Next steps

${
  verdict.kind === 'GREEN_LIGHT'
    ? '- **GREEN_LIGHT**: Phase 3 (multi-handle retrieval cutover) proceeds; both Vesna probes activated; flag default stays true.'
    : verdict.kind === 'SCOPE_DOWN'
      ? '- **SCOPE_DOWN**: Phase 3 ships advisory-only; Vesna probes remain disabled; flag default flipped to false (CONTEXT item 7); Phase 5 de-scoped to advisory.'
      : verdict.kind === 'KILL'
        ? '- **KILL**: Phase 3 plan rewritten; multi-handle thesis reconsidered at user-approval gate; flag default flipped to false; backfilled rows and harness retained per CONTEXT item 7.'
        : '- **BLOCKED**: corpus floor not met or runtime error. Run \`backfill\` first or investigate the harness error before re-running \`measure\`.'
}

Code retained at flag for future reference. Phase 5 (the second empirical phase) reuses this harness shape.
`;
}

/**
 * Top-level runner. Strict ordering: harness -> verdict -> persistence ->
 * side effects. The ordering test in `verdict.test.ts` enforces this with
 * an fs spy.
 */
export async function runFullPhase2Measurement(
  db: Database,
  opts?: { seed?: number; ts_epoch?: number },
): Promise<RunSummary> {
  const seed = opts?.seed ?? 42;

  // 1. Run harness (may throw on corpus-floor miss)
  let harness: HarnessRunResult | null = null;
  let verdict: Verdict;
  try {
    harness = await runHarness(db, { seed });
    // 2. Compute verdict
    verdict = computeVerdict(harness.decision_rule_inputs, { ts_epoch: opts?.ts_epoch });
  } catch (err) {
    verdict = blockedVerdict((err as Error).message, { ts_epoch: opts?.ts_epoch });
  }

  // 3. Persist machine-readable results
  const resultsObj = {
    schema_version: 1 as const,
    generated_at_ts_epoch: verdict.computed_at_ts_epoch,
    harness,
    verdict,
  };
  fs.mkdirSync(PHASE_DIR, { recursive: true });
  atomicWrite(RESULTS_JSON, JSON.stringify(resultsObj, null, 2));

  // 4. Render and write 02-RESULTS.md
  const md =
    harness == null
      ? `# Phase 2 Results: BLOCKED\n\n**Generated:** ${new Date(verdict.computed_at_ts_epoch * 1000).toISOString()}\n\nThe harness could not run:\n\n> ${verdict.blocked_reason ?? 'unknown reason'}\n\n${verdict.decision_rule_quote.split('\n').map((l) => `> ${l}`).join('\n')}\n`
      : renderResultsMarkdown(harness, verdict, seed);
  atomicWrite(RESULTS_MD, md);

  // 5. Side effects gate — only after results are durably on disk
  let vesna_probe_state: 'activated' | 'disabled';
  let flag_state: 'true_default' | 'false_default';
  if (verdict.kind === 'GREEN_LIGHT') {
    ensureProbeAt('enabled');
    setErrorFingerprintFlag('true_default');
    vesna_probe_state = 'activated';
    flag_state = 'true_default';
  } else if (verdict.kind === 'SCOPE_DOWN' || verdict.kind === 'KILL') {
    ensureProbeAt('disabled');
    setErrorFingerprintFlag('false_default');
    vesna_probe_state = 'disabled';
    flag_state = 'false_default';
  } else {
    // BLOCKED — no side effects fire
    vesna_probe_state = 'disabled';
    flag_state = 'true_default';
  }

  return {
    verdict,
    results_md_path: RESULTS_MD,
    results_json_path: RESULTS_JSON,
    vesna_probe_state,
    flag_state,
  };
}

export type { VerdictKind };
