/**
 * POLISH-10 — 4-judge ensemble regression tests.
 *
 * Tests cover:
 *   - 3-of-4 majority voting against four mocked judges
 *   - Per-probe error handling (judge errors → null verdict)
 *   - 2-of-3 fallback when one judge dropped run-wide
 *   - Run-level fallback computation: 0 / 1 / >1 judges over threshold
 *
 * Real LLM dispatch is pluggable via `dispatcher` so the ensemble shape
 * can be unit-tested without hitting any cloud endpoint.
 */

import { describe, it, expect } from 'vitest';
import {
  adjudicateWithEnsemble,
  computeRunFallback,
  JUDGES,
  RUN_ERROR_BUDGET_PCT,
  type JudgeDispatcher,
  type VerdictParser,
} from '../../../benchmark/deliberation-surfacing/judge-ensemble.js';
import type { JudgeIdentity } from '../../../benchmark/deliberation-surfacing/types.js';

const PASS_PARSER: VerdictParser = (raw) => {
  if (raw === 'PASS') return true;
  if (raw === 'FAIL') return false;
  return null;
};

function staticDispatcher(map: Record<JudgeIdentity['name'], string>): JudgeDispatcher {
  return async (j) => {
    const v = map[j.name];
    if (v === undefined) throw new Error(`unmocked judge: ${j.name}`);
    if (v.startsWith('ERROR')) throw new Error(v);
    return v;
  };
}

describe('JUDGES — 4-judge ensemble identity (POLISH-10)', () => {
  it('exposes exactly the four CONTEXT-locked judges', () => {
    expect(JUDGES.length).toBe(4);
    const names = JUDGES.map((j) => j.name).sort();
    expect(names).toEqual(['claude-opus-4-7', 'gemini-3-flash', 'glm-5.1', 'kimi-k2.6']);
    const families = JUDGES.map((j) => j.family).sort();
    expect(families).toEqual(['anthropic', 'google', 'moonshot', 'zhipu']);
  });
  it('default error budget is 10%', () => {
    expect(RUN_ERROR_BUDGET_PCT).toBe(10);
  });
});

describe('adjudicateWithEnsemble — 3-of-4 majority voting (POLISH-10)', () => {
  it('all four pass → ensemble pass=true', async () => {
    const dispatcher = staticDispatcher({
      'gemini-3-flash': 'PASS',
      'claude-opus-4-7': 'PASS',
      'glm-5.1': 'PASS',
      'kimi-k2.6': 'PASS',
    });
    const r = await adjudicateWithEnsemble('prompt', { dispatcher, parser: PASS_PARSER });
    expect(r.pass).toBe(true);
    expect(r.error_count).toBe(0);
    expect(r.fallback_active).toBe(false);
  });

  it('3-of-4 pass → ensemble pass=true', async () => {
    const dispatcher = staticDispatcher({
      'gemini-3-flash': 'PASS',
      'claude-opus-4-7': 'FAIL',
      'glm-5.1': 'PASS',
      'kimi-k2.6': 'PASS',
    });
    const r = await adjudicateWithEnsemble('prompt', { dispatcher, parser: PASS_PARSER });
    expect(r.pass).toBe(true);
  });

  it('2-of-4 pass → ensemble pass=false (majority threshold = 3 of 4)', async () => {
    const dispatcher = staticDispatcher({
      'gemini-3-flash': 'PASS',
      'claude-opus-4-7': 'FAIL',
      'glm-5.1': 'PASS',
      'kimi-k2.6': 'FAIL',
    });
    const r = await adjudicateWithEnsemble('prompt', { dispatcher, parser: PASS_PARSER });
    expect(r.pass).toBe(false);
  });

  it('one judge errors + 2-of-3 valid pass → ensemble pass=false (threshold over 4 active = 3)', async () => {
    const dispatcher = staticDispatcher({
      'gemini-3-flash': 'ERROR: timeout',
      'claude-opus-4-7': 'PASS',
      'glm-5.1': 'PASS',
      'kimi-k2.6': 'FAIL',
    });
    const r = await adjudicateWithEnsemble('prompt', { dispatcher, parser: PASS_PARSER });
    expect(r.error_count).toBe(1);
    expect(r.pass).toBe(false); // 2 pass < 3 majority threshold over 4 active judges
  });

  it('two judges error → ensemble pass=null (validVerdicts < majorityThreshold of 3)', async () => {
    const dispatcher = staticDispatcher({
      'gemini-3-flash': 'ERROR',
      'claude-opus-4-7': 'ERROR',
      'glm-5.1': 'PASS',
      'kimi-k2.6': 'PASS',
    });
    const r = await adjudicateWithEnsemble('prompt', { dispatcher, parser: PASS_PARSER });
    expect(r.error_count).toBe(2);
    expect(r.pass).toBe(null);
  });
});

