/**
 * Phase 14-07c — Wave 1 benchmark orchestrator.
 *
 * Runs Vesna SC#1 + LongMemEval (Oracle) + LoCoMo + cross-project
 * candidate hit rate against the current DB state. Compares to v6.6.0
 * baselines (read from 14-07-WAVE1-BASELINES.json). Emits structured
 * JSON for cutover gate consumption.
 *
 * Standalone usage:
 *   bun src/scripts/run-wave1-benchmarks.ts [--json] [--baseline <path>]
 *
 * Exit codes:
 *   0 — all gates passed
 *   1 — one or more gates failed
 *   3 — IO / runner error
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  gate: 'vesna_sc1' | 'longmemeval_oracle' | 'locomo' | 'cross_project_hit_rate';
  measured: number;
  baseline: number;
  threshold: number;
  threshold_comparison: '>=' | '<=';
  passed: boolean;
  details: Record<string, unknown>;
}

export interface BenchmarkRunOutput {
  run_timestamp_epoch_ms: number;
  results: BenchmarkResult[];
  overall_passed: boolean;
}

export interface BaselineFile {
  vesna_sc1: { baseline: number; threshold_comparison: string; unit?: string };
  longmemeval_oracle: { baseline: number; threshold_comparison: string; unit?: string };
  locomo: { baseline: number; threshold_comparison: string; unit?: string };
  cross_project_hit_rate: { baseline: number; threshold_comparison: string; unit?: string };
  [key: string]: unknown;
}

/** Hard-coded fallback baselines (v6.6.0 ship values). */
const FALLBACK_BASELINES: BaselineFile = {
  vesna_sc1: { baseline: 0.97, threshold_comparison: '>=' },
  longmemeval_oracle: { baseline: 0.906, threshold_comparison: '>=' },
  locomo: { baseline: 0.555, threshold_comparison: '>=' },
  cross_project_hit_rate: { baseline: 0.20, threshold_comparison: '<=' },
};

// ---------------------------------------------------------------------------
// DI injection points (for testing)
// ---------------------------------------------------------------------------

export interface GateRunners {
  runVesna: (opts: RunnerOpts) => Promise<GateRawResult>;
  runLongMemEval: (opts: RunnerOpts) => Promise<GateRawResult>;
  runLoCoMo: (opts: RunnerOpts) => Promise<GateRawResult>;
  runCrossProjectHitRate: (opts: RunnerOpts) => Promise<GateRawResult>;
}

export interface RunnerOpts {
  db_path?: string;
  cwd?: string;
}

export interface GateRawResult {
  /** Numeric fraction (0–1) representing the measured score. */
  measured: number;
  /** Gate-specific details (pass/fail counts, error messages, etc.). */
  details: Record<string, unknown>;
}

/**
 * Injectable gate runners. Production: null (uses built-in runners).
 * Tests: set via `_setGateRunnersForTest`.
 */
let _injectedRunners: GateRunners | null = null;

/**
 * Test-only: inject gate runner implementations.
 * Pass null to restore the production runners.
 */
export function _setGateRunnersForTest(runners: GateRunners | null): void {
  _injectedRunners = runners;
}

// ---------------------------------------------------------------------------
// Production gate runners
// ---------------------------------------------------------------------------

/**
 * Run `bun run vesna` and parse its output.
 *
 * Expects output lines like:
 *   "PASS" or "FAIL" per probe.
 *   A summary line like "18/18 PASS" or "N/28 PASS".
 */
