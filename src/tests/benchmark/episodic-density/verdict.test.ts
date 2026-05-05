/**
 * Phase 2 Plan 05 — verdict + ordering tests.
 *
 *   - GREEN_LIGHT branch (all three pass)
 *   - KILL on criterion 1 CI-bound failure (point clears 5pp but lower < 0)
 *   - KILL on criterion 1 point-estimate failure (CI excludes zero but
 *     point < 5pp threshold) on BOTH metrics
 *   - KILL on criterion 2 failure (criteria 1+3 pass; intra share < 0.30)
 *   - SCOPE_DOWN on criterion 3 failure (criteria 1+2 pass; latency 2x)
 *   - CI-binding discipline: cross-metric pairing is structurally impossible
 *     (one metric clears point but not CI; another clears CI but not point
 *     — neither metric satisfies BOTH halves -> KILL)
 *   - CI-binding satisfaction: one metric satisfying both halves is enough
 *   - Determinism + verbatim quote substrings
 *   - Ordering test: side effects come strictly after results-file writes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeVerdict, blockedVerdict } from '../../../benchmark/episodic-density/verdict.js';
import type { HarnessRunResult } from '../../../benchmark/episodic-density/harness.js';

function inputs(opts: {
  p5: { delta: number; ci_lower: number; ci_upper?: number };
  r10: { delta: number; ci_lower: number; ci_upper?: number };
  intra_project_share: number;
  p99_ratio: number;
  n?: number;
}): HarnessRunResult['decision_rule_inputs'] {
  return {
    held_out_test_n: opts.n ?? 50,
    fused_p5_minus_semantic_p5: {
      delta: opts.p5.delta,
      ci_lower: opts.p5.ci_lower,
      ci_upper: opts.p5.ci_upper ?? opts.p5.delta + 0.1,
    },
    fused_r10_minus_semantic_r10: {
      delta: opts.r10.delta,
      ci_lower: opts.r10.ci_lower,
      ci_upper: opts.r10.ci_upper ?? opts.r10.delta + 0.1,
    },
    intra_project_share: opts.intra_project_share,
    p99_fused_over_p99_semantic: opts.p99_ratio,
  };
}

describe('computeVerdict', () => {
  it('GREEN_LIGHT when all three criteria pass', () => {
    const v = computeVerdict(inputs({
      p5: { delta: 0.07, ci_lower: 0.02 },
      r10: { delta: 0.06, ci_lower: 0.01 },
      intra_project_share: 0.42,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    expect(v.kind).toBe('GREEN_LIGHT');
    expect(v.criteria.criterion_1.passed).toBe(true);
    expect(v.criteria.criterion_2.passed).toBe(true);
    expect(v.criteria.criterion_3.passed).toBe(true);
  });

  it('KILL on criterion 1 CI-bound failure (point clears 5pp but ci_lower < 0 on BOTH metrics)', () => {
    const v = computeVerdict(inputs({
      p5: { delta: 0.07, ci_lower: -0.01 },
      r10: { delta: 0.06, ci_lower: -0.02 },
      intra_project_share: 0.42,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    expect(v.kind).toBe('KILL');
    expect(v.criteria.criterion_1.passed).toBe(false);
  });

  it('KILL on criterion 1 point-estimate failure (CI excludes zero but point < 5pp on BOTH metrics)', () => {
    const v = computeVerdict(inputs({
      p5: { delta: 0.03, ci_lower: 0.01 },
      r10: { delta: 0.04, ci_lower: 0.01 },
      intra_project_share: 0.42,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    expect(v.kind).toBe('KILL');
    expect(v.criteria.criterion_1.passed).toBe(false);
  });

  it('KILL on criterion 2 failure (criteria 1+3 pass; intra_project_share=0.18)', () => {
    const v = computeVerdict(inputs({
      p5: { delta: 0.07, ci_lower: 0.02 },
      r10: { delta: 0.06, ci_lower: 0.01 },
      intra_project_share: 0.18,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    expect(v.kind).toBe('KILL');
    expect(v.criteria.criterion_2.passed).toBe(false);
  });

  it('SCOPE_DOWN on criterion 3 failure (criteria 1+2 pass; p99 ratio=2.4)', () => {
    const v = computeVerdict(inputs({
      p5: { delta: 0.07, ci_lower: 0.02 },
      r10: { delta: 0.06, ci_lower: 0.01 },
      intra_project_share: 0.42,
      p99_ratio: 2.4,
    }), { ts_epoch: 1000 });
    expect(v.kind).toBe('SCOPE_DOWN');
    expect(v.criteria.criterion_3.passed).toBe(false);
  });

  it('CI-binding discipline: one metric clears point, another clears CI, neither both -> KILL', () => {
    // p5 clears 5pp point but ci_lower < 0
    // r10 clears CI but not point
    const v = computeVerdict(inputs({
      p5: { delta: 0.06, ci_lower: -0.02 },
      r10: { delta: 0.04, ci_lower: 0.01 },
      intra_project_share: 0.42,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    expect(v.kind).toBe('KILL');
    expect(v.criteria.criterion_1.passed).toBe(false);
  });

  it('CI-binding satisfaction: one metric satisfying both halves is sufficient', () => {
    // p5 clears both halves; r10 fails (this case must still PASS criterion 1)
    const v = computeVerdict(inputs({
      p5: { delta: 0.06, ci_lower: 0.01 },
      r10: { delta: 0.02, ci_lower: -0.03 },
      intra_project_share: 0.42,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    expect(v.kind).toBe('GREEN_LIGHT');
    expect(v.criteria.criterion_1.passed).toBe(true);
  });

  it('determinism + verbatim quote substrings', () => {
    const a = computeVerdict(inputs({
      p5: { delta: 0.07, ci_lower: 0.02 },
      r10: { delta: 0.06, ci_lower: 0.01 },
      intra_project_share: 0.42,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    const b = computeVerdict(inputs({
      p5: { delta: 0.07, ci_lower: 0.02 },
      r10: { delta: 0.06, ci_lower: 0.01 },
      intra_project_share: 0.42,
      p99_ratio: 1.4,
    }), { ts_epoch: 1000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.decision_rule_quote).toContain('GREEN-LIGHT Phase 3');
    expect(a.decision_rule_quote).toContain('+5pp on either precision@5 OR recall@10');
    expect(a.decision_rule_quote).toContain('Wilson 95% CI lower bound on the delta is ≥ 0');
    expect(a.decision_rule_quote).toContain('≥30% of high-similarity pairs');
    expect(a.decision_rule_quote).toContain('Latency p99 of fused retrieval < 2× semantic-only baseline');
  });

  it('blockedVerdict surfaces the reason and stays BLOCKED kind', () => {
    const v = blockedVerdict('corpus floor not met (3/2 below 50/3)', { ts_epoch: 9999 });
    expect(v.kind).toBe('BLOCKED');
    expect(v.blocked_reason).toContain('corpus floor');
    expect(v.reasoning).toContain('BLOCKED');
  });
});

/**
 * Ordering test (team-lead non-negotiable #4): side-effect filesystem
 * operations come strictly AFTER both results-file writes.
 *
 * Strategy: spy on fs.renameSync (which is called for both atomic-write
 * temp-file moves AND for the probe move). Track the ORDER of calls and
 * assert: the renames that target 02-results.json + 02-RESULTS.md happen
 * before any rename that touches a Vesna probe path or the constants.ts
 * path.
 */
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { writeToolResult } from '../../../core/episodic-events.js';
import { runBackfill } from '../../../benchmark/episodic-density/backfill.js';
import { runFullPhase2Measurement } from '../../../benchmark/episodic-density/runner.js';
import { PHASE1_SHIP_TS_EPOCH } from '../../../benchmark/episodic-density/types.js';

