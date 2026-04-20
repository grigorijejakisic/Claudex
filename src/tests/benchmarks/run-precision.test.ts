/**
 * Unit tests for the precision-harness metric computation + compare-runs
 * markdown output (Plan 03-05). Mock detector decisions against canned
 * labeler outputs; no LLM calls.
 */

import { describe, it, expect } from 'vitest';
import { computeMetrics, type PairedCandidate } from '../../benchmarks/directive-detector/run-precision.js';
import { renderMarkdown } from '../../benchmarks/directive-detector/compare-runs.js';
import type { FixtureCandidate } from '../../benchmarks/directive-detector/build-candidates.js';
import type { LabelFields } from '../../benchmarks/directive-detector/label-candidates.js';
import type { DetectionRecord } from '../../intelligence/directive-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkCandidate(overrides: Partial<FixtureCandidate>): FixtureCandidate {
  return {
    candidate_id: 'sid:1',
    session_id: 'sid',
    ordinal: 1,
    turn_idx: 1,
    raw_text: 'always use Bun',
    stripped_text: 'always use Bun',
    matched_families: ['always_emphasis'],
    context_prev_2: [],
    context_next_2: [],
    ...overrides,
  };
}

function mkLabel(overrides: Partial<LabelFields>): LabelFields {
  return {
    is_directive: true,
    scope: 'project',
    polarity: 'prescriptive',
    self_confidence: 0.9,
    reasoning: 'test',
    ...overrides,
  };
}

function mkDetector(overrides: Partial<DetectionRecord>): DetectionRecord {
  return {
    session_id: 'sid',
    turn_idx: 1,
    raw_text: 'x',
    matched_families: ['always_emphasis'],
    decision: 'inserted',
    confirmation: {
      is_directive: true,
      confidence: 0.9,
      polarity: 'prescriptive',
      scope: 'project',
      suggested_title: 't',
      normalized_text: 'n',
      reasoning: 'r',
    },
    ...overrides,
  };
}

function pair(
  cOverrides: Partial<FixtureCandidate>,
  lOverrides: Partial<LabelFields>,
  dOverrides: Partial<DetectionRecord>,
): PairedCandidate {
  return {
    candidate: mkCandidate(cOverrides),
    label: mkLabel(lOverrides),
    detector: mkDetector(dOverrides),
  };
}

// ---------------------------------------------------------------------------
// computeMetrics
// ---------------------------------------------------------------------------