export async function runVesna(opts: RunnerOpts): Promise<GateRawResult> {
  const cwd = opts.cwd ?? process.cwd();
  const result = spawnSync('bun', ['run', 'vesna'], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });

  if (result.error) {
    throw new Error(`Vesna runner process error: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? '') + (result.stderr ?? '');
  return parseVesnaOutput(stdout);
}

/**
 * Parse Vesna output string into a GateRawResult.
 * Exported for unit-test use.
 */
export function parseVesnaOutput(stdout: string): GateRawResult {
  // Look for a summary line like "18/18" or "27/28".
  const summaryMatch = stdout.match(/(\d+)\/(\d+)/);
  if (!summaryMatch) {
    // Fallback: count PASS/FAIL lines.
    const passLines = (stdout.match(/\bPASS\b/g) ?? []).length;
    const failLines = (stdout.match(/\bFAIL\b/g) ?? []).length;
    const total = passLines + failLines;
    if (total === 0) {
      return {
        measured: 0,
        details: { error: 'Could not parse Vesna output', raw: stdout.slice(0, 500) },
      };
    }
    return {
      measured: passLines / total,
      details: { passed: passLines, total, raw_excerpt: stdout.slice(0, 200) },
    };
  }

  const passed = parseInt(summaryMatch[1], 10);
  const total = parseInt(summaryMatch[2], 10);
  return {
    measured: total > 0 ? passed / total : 0,
    details: { passed, total, raw_excerpt: stdout.slice(0, 200) },
  };
}

/**
 * Run LongMemEval Oracle harness.
 *
 * Invokes the harness at `scripts/longmemeval-harness.ts` (or the bun
 * script alias) with --mode=oracle --model=deepseek-coder-v2:16b.
 * Output expected: a JSON line with `{ score: 0.906 }` or a summary line
 * like "Accuracy: 90.6%".
 */
export async function runLongMemEval(opts: RunnerOpts): Promise<GateRawResult> {
  const cwd = opts.cwd ?? process.cwd();

  // Try the bun script alias first, then fall back to the direct harness path.
  const args = ['run', 'longmemeval', '--', '--mode=oracle', '--model=deepseek-coder-v2:16b'];
  const result = spawnSync('bun', args, {
    cwd,
    encoding: 'utf8',
    timeout: 600_000, // LongMemEval takes a while.
  });

  if (result.error) {
    throw new Error(`LongMemEval runner process error: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? '') + (result.stderr ?? '');
  return parseLongMemEvalOutput(stdout);
}

/**
 * Parse LongMemEval output string into a GateRawResult.
 * Exported for unit-test use.
 */
export function parseLongMemEvalOutput(stdout: string): GateRawResult {
  // Try JSON line first: { "score": 0.906 } or { "accuracy": 0.906 }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const score = (parsed.score ?? parsed.accuracy) as number | undefined;
        if (typeof score === 'number') {
          return {
            measured: score,
            details: { source: 'json_line', parsed },
          };
        }
      } catch { /* not valid JSON — continue */ }
    }
  }

  // Fallback: look for percentage pattern "Accuracy: 90.6%" or "Score: 90.6%"
  const pctMatch = stdout.match(/(?:Accuracy|Score|Result)[:\s]+(\d+(?:\.\d+)?)\s*%/i);
  if (pctMatch) {
    return {
      measured: parseFloat(pctMatch[1]) / 100,
      details: { source: 'percentage_pattern', raw_excerpt: stdout.slice(0, 300) },
    };
  }

  // Fallback: look for fraction pattern "426/470"
  const fracMatch = stdout.match(/(\d+)\/(\d+)/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const denom = parseInt(fracMatch[2], 10);
    return {
      measured: denom > 0 ? num / denom : 0,
      details: { source: 'fraction_pattern', num, denom, raw_excerpt: stdout.slice(0, 300) },
    };
  }

  return {
    measured: 0,
    details: { error: 'Could not parse LongMemEval output', raw: stdout.slice(0, 500) },
  };
}

/**
 * Run LoCoMo harness with claude-sonnet-4-6.
 */
