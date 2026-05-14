import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMethodologyCritiqueGate } from '../../../skills/auto/methodology-critique-gate.js';
import * as wrapper from '../../../skills/auto/cross-family-wrapper.js';

vi.mock('../../../skills/auto/cross-family-wrapper.js', () => ({
  invokeCrossFamily: vi.fn(),
}));

const mockInvoke = vi.mocked(wrapper.invokeCrossFamily);

const planWithArchitectureTag = `---
phase: 12-test
plan: 01
type: execute
wave: 1
tags: [architecture, methodology]
---

## Objective
Measure retrieval improvement via A/B harness.
`;

const planWithoutTriggerTag = `---
phase: 12-test
plan: 02
type: execute
wave: 1
tags: [engineering]
---

## Objective
Fix a bug in routing.
`;

describe('runMethodologyCritiqueGate — trigger detection', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('triggers on architecture/methodology tags', async () => {
    mockInvoke.mockResolvedValue([
      { family: 'gemini', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
      { family: 'codex', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
    ]);
    const result = await runMethodologyCritiqueGate(planWithArchitectureTag);
    expect(result.triggered).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger on engineering-only tags', async () => {
    const result = await runMethodologyCritiqueGate(planWithoutTriggerTag);
    expect(result.triggered).toBe(false);
    expect(result.verdict).toBe('PROCEED');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('triggers on engineering-only plan when force=true', async () => {
    mockInvoke.mockResolvedValue([
      { family: 'gemini', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
    ]);
    const result = await runMethodologyCritiqueGate(planWithoutTriggerTag, { force: true });
    expect(result.triggered).toBe(true);
  });
});

describe('runMethodologyCritiqueGate — verdict routing', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('returns BLOCKED when any family returns BLOCK+critical', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: 'BLOCK',
        severity: 'critical',
        findings: [{ category: 'methodology', summary: 'Pseudoreplication.', evidence: 'same 30 probes' }],
        recommendation: 'Redesign.',
      },
      { family: 'codex', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
    ]);
    const result = await runMethodologyCritiqueGate(planWithArchitectureTag);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.annotation).toContain('BLOCKED');
  });

  it('returns PROCEED when both families SIGNOFF', async () => {
    mockInvoke.mockResolvedValue([
      { family: 'gemini', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
      { family: 'codex', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
    ]);
    const result = await runMethodologyCritiqueGate(planWithArchitectureTag);
    expect(result.verdict).toBe('PROCEED');
    expect(result.annotation).toBeUndefined();
  });

  it('returns PROCEED_WITH_ANNOTATION on FLAG finding', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: 'FLAG',
        severity: 'minor',
        findings: [{ category: 'style', summary: 'Minor concern.', evidence: '' }],
        recommendation: 'Proceed but note.',
      },
      { family: 'codex', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
    ]);
    const result = await runMethodologyCritiqueGate(planWithArchitectureTag);
    expect(result.verdict).toBe('PROCEED_WITH_ANNOTATION');
    expect(result.annotation).toContain('gemini/style');
  });

  it('returns PROCEED_WITH_ANNOTATION when a family is degraded', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: null,
        severity: null,
        findings: [],
        recommendation: '',
        degraded: true,
        reason: 'malformed',
        raw_output: 'bad json',
      },
      { family: 'codex', verdict: 'SIGNOFF', severity: 'none', findings: [], recommendation: 'OK' },
    ]);
    const result = await runMethodologyCritiqueGate(planWithArchitectureTag);
    expect(result.verdict).toBe('PROCEED_WITH_ANNOTATION');
    expect(result.annotation).toContain('degraded');
  });
});