describe('computeMetrics', () => {
  it('returns null rates when no detector confirmations', () => {
    const pairs = [
      pair(
        {},
        { is_directive: false, scope: null, polarity: null },
        { decision: 'rejected_confirm', confirmation: { is_directive: false, confidence: 0.1, polarity: null, scope: null, suggested_title: null, normalized_text: null, reasoning: 'x' } },
      ),
    ];
    const m = computeMetrics(pairs);
    expect(m.corpus.confirmed_by_detector).toBe(0);
    expect(m.metrics.joint_precision).toBeNull();
    expect(m.metrics.is_directive_precision).toBeNull();
  });

  it('perfect case: 5/5 all match → 100% across the board', () => {
    const pairs: PairedCandidate[] = [];
    for (let i = 0; i < 5; i++) pairs.push(pair({ candidate_id: `c${i}`, turn_idx: i }, {}, {}));
    const m = computeMetrics(pairs);
    expect(m.corpus.confirmed_by_detector).toBe(5);
    expect(m.metrics.joint_precision).toBe(1);
    expect(m.metrics.is_directive_precision).toBe(1);
    expect(m.metrics.scope_precision_given_correct).toBe(1);
    expect(m.metrics.polarity_precision_given_correct).toBe(1);
  });

  it('scope-miss case: detector says project, labeler says universal', () => {
    const pairs: PairedCandidate[] = [];
    // 10 detector-confirms; 10 labeler is_directive=true; 8 correct scope, 2 wrong
    for (let i = 0; i < 8; i++) pairs.push(pair({ candidate_id: `c${i}`, turn_idx: i }, {}, {}));
    for (let i = 8; i < 10; i++) pairs.push(pair({ candidate_id: `c${i}`, turn_idx: i }, { scope: 'universal' }, {}));
    const m = computeMetrics(pairs);
    expect(m.metrics.is_directive_precision).toBeCloseTo(1.0, 6);
    expect(m.metrics.scope_precision_given_correct).toBeCloseTo(0.8, 6);
    expect(m.metrics.joint_precision).toBeCloseTo(0.8, 6);
  });

  it('false-positive case: detector confirms, labeler disagrees', () => {
    const pairs: PairedCandidate[] = [];
    // 10 detector confirms; 6 match labeler true, 4 are false positives
    for (let i = 0; i < 6; i++) pairs.push(pair({ candidate_id: `c${i}`, turn_idx: i }, {}, {}));
    for (let i = 6; i < 10; i++) pairs.push(pair({ candidate_id: `c${i}`, turn_idx: i }, { is_directive: false, scope: null, polarity: null }, {}));
    const m = computeMetrics(pairs);
    expect(m.metrics.is_directive_precision).toBeCloseTo(0.6, 6);
    expect(m.metrics.joint_precision).toBeCloseTo(0.6, 6);
  });

  it('per-family breakdown sums correctly', () => {
    const pairs = [
      pair({ candidate_id: 'c1', turn_idx: 1, matched_families: ['always_emphasis'] }, {}, {}),
      pair({ candidate_id: 'c2', turn_idx: 2, matched_families: ['always_emphasis'] }, {}, {}),
      pair({ candidate_id: 'c3', turn_idx: 3, matched_families: ['negation_dont'] }, {}, {}),
    ];
    const m = computeMetrics(pairs);
    expect(m.per_regex_family.always_emphasis.candidates).toBe(2);
    expect(m.per_regex_family.always_emphasis.confirmed).toBe(2);
    expect(m.per_regex_family.always_emphasis.joint_correct).toBe(2);
    expect(m.per_regex_family.always_emphasis.rate).toBe(1);
    expect(m.per_regex_family.negation_dont.rate).toBe(1);
  });

  it('confusion matrix counts all four cells', () => {
    const pairs = [
      pair({ candidate_id: 'a', turn_idx: 1 }, {}, {}),                                                                     // TT
      pair({ candidate_id: 'b', turn_idx: 2 }, { is_directive: false, scope: null, polarity: null }, {}),                   // TF
      pair(
        { candidate_id: 'c', turn_idx: 3 },
        {},
        { decision: 'rejected_confirm', confirmation: { is_directive: false, confidence: 0.5, polarity: null, scope: null, suggested_title: null, normalized_text: null, reasoning: '' } },
      ),                                                                                                                     // FT
      pair(
        { candidate_id: 'd', turn_idx: 4 },
        { is_directive: false, scope: null, polarity: null },
        { decision: 'rejected_confirm', confirmation: { is_directive: false, confidence: 0.5, polarity: null, scope: null, suggested_title: null, normalized_text: null, reasoning: '' } },
      ),                                                                                                                     // FF
    ];
    const m = computeMetrics(pairs);
    expect(m.confusion_matrix.detector_true_labeler_true).toBe(1);
    expect(m.confusion_matrix.detector_true_labeler_false).toBe(1);
    expect(m.confusion_matrix.detector_false_labeler_true).toBe(1);
    expect(m.confusion_matrix.detector_false_labeler_false).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown (compare-runs)
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('produces a stable markdown diff for two runs', () => {
    const a = {
      run_id: 'A',
      metrics: {
        joint_precision: 0.84,
        is_directive_precision: 0.92,
        scope_precision_given_correct: 0.90,
        polarity_precision_given_correct: 0.95,
      },
      per_regex_family: {
        always_emphasis: { candidates: 10, confirmed: 8, joint_correct: 6, rate: 0.75 },
        negation_dont:   { candidates: 10, confirmed: 9, joint_correct: 8, rate: 0.89 },
      },
      per_scope: {
        project: { confirmed: 12, joint_correct: 10, rate: 0.83 },
        universal: { confirmed: 3, joint_correct: 3, rate: 1.0 },
      },
      corpus: { candidates: 20, labeled: 20, confirmed_by_detector: 15 },
    };
    const b = {
      run_id: 'B',
      metrics: {
        joint_precision: 0.90,
        is_directive_precision: 0.95,
        scope_precision_given_correct: 0.92,
        polarity_precision_given_correct: 0.96,
      },
      per_regex_family: {
        always_emphasis: { candidates: 10, confirmed: 8, joint_correct: 8, rate: 1.0 },
        negation_dont:   { candidates: 10, confirmed: 9, joint_correct: 8, rate: 0.89 }, // no change
      },
      per_scope: {
        project: { confirmed: 12, joint_correct: 11, rate: 0.917 },
        universal: { confirmed: 3, joint_correct: 3, rate: 1.0 },
      },
      corpus: { candidates: 20, labeled: 20, confirmed_by_detector: 15 },
    };

    const md = renderMarkdown(a, b);
    expect(md).toContain('| joint_precision | 84.0% | 90.0% | +6.0 |');
    expect(md).toContain('| is_directive_precision | 92.0% | 95.0% | +3.0 |');
    // always_emphasis shifted >2pp so it should appear
    expect(md).toContain('| always_emphasis | 75.0% | 100.0% | +25.0 |');
    // negation_dont did NOT shift >2pp — should NOT appear in per-family
    const lines = md.split('\n');
    const familyHdrIdx = lines.findIndex(l => l.startsWith('Per-family'));
    const scopeHdrIdx = lines.findIndex(l => l.startsWith('Per-scope'));
    const familySection = lines.slice(familyHdrIdx, scopeHdrIdx).join('\n');
    expect(familySection).not.toContain('negation_dont');
    // Scope section shows both
    const scopeSection = lines.slice(scopeHdrIdx).join('\n');
    expect(scopeSection).toContain('project');
    expect(scopeSection).toContain('universal');
  });

  it('handles null rates gracefully', () => {
    const a = {
      run_id: 'A',
      metrics: { joint_precision: null, is_directive_precision: null, scope_precision_given_correct: null, polarity_precision_given_correct: null },
      per_regex_family: {},
      per_scope: {},
      corpus: { candidates: 0, labeled: 0, confirmed_by_detector: 0 },
    };
    const b = { ...a, run_id: 'B' };
    const md = renderMarkdown(a, b);
    expect(md).toContain('| joint_precision | n/a | n/a | n/a |');
  });
});