export async function runLoCoMo(opts: RunnerOpts): Promise<GateRawResult> {
  const cwd = opts.cwd ?? process.cwd();

  const args = ['run', 'locomo', '--', '--model=claude-sonnet-4-6'];
  const result = spawnSync('bun', args, {
    cwd,
    encoding: 'utf8',
    timeout: 600_000,
  });

  if (result.error) {
    throw new Error(`LoCoMo runner process error: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? '') + (result.stderr ?? '');
  return parseLoCoMoOutput(stdout);
}

/**
 * Parse LoCoMo output string into a GateRawResult.
 * Exported for unit-test use.
 */
export function parseLoCoMoOutput(stdout: string): GateRawResult {
  // Try JSON line first.
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const score = (parsed.score ?? parsed.accuracy) as number | undefined;
        if (typeof score === 'number') {
          return {
            measured: score,
            details: { source: 'json_line', parsed },
          };
        }
      } catch { /* not valid JSON */ }
    }
  }

  // Percentage pattern.
  const pctMatch = stdout.match(/(?:Accuracy|Score|Result)[:\s]+(\d+(?:\.\d+)?)\s*%/i);
  if (pctMatch) {
    return {
      measured: parseFloat(pctMatch[1]) / 100,
      details: { source: 'percentage_pattern', raw_excerpt: stdout.slice(0, 300) },
    };
  }

  // Fraction pattern "855/1540".
  const fracMatch = stdout.match(/(\d+)\/(\d+)/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const denom = parseInt(fracMatch[2], 10);
    return {
      measured: denom > 0 ? num / denom : 0,
      details: { source: 'fraction_pattern', num, denom, raw_excerpt: stdout.slice(0, 300) },
    };
  }

  return {
    measured: 0,
    details: { error: 'Could not parse LoCoMo output', raw: stdout.slice(0, 500) },
  };
}

/**
 * Run cross-project candidate hit rate measurement.
 *
 * Re-runs the measurement from context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md
 * against the current DB state. This script (or its equivalent bun alias) should
 * output the noise fraction as a decimal (e.g., 0.17 meaning 17% noise).
 *
 * Gate: noise rate MUST BE <= baseline (0.20). Lower is better.
 */
export async function runCrossProjectHitRate(opts: RunnerOpts): Promise<GateRawResult> {
  const cwd = opts.cwd ?? process.cwd();

  const args = ['run', 'cross-project-hit-rate'];
  const result = spawnSync('bun', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });

  if (result.error) {
    throw new Error(`Cross-project hit rate runner process error: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? '') + (result.stderr ?? '');
  return parseCrossProjectOutput(stdout);
}

/**
 * Parse cross-project hit rate output into a GateRawResult.
 * Exported for unit-test use.
 */
export function parseCrossProjectOutput(stdout: string): GateRawResult {
  // Try JSON line first.
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const rate = (parsed.noise_rate ?? parsed.hit_rate ?? parsed.rate) as number | undefined;
        if (typeof rate === 'number') {
          return {
            measured: rate,
            details: { source: 'json_line', parsed },
          };
        }
      } catch { /* not valid JSON */ }
    }
  }

  // Percentage patterns: "Noise rate: 17%" or "Hit rate: 17%"
  const pctMatch = stdout.match(/(?:noise.?rate|hit.?rate|cross.?project)[:\s]+(\d+(?:\.\d+)?)\s*%/i);
  if (pctMatch) {
    return {
      measured: parseFloat(pctMatch[1]) / 100,
      details: { source: 'percentage_pattern', raw_excerpt: stdout.slice(0, 300) },
    };
  }

  // Decimal pattern: "0.17" or "17.0%"
  const decMatch = stdout.match(/\b(0\.\d+)\b/);
  if (decMatch) {
    return {
      measured: parseFloat(decMatch[1]),
      details: { source: 'decimal_pattern', raw_excerpt: stdout.slice(0, 300) },
    };
  }

  return {
    measured: 1.0, // Worst-case noise (all cross-project) — conservative failure.
    details: { error: 'Could not parse cross-project output', raw: stdout.slice(0, 500) },
  };
}

// ---------------------------------------------------------------------------
// Baseline loading
// ---------------------------------------------------------------------------

/**
 * Load baselines from the JSON file, falling back to hard-coded values
 * if the file is missing or malformed.
 */