describe('adjudicateWithEnsemble — 3-of-3 fallback (POLISH-10)', () => {
  it('with one judge dropped, 2-of-3 pass → ensemble pass=true', async () => {
    const dispatcher = staticDispatcher({
      'gemini-3-flash': 'PASS', // would-be dropped
      'claude-opus-4-7': 'PASS',
      'glm-5.1': 'PASS',
      'kimi-k2.6': 'FAIL',
    });
    const r = await adjudicateWithEnsemble('prompt', {
      dispatcher,
      parser: PASS_PARSER,
      dropped_judge: 'gemini-3-flash',
    });
    expect(r.fallback_active).toBe(true);
    expect(r.dropped_judge).toBe('gemini-3-flash');
    // Active judges: claude (PASS), glm (PASS), kimi (FAIL) → 2-of-3 → pass=true.
    expect(r.pass).toBe(true);
    expect(r.per_judge.length).toBe(3); // dropped judge not present in per_judge
  });

  it('with one judge dropped, 1-of-3 pass → ensemble pass=false', async () => {
    const dispatcher = staticDispatcher({
      'gemini-3-flash': 'PASS',
      'claude-opus-4-7': 'PASS',
      'glm-5.1': 'FAIL',
      'kimi-k2.6': 'FAIL',
    });
    const r = await adjudicateWithEnsemble('prompt', {
      dispatcher,
      parser: PASS_PARSER,
      dropped_judge: 'gemini-3-flash',
    });
    // Active: claude (PASS), glm (FAIL), kimi (FAIL) → 1-of-3 < 2 → pass=false.
    expect(r.pass).toBe(false);
  });
});

describe('computeRunFallback — run-level error budget (POLISH-10)', () => {
  it('zero judges over threshold → no fallback', () => {
    const r = computeRunFallback({
      errorsByJudge: {
        'gemini-3-flash': 1,
        'claude-opus-4-7': 0,
        'glm-5.1': 0,
        'kimi-k2.6': 1,
      },
      totalProbes: 30,
    });
    expect(r.dropped_judge).toBeUndefined();
    expect(r.inconclusive).toBeFalsy();
  });

  it('one judge over 10% → returns its name as dropped_judge', () => {
    const r = computeRunFallback({
      errorsByJudge: {
        'gemini-3-flash': 4, // 4/30 = 13.3% > 10
        'claude-opus-4-7': 0,
        'glm-5.1': 1,
        'kimi-k2.6': 0,
      },
      totalProbes: 30,
    });
    expect(r.dropped_judge).toBe('gemini-3-flash');
    expect(r.inconclusive).toBeFalsy();
  });

  it('two judges over 10% → returns inconclusive: true', () => {
    const r = computeRunFallback({
      errorsByJudge: {
        'gemini-3-flash': 4,
        'claude-opus-4-7': 4,
        'glm-5.1': 0,
        'kimi-k2.6': 0,
      },
      totalProbes: 30,
    });
    expect(r.inconclusive).toBe(true);
    expect(r.dropped_judge).toBeUndefined();
  });

  it('configurable thresholdPct via options', () => {
    const r5 = computeRunFallback({
      errorsByJudge: {
        'gemini-3-flash': 2,
        'claude-opus-4-7': 0,
        'glm-5.1': 0,
        'kimi-k2.6': 0,
      },
      totalProbes: 30,
      thresholdPct: 5, // 2/30 = 6.7% > 5 → over threshold
    });
    expect(r5.dropped_judge).toBe('gemini-3-flash');
    const r10 = computeRunFallback({
      errorsByJudge: {
        'gemini-3-flash': 2,
        'claude-opus-4-7': 0,
        'glm-5.1': 0,
        'kimi-k2.6': 0,
      },
      totalProbes: 30,
      thresholdPct: 10, // 2/30 = 6.7% < 10 → under
    });
    expect(r10.dropped_judge).toBeUndefined();
  });

  it('zero probes returns empty fallback (no division-by-zero)', () => {
    const r = computeRunFallback({
      errorsByJudge: {
        'gemini-3-flash': 0,
        'claude-opus-4-7': 0,
        'glm-5.1': 0,
        'kimi-k2.6': 0,
      },
      totalProbes: 0,
    });
    expect(r.dropped_judge).toBeUndefined();
    expect(r.inconclusive).toBeFalsy();
  });
});
