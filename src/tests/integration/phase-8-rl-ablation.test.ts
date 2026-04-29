/**
 * Phase 8 (P6.5) — RL ablation A/B harness (ABL-02).
 *
 * Runs the existing Phase 6 (11 probes) + Phase 6.5 (3 cross-project probes)
 * suite under both conditions:
 *   - Baseline (A): CLAUDEX_DISABLE_RL_SCORING absent → full RL stack active
 *   - Flagged  (B): CLAUDEX_DISABLE_RL_SCORING=1     → all RL paths bypassed
 *
 * 3 trials per condition. Aggregates mean + range, per-category breakdown,
 * and a range-aware delta. Writes the verdict to:
 *   `.planning/phases/08-p6.5-rl-ablation-gate/runs/08-rl-ablation-summary.json`
 *
 * Plan 08-03 reads that JSON to populate `context/specs/V4_RL_ABLATION.md`.
 *
 * Sanity-check: telemetry counter must be > 0 in flagged trials and == 0 in
 * baseline trials. A misimplemented gate that silently no-ops is caught here.
 *
 * Confound disclosure (per 08-RESEARCH.md and 08-CONTEXT.md `<deferred>`):
 * Phase 6 W2 already showed `qvalue=0pp delta` on its 11 probes via the
 * `multiplierFlags.qvalue=false` ablation. Phase 8's env-var gate produces
 * identical semantics through a different path on those same 11 probes —
 * so 0pp on the Phase 6 portion is *expected*, not a bug. The incremental
 * signal lives in the 3 Phase 6.5 cross-project probes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  PROBES as PHASE_6_PROBES,
  runProbe as runPhase6Probe,
  type Probe as Phase6Probe,
} from './phase-6-multiplier-ablation.test.js';
import {
  CROSS_PROJECT_PROBES,
  runCrossProjectProbe,
} from './phase-6-5-cross-project-vesna.test.js';
import {
  getRlScoringDisabledCount,
  resetRlScoringDisabledCounter,
} from '../../core/rl-scoring-disabled-counter.js';

const TRIALS = 3;
const FLAVORS = ['lesson', 'entity', 'constraint', 'handoff', 'cross-project'] as const;
type Flavor = typeof FLAVORS[number];

interface ProbeResult {
  probeId: string;
  flavor: Flavor;
  passed: boolean;
}

interface TrialResult {
  trial: number;
  passCount: number;
  total: number;
  passRate: number;
  perCategory: Record<Flavor, { passed: number; total: number; rate: number }>;
  perProbe: ProbeResult[];
  rlGateFireCount: number;
}

interface ConditionResult {
  condition: 'baseline' | 'flagged';
  trials: TrialResult[];
  meanPassRate: number;
  rangeMin: number;
  rangeMax: number;
  meanPerCategory: Record<Flavor, number>;
}

interface AblationSummary {
  captured_at: string;
  probe_count: number;
  trials_per_condition: number;
  decision_threshold_pp: -2;
  baseline: ConditionResult;
  flagged: ConditionResult;
  delta_pp: number;
  per_category_delta_pp: Record<Flavor, number>;
  /** mean(flagged) − max(baseline). Reported as sanity, not the verdict input. */
  range_aware_delta_pp: number;
  verdict: 'DELETE_ALLOWED' | 'KEEP' | 'KEEP_CONSERVATIVE_DEFAULT';
  notes: string[];
}

const FLAVOR_KEYS_INIT = (): Record<Flavor, { passed: number; total: number; rate: number }> =>
  Object.fromEntries(
    FLAVORS.map(f => [f, { passed: 0, total: 0, rate: 0 }]),
  ) as Record<Flavor, { passed: number; total: number; rate: number }>;