export function loadBaselines(baselinePath?: string): BaselineFile {
  // __dirname is defined in CJS bundles; fall back to import.meta.url in ESM.
  const _scriptDir: string =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  const defaultPath = path.resolve(
    _scriptDir,
    '../../.planning/phases/14-substrate-coherence/14-07-WAVE1-BASELINES.json'
  );
  const filePath = baselinePath ?? defaultPath;

  if (!fs.existsSync(filePath)) {
    console.warn(`[run-wave1-benchmarks] Baseline file not found at ${filePath}; using hard-coded fallback baselines.`);
    return FALLBACK_BASELINES;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    // Basic validation.
    if (
      typeof parsed.vesna_sc1?.baseline !== 'number' ||
      typeof parsed.longmemeval_oracle?.baseline !== 'number' ||
      typeof parsed.locomo?.baseline !== 'number' ||
      typeof parsed.cross_project_hit_rate?.baseline !== 'number'
    ) {
      console.warn(`[run-wave1-benchmarks] Baseline file ${filePath} is malformed; using hard-coded fallback.`);
      return FALLBACK_BASELINES;
    }
    return parsed;
  } catch {
    console.warn(`[run-wave1-benchmarks] Failed to read baseline file ${filePath}; using hard-coded fallback.`);
    return FALLBACK_BASELINES;
  }
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a measured value passes the gate.
 *
 * `>=` gates (Vesna, LongMemEval, LoCoMo): measured >= baseline.
 * `<=` gates (cross-project hit rate): measured <= baseline.
 *
 * There is NO rounding tolerance — the comparison is exact to avoid false-PASS
 * on regression. The baseline is the floor, not the target.
 */
export function compareToBaseline(
  gate: BenchmarkResult['gate'],
  measured: number,
  baselines: BaselineFile
): { baseline: number; threshold: number; threshold_comparison: '>=' | '<='; passed: boolean } {
  const entry = baselines[gate] as { baseline: number; threshold_comparison: string };
  const baseline = entry.baseline;
  const comp = entry.threshold_comparison as '>=' | '<=';
  const threshold = baseline; // Non-regression: threshold IS the baseline.

  // Use a tiny epsilon (1e-9) to handle floating-point representation errors
  // that arise from converting percentage strings (e.g., parseFloat('90.6') / 100
  // yields 0.9059999... rather than exactly 0.906). The epsilon is 100× smaller
  // than the smallest meaningful benchmark change (0.001 = 0.1%), so it cannot
  // produce a false-PASS on a genuine regression.
  const EPSILON = 1e-9;
  const passed = comp === '>='
    ? measured >= threshold - EPSILON
    : measured <= threshold + EPSILON;

  return { baseline, threshold, threshold_comparison: comp, passed };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all four Wave 1 benchmark gates.
 *
 * Returns a `BenchmarkRunOutput` with per-gate results and overall pass/fail.
 * Any gate runner that throws is captured as `passed: false` with the error
 * message in `details.error`.
 *
 * @param opts.db_path — Path to the Claudex DB (passed to runners that need it).
 * @param opts.baseline_path — Path to the baselines JSON file.
 * @param opts.runners — DI-injected runners (for tests). Pass null to use production runners.
 */
export async function runWave1Benchmarks(opts?: {
  db_path?: string;
  baseline_path?: string;
  runners?: GateRunners | null;
}): Promise<BenchmarkRunOutput> {
  const baselines = loadBaselines(opts?.baseline_path);
  const runners = opts?.runners ?? _injectedRunners ?? {
    runVesna,
    runLongMemEval,
    runLoCoMo,
    runCrossProjectHitRate,
  };

  const runnerOpts: RunnerOpts = { db_path: opts?.db_path };

  const gates: Array<{
    key: BenchmarkResult['gate'];
    runner: (opts: RunnerOpts) => Promise<GateRawResult>;
  }> = [
    { key: 'vesna_sc1', runner: runners.runVesna },
    { key: 'longmemeval_oracle', runner: runners.runLongMemEval },
    { key: 'locomo', runner: runners.runLoCoMo },
    { key: 'cross_project_hit_rate', runner: runners.runCrossProjectHitRate },
  ];

  const results: BenchmarkResult[] = [];

  for (const { key, runner } of gates) {
    let raw: GateRawResult;
    try {
      raw = await runner(runnerOpts);
    } catch (err) {
      // Runner threw — treat as gate failure.
      raw = {
        measured: key === 'cross_project_hit_rate' ? 1.0 : 0, // Conservative worst-case.
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    const { baseline, threshold, threshold_comparison, passed } = compareToBaseline(
      key,
      raw.measured,
      baselines
    );

    results.push({
      gate: key,
      measured: raw.measured,
      baseline,
      threshold,
      threshold_comparison,
      passed,
      details: raw.details,
    });
  }

  const overall_passed = results.every(r => r.passed);
  return {
    run_timestamp_epoch_ms: Date.now(),
    results,
    overall_passed,
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------

/**
 * Format a `BenchmarkRunOutput` as a human-readable table.
 */
export function formatHumanReadable(output: BenchmarkRunOutput): string {
  const lines: string[] = [
    'Wave 1 Benchmark Gate',
    '=====================',
  ];

  const labelMap: Record<BenchmarkResult['gate'], string> = {
    vesna_sc1: 'vesna_sc1           ',
    longmemeval_oracle: 'longmemeval_oracle  ',
    locomo: 'locomo              ',
    cross_project_hit_rate: 'cross_project_hit   ',
  };

  for (const r of output.results) {
    const label = labelMap[r.gate];
    const measuredStr = formatMeasured(r.gate, r.measured);
    const baselineStr = formatMeasured(r.gate, r.baseline);
    const status = r.passed ? 'PASS' : 'FAIL';
    const delta = r.measured - r.baseline;
    const deltaStr = delta >= 0 ? `+${(delta * 100).toFixed(1)}%` : `${(delta * 100).toFixed(1)}%`;
    lines.push(`  ${label}: ${measuredStr.padEnd(8)} ${status}  (baseline ${baselineStr}, delta ${deltaStr})`);

    if (!r.passed) {
      lines.push(`    *** GATE FAIL: measured ${measuredStr} ${r.threshold_comparison === '>=' ? '<' : '>'} threshold ${formatMeasured(r.gate, r.threshold)}`);
    }
  }

  lines.push('');
  const passCount = output.results.filter(r => r.passed).length;
  const totalCount = output.results.length;
  lines.push(
    output.overall_passed
      ? `GATE: PASS (${passCount}/${totalCount})`
      : `GATE: FAIL (${passCount}/${totalCount} passed)`
  );

  return lines.join('\n');
}

function formatMeasured(gate: BenchmarkResult['gate'], value: number): string {
  if (gate === 'vesna_sc1') {
    // Express as fraction of 28 probes (v6.6.0 has 28 probes).
    const count = Math.round(value * 28);
    return `${count}/28`;
  }
  return `${(value * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const baselineIdx = args.indexOf('--baseline');
  const baselinePath = baselineIdx !== -1 ? args[baselineIdx + 1] : undefined;

  try {
    const output = await runWave1Benchmarks({ baseline_path: baselinePath });

    if (jsonMode) {
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else {
      process.stdout.write(formatHumanReadable(output) + '\n');
    }

    process.exit(output.overall_passed ? 0 : 1);
  } catch (err) {
    process.stderr.write(
      `[run-wave1-benchmarks] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(3);
  }
}

// Run CLI if invoked directly.
// NOTE: When bundled as a dependency inside cutover-v7.cjs, __filename
// resolves to the cutover bundle path, not this file's path. Guard against
// that by checking that argv[1] contains "run-wave1-benchmarks" specifically.
const isMain = process.argv[1]
  ? path.basename(process.argv[1]).startsWith('run-wave1-benchmarks')
  : false;
if (isMain) {
  void main();
}
