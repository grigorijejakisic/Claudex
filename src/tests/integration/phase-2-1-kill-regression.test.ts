/**
 * Phase 7 plan 04 — VAL-03' KILL-regression substrate test.
 *
 * Reads the locked Phase 2.1 aggregator JSON and asserts the milestone-reframe
 * verdicts reproduce. The locked-byte-match on Wilson CI lower bounds catches
 * accidental aggregator mutation that would drift the verdict — same discipline
 * the empirical-phase methodology promotion calls "the locked decision rule
 * fires honestly".
 *
 * This is the substrate-level form of SC-V5-3'. The Vesna form was rejected at
 * planning time: regex-over-agent_text is not the right contract for "did the
 * aggregator's recorded verdict drift?" — that's a JSON-state assertion, which
 * vitest does directly. The optional `bun run kill-regression` script (CONTEXT
 * decision 3) re-runs the full Phase 2.1 measurement harness end-to-end; this
 * test is the cheap mandatory complement that gates every CI run.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_PATH = join(
  process.cwd(),
  '.planning',
  'phases',
  '02.1-corpus-expansion-rerun',
  '02.1-results.json',
);

interface VerdictBlock {
  kind: 'KILL' | 'GREEN-LIGHT' | 'SCOPE-DOWN';
  criteria: {
    criterion_1: { passed: boolean; observed: number; evidence: string };
    criterion_2: { passed: boolean; observed: number };
    criterion_3: { passed: boolean; observed: number };
  };
}

interface ResultsJson {
  verdicts: {
    strict_3frame: VerdictBlock;
    relaxed_2frame: VerdictBlock;
  };
}

function loadResults(): ResultsJson {
  const raw = readFileSync(RESULTS_PATH, 'utf-8');
  return JSON.parse(raw) as ResultsJson;
}

describe('Phase 2.1 KILL regression — locked aggregator verdict', () => {
  const results = loadResults();

  it('strict_3frame verdict is KILL', () => {
    expect(results.verdicts.strict_3frame.kind).toBe('KILL');
  });

  it('relaxed_2frame verdict is KILL', () => {
    expect(results.verdicts.relaxed_2frame.kind).toBe('KILL');
  });

  it('strict_3frame criterion_2 density is 0.2418 (intra-project share at corpus floor)', () => {
    // Density floor identical to 4 decimals across both tiers — repeatability
    // confirmed it's the corpus's actual signal, not sampling noise.
    expect(results.verdicts.strict_3frame.criteria.criterion_2.observed).toBeCloseTo(0.2418, 4);
    expect(results.verdicts.strict_3frame.criteria.criterion_2.passed).toBe(false);
  });

  it('relaxed_2frame criterion_2 density is 0.2418 (same floor across labelers)', () => {
    expect(results.verdicts.relaxed_2frame.criteria.criterion_2.observed).toBeCloseTo(0.2418, 4);
    expect(results.verdicts.relaxed_2frame.criteria.criterion_2.passed).toBe(false);
  });

  it('strict_3frame criterion_1 evidence cites Wilson CI lower bound -0.1574 on delta_p5', () => {
    // The evidence string is the locked human-readable form of the CI binding.
    // Mutation that drifts the recorded CI bound fails this test.
    expect(results.verdicts.strict_3frame.criteria.criterion_1.evidence).toContain('-0.1574');
    expect(results.verdicts.strict_3frame.criteria.criterion_1.passed).toBe(false);
  });

  it('relaxed_2frame criterion_1 evidence cites Wilson CI lower bound -0.0333 on delta_p5', () => {
    expect(results.verdicts.relaxed_2frame.criteria.criterion_1.evidence).toContain('-0.0333');
    expect(results.verdicts.relaxed_2frame.criteria.criterion_1.passed).toBe(false);
  });

  it('latency criterion_3 PASSED on both tiers (cost discipline holds)', () => {
    expect(results.verdicts.strict_3frame.criteria.criterion_3.passed).toBe(true);
    expect(results.verdicts.relaxed_2frame.criteria.criterion_3.passed).toBe(true);
  });
});