async function runOneTrial(
  trial: number,
  condition: 'baseline' | 'flagged',
): Promise<TrialResult> {
  if (condition === 'flagged') {
    process.env.CLAUDEX_DISABLE_RL_SCORING = '1';
  } else {
    delete process.env.CLAUDEX_DISABLE_RL_SCORING;
  }

  resetRlScoringDisabledCounter();

  const perProbe: ProbeResult[] = [];

  // Phase 6 probes (11) — exercise the qMultiplier read path through
  // hybridSearchSync. No multiplierFlags passed; the env-var gate (or its
  // absence) controls qMultiplier behaviour.
  for (const probe of PHASE_6_PROBES as Phase6Probe[]) {
    const outcome = runPhase6Probe(probe, {});
    perProbe.push({
      probeId: probe.id,
      flavor: probe.flavor as Flavor,
      passed: outcome.passed,
    });
  }

  // Phase 6.5 probes (3).
  for (const probe of CROSS_PROJECT_PROBES) {
    const outcome = await runCrossProjectProbe(probe);
    perProbe.push({
      probeId: probe.id,
      flavor: 'cross-project',
      passed: outcome.passed,
    });
  }

  const passCount = perProbe.filter(p => p.passed).length;
  const total = perProbe.length;

  const perCategory = FLAVOR_KEYS_INIT();
  for (const r of perProbe) {
    perCategory[r.flavor].total += 1;
    if (r.passed) perCategory[r.flavor].passed += 1;
  }
  for (const f of FLAVORS) {
    perCategory[f].rate = perCategory[f].total === 0 ? 0 : perCategory[f].passed / perCategory[f].total;
  }

  const rlGateFireCount = getRlScoringDisabledCount();

  return {
    trial,
    passCount,
    total,
    passRate: passCount / total,
    perCategory,
    perProbe,
    rlGateFireCount,
  };
}

async function runCondition(condition: 'baseline' | 'flagged'): Promise<ConditionResult> {
  const trials: TrialResult[] = [];
  for (let i = 1; i <= TRIALS; i++) {
    trials.push(await runOneTrial(i, condition));
  }
  const passRates = trials.map(t => t.passRate);
  const meanPassRate = passRates.reduce((a, b) => a + b, 0) / passRates.length;
  const rangeMin = Math.min(...passRates);
  const rangeMax = Math.max(...passRates);

  const meanPerCategory = Object.fromEntries(
    FLAVORS.map(f => {
      const rates = trials.map(t => t.perCategory[f].rate);
      return [f, rates.reduce((a, b) => a + b, 0) / rates.length];
    }),
  ) as Record<Flavor, number>;

  return { condition, trials, meanPassRate, rangeMin, rangeMax, meanPerCategory };
}

function computeSummary(baseline: ConditionResult, flagged: ConditionResult): AblationSummary {
  const deltaPp = (flagged.meanPassRate - baseline.meanPassRate) * 100;
  const perCategoryDeltaPp = Object.fromEntries(
    FLAVORS.map(f => [f, (flagged.meanPerCategory[f] - baseline.meanPerCategory[f]) * 100]),
  ) as Record<Flavor, number>;

  const rangeAwareDeltaPp = (flagged.meanPassRate - baseline.rangeMax) * 100;

  let verdict: AblationSummary['verdict'];
  if (Math.abs(deltaPp - (-2)) < 1e-6) {
    verdict = 'KEEP_CONSERVATIVE_DEFAULT';
  } else if (deltaPp >= -2) {
    verdict = 'DELETE_ALLOWED';
  } else {
    verdict = 'KEEP';
  }

  const notes: string[] = [];
  if (Math.min(...flagged.trials.map(t => t.rlGateFireCount)) === 0) {
    notes.push('WARNING: at least one flagged trial recorded zero gate fires — gate may not have intercepted the path');
  }
  if (baseline.trials.some(t => t.rlGateFireCount > 0)) {
    notes.push('WARNING: a baseline trial recorded gate fires — env var may have leaked across trials');
  }
  if (flagged.rangeMax - flagged.rangeMin > 0.15) {
    notes.push(`HIGH VARIANCE in flagged condition: range spans ${((flagged.rangeMax - flagged.rangeMin) * 100).toFixed(1)}pp across 3 trials`);
  }
  notes.push('Self-instrumented category not covered: 0 probes available pre-Phase-10');
  notes.push('Phase 6 confound: 11 of the 14 probes were already shown 0pp under multiplierFlags.qvalue=false in Phase 6 W2 — same semantics, different gate path. Incremental signal lives in the 3 Phase 6.5 cross-project probes.');

  return {
    captured_at: new Date().toISOString(),
    probe_count: 14,
    trials_per_condition: TRIALS,
    decision_threshold_pp: -2 as const,
    baseline,
    flagged,
    delta_pp: deltaPp,
    per_category_delta_pp: perCategoryDeltaPp,
    range_aware_delta_pp: rangeAwareDeltaPp,
    verdict,
    notes,
  };
}

