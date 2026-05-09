/**
 * Top-level Vesna suite orchestrator. Wires loader → runner → aggregate report.
 *
 * Gate semantics (per CONTEXT.md lines 126-128):
 *   - Aggregate >= 0.8 across all non-buffer probes
 *   - AND every NON-EMPTY non-buffer category >= 0.8
 *   - Flaky probes are tagged but excluded from gate denominator (line 134)
 *   - Empty categories (0 probes) are excluded — phase rollout doesn't fail
 *     before all categories are populated
 */

import { loadProbes } from './loader.js';
import { runProbe } from './runner.js';
import { openVesnaTestDb, resetTestDb } from './setup.js';
import { closeDatabase } from '../../core/storage.js';
import {
  type Probe,
  type ProbeCategory,
  type ProbeResult,
  type SuiteReport,
} from './types.js';

const ALL_CATEGORIES: ProbeCategory[] = [
  'entity-recall',
  'constraint-recall',
  'handoff-pickup',
  'cross-project',
  'lesson-application',
  'self-instrumented',
  'deliberation-engagement',
  'buffer',
];

const GATE_THRESHOLD = 0.8;

export interface RunSuiteOptions {
  probesDir?: string;
  trials?: number;
}

export interface SuiteRunResult {
  report: SuiteReport;
  probeResults: ProbeResult[];
}

/**
 * Run the full probe suite end-to-end.
 *
 * Empty probes-dir → vacuous pass: gated=true, aggregate=1, no per-category data.
 * The gate fires only on actual probe data so an empty corpus does not block CI
 * during phase rollout (CONTEXT line 201 spirit: probes are added incrementally).
 */
export async function runVesnaSuite(opts: RunSuiteOptions = {}): Promise<SuiteRunResult> {
  const probes = loadProbes(opts.probesDir);
  const runnable = probes.filter((p) => p.buffer_placeholder !== true);

  const db = openVesnaTestDb();
  const probeResults: ProbeResult[] = [];
  try {
    await resetTestDb(db);
    for (const probe of runnable) {
      const result = await runProbe(db, probe, { trials: opts.trials });
      probeResults.push(result);
    }
    await resetTestDb(db);
  } finally {
    closeDatabase(db);
  }

  const report = buildReport(runnable, probeResults);
  return { report, probeResults };
}

function buildReport(probes: Probe[], results: ProbeResult[]): SuiteReport {
  const perCategory = {} as Record<
    ProbeCategory,
    { pass_rate: number; total: number; passed: number; flaky: number }
  >;
  for (const cat of ALL_CATEGORIES) {
    perCategory[cat] = { pass_rate: 0, total: 0, passed: 0, flaky: 0 };
  }

  const flakyProbes: string[] = [];
  const failedProbes: SuiteReport['failed_probes'] = [];

  let aggregateGated = 0;
  let aggregatePassed = 0;

  for (const r of results) {
    const bucket = perCategory[r.category];
    if (!bucket) continue; // unknown category — defensive, schema validation should prevent
    bucket.total += 1;

    if (r.verdict === 'flaky') {
      bucket.flaky += 1;
      flakyProbes.push(r.probe_id);
      // Flaky probes excluded from per-category and aggregate denominators.
      continue;
    }

    aggregateGated += 1;
    if (r.verdict === 'pass') {
      bucket.passed += 1;
      aggregatePassed += 1;
    } else {
      failedProbes.push({
        id: r.probe_id,
        category: r.category,
        diagnostics: r.trials.map((t) => t.diagnostic),
      });
    }
  }

  // Compute per-category pass rate (gated denominator: total - flaky)
  for (const cat of ALL_CATEGORIES) {
    const bucket = perCategory[cat];
    const denom = bucket.total - bucket.flaky;
    bucket.pass_rate = denom > 0 ? bucket.passed / denom : 0;
  }

  const aggregatePassRate = aggregateGated > 0 ? aggregatePassed / aggregateGated : 1;

  // Gate: aggregate >= threshold AND every non-empty non-buffer category >= threshold
  let categoryGatePass = true;
  for (const cat of ALL_CATEGORIES) {
    if (cat === 'buffer') continue;
    const bucket = perCategory[cat];
    const denom = bucket.total - bucket.flaky;
    if (denom === 0) continue; // empty category exempt
    if (bucket.pass_rate < GATE_THRESHOLD) categoryGatePass = false;
  }

  const aggregateGatePass = aggregateGated === 0 || aggregatePassRate >= GATE_THRESHOLD;
  const gated = aggregateGatePass && categoryGatePass;

  // Reference probes for typedoc completeness — discarded
  void probes;

  return {
    aggregate_pass_rate: aggregatePassRate,
    per_category: perCategory,
    flaky_probes: flakyProbes,
    failed_probes: failedProbes,
    gated,
  };
}