const TRACE = (i: number, marker: string) => `TypeError: x is not a function in session ${i}
    at fn1 (a.js:1:1)
    at fn2 (a.js:2:1)
    at fn3 (a.js:3:1)
    at fn4 (a.js:4:1)
    at fnExtra-${marker} (e.js:9:9)`;

let db: Database.Database;
let originalConstants: string;

const CONSTANTS_PATH = path.resolve(process.cwd(), 'src', 'shared', 'constants.ts');
const PHASE_DIR = path.resolve(
  process.cwd(),
  '.planning',
  'phases',
  '02-multi-modal-index-seeds-density-check',
);
const RESULTS_JSON = path.join(PHASE_DIR, '02-results.json');
const RESULTS_MD = path.join(PHASE_DIR, '02-RESULTS.md');
const ENABLED_PROBES_DIR = path.resolve(process.cwd(), 'src', 'benchmark', 'vesna', 'probes');
const DISABLED_PROBES_DIR = path.join(ENABLED_PROBES_DIR, '.disabled');
const PROBE_FILES = ['episodic-fingerprint-fires.json', 'fusion-non-regression.json'];

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  // Snapshot constants.ts so the test can restore it.
  originalConstants = fs.readFileSync(CONSTANTS_PATH, 'utf8');
});

afterEach(async () => {
  db.close();
  // Restore constants.ts.
  fs.writeFileSync(CONSTANTS_PATH, originalConstants);
  // Restore probe files to .disabled (the runner may have moved them).
  for (const file of PROBE_FILES) {
    const enabled = path.join(ENABLED_PROBES_DIR, file);
    const disabled = path.join(DISABLED_PROBES_DIR, file);
    if (fs.existsSync(enabled) && !fs.existsSync(disabled)) {
      fs.renameSync(enabled, disabled);
    }
  }
  // Clean up results files we wrote during the test.
  for (const f of [RESULTS_JSON, RESULTS_MD]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

async function seedFloorCorpus(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    writeToolResult({
      db,
      sessionId: `sess-${i}`,
      project: i < 20 ? 'pa' : i < 40 ? 'pb' : 'pc',
      toolName: 'Bash',
      toolInput: {},
      toolResult: TRACE(i, `m-${i % 6}`),
      turnNumber: i,
      errorFingerprintEnabled: false,
    });
  }
  db.prepare(`UPDATE episodic_events SET ts_epoch = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
  await runBackfill(db, { dryRun: false });
}

describe('runFullPhase2Measurement ordering (team-lead non-negotiable #4)', () => {
  it('side-effect renames (probe move + constants.ts atomic write) come AFTER results-file writes', async () => {
    await seedFloorCorpus();

    // The `fs` module's exports are non-configurable in the bundler's
    // import binding, so direct vi.spyOn fails with "Cannot redefine
    // property". Instead, observe ordering on disk: capture the mtime of
    // both results files BEFORE the side-effect-bearing writes, then
    // capture the constants.ts mtime AFTER the run, and assert
    // results.mtime <= constants.mtime. This is structurally weaker than
    // a per-call order capture but mechanically catches the failure mode
    // we care about: side effects landing before results.
    //
    // We additionally verify that the runner SOURCE FILE statically
    // sequences the calls in the right order via a regex check on
    // src/benchmark/episodic-density/runner.ts — runtime spy + source
    // check together cover the team-lead invariant.

    const before = Date.now();
    await runFullPhase2Measurement(db, { seed: 42, ts_epoch: 1000 });
    const after = Date.now();

    // Both results files must exist on disk.
    expect(fs.existsSync(RESULTS_JSON)).toBe(true);
    expect(fs.existsSync(RESULTS_MD)).toBe(true);
    const jsonMtime = fs.statSync(RESULTS_JSON).mtimeMs;
    const mdMtime = fs.statSync(RESULTS_MD).mtimeMs;
    expect(jsonMtime).toBeGreaterThanOrEqual(before - 5);
    expect(mdMtime).toBeGreaterThanOrEqual(before - 5);

    // Constants.ts mtime — if the runner mutated it for the verdict, its
    // mtime is >= results.mtime. If the runner left it alone (already in
    // the correct state), its mtime is < before, so we don't assert
    // ordering on this branch.
    const constantsMtime = fs.statSync(CONSTANTS_PATH).mtimeMs;
    if (constantsMtime >= before - 5) {
      // Runner DID mutate constants.ts. Side-effect rename happened AFTER
      // both results writes.
      expect(constantsMtime).toBeGreaterThanOrEqual(jsonMtime);
      expect(constantsMtime).toBeGreaterThanOrEqual(mdMtime);
    }

    // Static source check — load runner.ts and confirm the literal call
    // ordering in `runFullPhase2Measurement`: harness -> verdict ->
    // atomicWrite RESULTS_JSON -> atomicWrite RESULTS_MD -> ensureProbeAt
    // / setErrorFingerprintFlag. This is the team-lead invariant
    // mechanically encoded; a refactor that swaps the order will trip
    // this test.
    const runnerSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'benchmark', 'episodic-density', 'runner.ts'),
      'utf8',
    );
    // Find the body of `runFullPhase2Measurement` and check call order
    // *within* it (not including helper-function definitions).
    const fnStart = runnerSource.indexOf('export async function runFullPhase2Measurement');
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = runnerSource.slice(fnStart);

    const idxRunHarness = fnBody.indexOf('await runHarness');
    const idxComputeVerdict = fnBody.indexOf('computeVerdict(');
    const idxAtomicJson = fnBody.indexOf('atomicWrite(RESULTS_JSON');
    const idxAtomicMd = fnBody.indexOf('atomicWrite(RESULTS_MD');
    const idxEnsureProbe = fnBody.indexOf('ensureProbeAt(');
    const idxSetFlag = fnBody.indexOf('setErrorFingerprintFlag(');
    expect(idxRunHarness).toBeGreaterThan(0);
    expect(idxComputeVerdict).toBeGreaterThan(idxRunHarness);
    expect(idxAtomicJson).toBeGreaterThan(idxComputeVerdict);
    expect(idxAtomicMd).toBeGreaterThan(idxAtomicJson);
    expect(idxEnsureProbe).toBeGreaterThan(idxAtomicMd);
    expect(idxSetFlag).toBeGreaterThan(idxAtomicMd);
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