function writeSummary(summary: AblationSummary): string {
  const dir = path.resolve(
    process.cwd(),
    '.planning/phases/08-p6.5-rl-ablation-gate/runs',
  );
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, '08-rl-ablation-summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  return outPath;
}

describe('Phase 8 RL ablation gate (ABL-02)', () => {
  afterEach(() => {
    delete process.env.CLAUDEX_DISABLE_RL_SCORING;
    resetRlScoringDisabledCounter();
  });

  it('runs A/B comparison and emits 08-rl-ablation-summary.json with verdict', async () => {
    const baseline = await runCondition('baseline');
    const flagged = await runCondition('flagged');
    const summary = computeSummary(baseline, flagged);
    const outPath = writeSummary(summary);

    // Sanity: gate fired in flagged trials.
    expect(flagged.trials.every(t => t.rlGateFireCount > 0)).toBe(true);
    // Sanity: gate did NOT fire in baseline trials.
    expect(baseline.trials.every(t => t.rlGateFireCount === 0)).toBe(true);

    // Probe + trial counts match contract.
    expect(summary.probe_count).toBe(14);
    expect(summary.trials_per_condition).toBe(TRIALS);

    // Verdict is one of the three locked values.
    expect(['DELETE_ALLOWED', 'KEEP', 'KEEP_CONSERVATIVE_DEFAULT']).toContain(summary.verdict);

    // Summary JSON exists on disk for Plan 08-03.
    expect(fs.existsSync(outPath)).toBe(true);
  }, 120_000);

  it('synthetic verdict at -2pp resolves to KEEP_CONSERVATIVE_DEFAULT', () => {
    const fakeBase: ConditionResult = {
      condition: 'baseline', trials: [],
      meanPassRate: 1.0, rangeMin: 1.0, rangeMax: 1.0,
      meanPerCategory: { lesson: 1, entity: 1, constraint: 1, handoff: 1, 'cross-project': 1 },
    };
    const fakeFlagged: ConditionResult = {
      condition: 'flagged', trials: [],
      meanPassRate: 0.98, rangeMin: 0.98, rangeMax: 0.98,
      meanPerCategory: { lesson: 1, entity: 1, constraint: 1, handoff: 1, 'cross-project': 0.95 },
    };
    const s = computeSummary(fakeBase, fakeFlagged);
    expect(s.verdict).toBe('KEEP_CONSERVATIVE_DEFAULT');
  });

  it('synthetic verdict at -1pp resolves to DELETE_ALLOWED', () => {
    const fakeBase: ConditionResult = {
      condition: 'baseline', trials: [],
      meanPassRate: 1.0, rangeMin: 1.0, rangeMax: 1.0,
      meanPerCategory: { lesson: 1, entity: 1, constraint: 1, handoff: 1, 'cross-project': 1 },
    };
    const fakeFlagged: ConditionResult = {
      condition: 'flagged', trials: [],
      meanPassRate: 0.99, rangeMin: 0.99, rangeMax: 0.99,
      meanPerCategory: { lesson: 1, entity: 1, constraint: 1, handoff: 1, 'cross-project': 0.95 },
    };
    const s = computeSummary(fakeBase, fakeFlagged);
    expect(s.verdict).toBe('DELETE_ALLOWED');
  });

  it('synthetic verdict at -10pp resolves to KEEP', () => {
    const fakeBase: ConditionResult = {
      condition: 'baseline', trials: [],
      meanPassRate: 1.0, rangeMin: 1.0, rangeMax: 1.0,
      meanPerCategory: { lesson: 1, entity: 1, constraint: 1, handoff: 1, 'cross-project': 1 },
    };
    const fakeFlagged: ConditionResult = {
      condition: 'flagged', trials: [],
      meanPassRate: 0.9, rangeMin: 0.9, rangeMax: 0.9,
      meanPerCategory: { lesson: 1, entity: 1, constraint: 1, handoff: 1, 'cross-project': 0.5 },
    };
    const s = computeSummary(fakeBase, fakeFlagged);
    expect(s.verdict).toBe('KEEP');
  });
});
