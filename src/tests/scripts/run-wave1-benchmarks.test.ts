/**
 * Tests for Phase 14-07c — run-wave1-benchmarks.ts
 *
 * All 10 tests use injected gate runners. Real harnesses are NOT invoked.
 *
 * Covers:
 *  1. runWave1Benchmarks: all 4 gates run, results structured correctly
 *  2. Vesna result parsing: 18/18 → measured=1.0, passed=true
 *  3. Vesna result parsing: 17/18 → measured=0.944, passed=false
 *  4. LongMemEval result parsing: 90.6% → measured=0.906, passed=true at baseline=0.906
 *  5. LoCoMo result parsing: 55.5% → measured=0.555, passed=true at baseline=0.555
 *  6. cross-project hit rate parsing: 17% noise → measured=0.17, passed=true (≤ 0.20 threshold)
 *  7. baseline file missing: uses hard-coded fallback baseline
 *  8. --json output: parseable JSON with all gates + overall_passed
 *  9. human-readable output: includes PASS/FAIL per gate + GATE summary line
 * 10. gate runner failure (e.g., Vesna runner throws): captured as result with passed=false + details.error
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import {
  runWave1Benchmarks,
  formatHumanReadable,
  compareToBaseline,
  parseVesnaOutput,
  parseLongMemEvalOutput,
  parseLoCoMoOutput,
  parseCrossProjectOutput,
  loadBaselines,
  _setGateRunnersForTest,
  type GateRunners,
  type GateRawResult,
  type RunnerOpts,
} from '../../scripts/run-wave1-benchmarks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunners(overrides?: Partial<GateRunners>): GateRunners {
  const defaultRunner = async (_opts: RunnerOpts): Promise<GateRawResult> => ({
    measured: 1.0,
    details: { source: 'mock' },
  });

  return {
    runVesna: defaultRunner,
    runLongMemEval: defaultRunner,
    runLoCoMo: defaultRunner,
    runCrossProjectHitRate: async (_opts: RunnerOpts): Promise<GateRawResult> => ({
      measured: 0.15, // 15% noise — passes the <= 0.20 threshold
      details: { source: 'mock' },
    }),
    ...overrides,
  };
}

afterEach(() => {
  _setGateRunnersForTest(null);
});

// ---------------------------------------------------------------------------
// Test 1: All 4 gates run, results structured correctly
// ---------------------------------------------------------------------------

describe('runWave1Benchmarks', () => {
  it('1. all 4 gates run; results array has correct structure', async () => {
    const runners = makeRunners({
      runVesna: async () => ({ measured: 1.0, details: { passed: 28, total: 28 } }),
      runLongMemEval: async () => ({ measured: 0.91, details: { source: 'mock' } }),
      runLoCoMo: async () => ({ measured: 0.56, details: { source: 'mock' } }),
      runCrossProjectHitRate: async () => ({ measured: 0.17, details: { source: 'mock' } }),
    });

    const output = await runWave1Benchmarks({ runners });

    expect(output.results).toHaveLength(4);
    expect(output.run_timestamp_epoch_ms).toBeGreaterThan(0);
    expect(output.overall_passed).toBe(true);

    const gates = output.results.map(r => r.gate);
    expect(gates).toContain('vesna_sc1');
    expect(gates).toContain('longmemeval_oracle');
    expect(gates).toContain('locomo');
    expect(gates).toContain('cross_project_hit_rate');

    for (const r of output.results) {
      expect(typeof r.measured).toBe('number');
      expect(typeof r.baseline).toBe('number');
      expect(typeof r.threshold).toBe('number');
      expect(typeof r.passed).toBe('boolean');
      expect(typeof r.details).toBe('object');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Vesna 18/18 → measured=1.0, passed=true
// ---------------------------------------------------------------------------

describe('parseVesnaOutput', () => {
  it('2. 18/18 → measured=1.0, passed=true at baseline=0.97', () => {
    const raw = parseVesnaOutput('Vesna behavioral probe suite\n18/18 PASS\nAll probes passed.');
    expect(raw.measured).toBeCloseTo(1.0, 4);

    const comparison = compareToBaseline('vesna_sc1', raw.measured, {
      vesna_sc1: { baseline: 0.97, threshold_comparison: '>=' },
      longmemeval_oracle: { baseline: 0.906, threshold_comparison: '>=' },
      locomo: { baseline: 0.555, threshold_comparison: '>=' },
      cross_project_hit_rate: { baseline: 0.20, threshold_comparison: '<=' },
    });
    expect(comparison.passed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Vesna 17/18 → measured≈0.944, passed=false
  // ---------------------------------------------------------------------------
  it('3. 17/18 → measured≈0.944, passed=false at baseline=0.97', () => {
    const raw = parseVesnaOutput('17/18\n1 probe FAIL');
    expect(raw.measured).toBeCloseTo(17 / 18, 4);

    const comparison = compareToBaseline('vesna_sc1', raw.measured, {
      vesna_sc1: { baseline: 0.97, threshold_comparison: '>=' },
      longmemeval_oracle: { baseline: 0.906, threshold_comparison: '>=' },
      locomo: { baseline: 0.555, threshold_comparison: '>=' },
      cross_project_hit_rate: { baseline: 0.20, threshold_comparison: '<=' },
    });
    expect(comparison.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4: LongMemEval 90.6% → measured=0.906, passed=true at baseline=0.906
// ---------------------------------------------------------------------------

describe('parseLongMemEvalOutput', () => {
  it('4. "Accuracy: 90.6%" → measured=0.906, passed=true at baseline=0.906', () => {
    const raw = parseLongMemEvalOutput('LongMemEval Oracle results\nAccuracy: 90.6%\nTotal: 470');
    expect(raw.measured).toBeCloseTo(0.906, 3);

    const comparison = compareToBaseline('longmemeval_oracle', raw.measured, {
      vesna_sc1: { baseline: 0.97, threshold_comparison: '>=' },
      longmemeval_oracle: { baseline: 0.906, threshold_comparison: '>=' },
      locomo: { baseline: 0.555, threshold_comparison: '>=' },
      cross_project_hit_rate: { baseline: 0.20, threshold_comparison: '<=' },
    });
    expect(comparison.passed).toBe(true);
  });

  it('4b. JSON line with score=0.906 → measured=0.906, passed=true', () => {
    const raw = parseLongMemEvalOutput('{"score": 0.906, "total": 470}');
    expect(raw.measured).toBeCloseTo(0.906, 4);
  });

  it('4c. Fraction pattern 426/470 → measured≈0.906', () => {
    const raw = parseLongMemEvalOutput('Results: 426/470 correct');
    expect(raw.measured).toBeCloseTo(426 / 470, 4);
  });
});

// ---------------------------------------------------------------------------
// Test 5: LoCoMo 55.5% → measured=0.555, passed=true at baseline=0.555
// ---------------------------------------------------------------------------

describe('parseLoCoMoOutput', () => {
  it('5. "Score: 55.5%" → measured=0.555, passed=true at baseline=0.555', () => {
    const raw = parseLoCoMoOutput('LoCoMo results\nScore: 55.5%\n855/1540');
    // The percentage pattern fires first.
    expect(raw.measured).toBeCloseTo(0.555, 3);

    const comparison = compareToBaseline('locomo', raw.measured, {
      vesna_sc1: { baseline: 0.97, threshold_comparison: '>=' },
      longmemeval_oracle: { baseline: 0.906, threshold_comparison: '>=' },
      locomo: { baseline: 0.555, threshold_comparison: '>=' },
      cross_project_hit_rate: { baseline: 0.20, threshold_comparison: '<=' },
    });
    expect(comparison.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: cross-project 17% noise → measured=0.17, passed=true (≤ 0.20)
// ---------------------------------------------------------------------------

describe('parseCrossProjectOutput', () => {
  it('6. "Noise rate: 17%" → measured=0.17, passed=true (≤ 0.20 threshold)', () => {
    const raw = parseCrossProjectOutput('Cross-project results\nNoise rate: 17%\n');
    expect(raw.measured).toBeCloseTo(0.17, 3);

    const comparison = compareToBaseline('cross_project_hit_rate', raw.measured, {
      vesna_sc1: { baseline: 0.97, threshold_comparison: '>=' },
      longmemeval_oracle: { baseline: 0.906, threshold_comparison: '>=' },
      locomo: { baseline: 0.555, threshold_comparison: '>=' },
      cross_project_hit_rate: { baseline: 0.20, threshold_comparison: '<=' },
    });
    expect(comparison.passed).toBe(true);
  });

  it('6b. 25% noise → measured=0.25, passed=false', () => {
    const raw = parseCrossProjectOutput('Noise rate: 25%');
    const comparison = compareToBaseline('cross_project_hit_rate', raw.measured, {
      vesna_sc1: { baseline: 0.97, threshold_comparison: '>=' },
      longmemeval_oracle: { baseline: 0.906, threshold_comparison: '>=' },
      locomo: { baseline: 0.555, threshold_comparison: '>=' },
      cross_project_hit_rate: { baseline: 0.20, threshold_comparison: '<=' },
    });
    expect(comparison.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 7: baseline file missing → hard-coded fallback
// ---------------------------------------------------------------------------

describe('loadBaselines', () => {
  it('7. missing baseline file → hard-coded fallback with correct values', () => {
    const baselines = loadBaselines('/nonexistent/path/baselines.json');
    expect(baselines.vesna_sc1.baseline).toBe(0.97);
    expect(baselines.longmemeval_oracle.baseline).toBe(0.906);
    expect(baselines.locomo.baseline).toBe(0.555);
    expect(baselines.cross_project_hit_rate.baseline).toBe(0.20);
  });

  it('7b. malformed baseline file → hard-coded fallback', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-baseline-test-'));
    try {
      const badPath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(badPath, '{ "not_a_baseline": true }', 'utf8');
      const baselines = loadBaselines(badPath);
      expect(baselines.vesna_sc1.baseline).toBe(0.97);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: JSON output structure
// ---------------------------------------------------------------------------

describe('JSON output', () => {
  it('8. runWave1Benchmarks with all-passing runners → valid JSON with overall_passed=true', async () => {
    const runners = makeRunners({
      runVesna: async () => ({ measured: 1.0, details: {} }),
      runLongMemEval: async () => ({ measured: 0.91, details: {} }),
      runLoCoMo: async () => ({ measured: 0.56, details: {} }),
    });

    const output = await runWave1Benchmarks({ runners });

    // Verify JSON serializable.
    const json = JSON.parse(JSON.stringify(output)) as typeof output;
    expect(json.overall_passed).toBe(true);
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.results).toHaveLength(4);
    expect(typeof json.run_timestamp_epoch_ms).toBe('number');

    // Structural check on each result.
    for (const r of json.results) {
      expect(['vesna_sc1', 'longmemeval_oracle', 'locomo', 'cross_project_hit_rate']).toContain(r.gate);
      expect(typeof r.measured).toBe('number');
      expect(typeof r.baseline).toBe('number');
      expect(typeof r.threshold).toBe('number');
      expect(typeof r.passed).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9: Human-readable output
// ---------------------------------------------------------------------------

describe('formatHumanReadable', () => {
  it('9. output includes PASS/FAIL per gate and GATE summary line', async () => {
    const runners = makeRunners({
      runVesna: async () => ({ measured: 1.0, details: {} }),
      runLongMemEval: async () => ({ measured: 0.91, details: {} }),
      runLoCoMo: async () => ({ measured: 0.56, details: {} }),
    });

    const output = await runWave1Benchmarks({ runners });
    const text = formatHumanReadable(output);

    expect(text).toContain('Wave 1 Benchmark Gate');
    expect(text).toContain('PASS');
    expect(text).toMatch(/GATE:\s+PASS/);
    // Should show individual gate names.
    expect(text).toContain('vesna_sc1');
    expect(text).toContain('longmemeval_oracle');
    expect(text).toContain('locomo');
    expect(text).toContain('cross_project_hit');
  });

  it('9b. failing gate shows FAIL in output', async () => {
    const runners = makeRunners({
      runVesna: async () => ({ measured: 17 / 18, details: {} }), // < 0.97 baseline
    });

    const output = await runWave1Benchmarks({ runners });
    const text = formatHumanReadable(output);

    expect(text).toContain('FAIL');
    expect(text).toMatch(/GATE:\s+FAIL/);
  });
});

// ---------------------------------------------------------------------------
// Test 10: gate runner throws → captured as passed=false with details.error
// ---------------------------------------------------------------------------

describe('gate runner failure', () => {
  it('10. Vesna runner throws → result has passed=false + details.error, overall_passed=false', async () => {
    const runners = makeRunners({
      runVesna: async () => {
        throw new Error('Vesna process could not be spawned: ENOENT');
      },
      runLongMemEval: async () => ({ measured: 0.91, details: {} }),
      runLoCoMo: async () => ({ measured: 0.56, details: {} }),
    });

    const output = await runWave1Benchmarks({ runners });

    expect(output.overall_passed).toBe(false);

    const vesnaResult = output.results.find(r => r.gate === 'vesna_sc1');
    expect(vesnaResult).toBeTruthy();
    expect(vesnaResult!.passed).toBe(false);
    expect(vesnaResult!.details.error).toBeTruthy();
    expect(String(vesnaResult!.details.error)).toContain('ENOENT');
  });
});
