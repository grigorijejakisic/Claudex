/**
 * Vesna evaluator unit tests — pattern-match + turn-budget.
 */

import { describe, it, expect } from 'vitest';
import { evaluate } from '../../benchmark/vesna/evaluator.js';

const baseExpected = {
  artifact_id_or_pattern: 'decision:x',
  must_surface_within_turns: 2,
  must_contain_phrase_pattern: ['shadowban', 'per-IP'],
};

describe('evaluate', () => {
  it('passes when all phrases match within turn budget', () => {
    const result = evaluate(
      {
        agent_text: 'detected shadowban — per-IP backoff for 15 minutes',
        turns: 1,
        tool_calls: [],
      },
      baseExpected,
    );
    expect(result.passed).toBe(true);
  });

  it('matches case-insensitively', () => {
    const result = evaluate(
      {
        agent_text: 'detected SHADOWBAN — PER-IP backoff',
        turns: 1,
        tool_calls: [],
      },
      baseExpected,
    );
    expect(result.passed).toBe(true);
  });

  it('fails when a required phrase is missing', () => {
    const result = evaluate(
      {
        agent_text: 'detected shadowban — backoff for 15 minutes',
        turns: 1,
        tool_calls: [],
      },
      baseExpected,
    );
    expect(result.passed).toBe(false);
    expect(result.diagnostic).toMatch(/missing required phrase/);
    expect(result.diagnostic).toMatch(/per-IP/);
  });

  it('fails when turns exceed budget', () => {
    const result = evaluate(
      {
        agent_text: 'detected shadowban — per-IP backoff',
        turns: 3,
        tool_calls: [],
      },
      baseExpected,
    );
    expect(result.passed).toBe(false);
    expect(result.diagnostic).toMatch(/turns_taken=3/);
    expect(result.diagnostic).toMatch(/must_surface_within_turns=2/);
  });

  it('supports regex alternation in a single pattern (OR-semantics)', () => {
    const result = evaluate(
      {
        agent_text: 'going in cold — no prior research',
        turns: 1,
        tool_calls: [],
      },
      {
        artifact_id_or_pattern: 'narration',
        must_surface_within_turns: 1,
        must_contain_phrase_pattern: ['no prior experience|going in cold'],
      },
    );
    expect(result.passed).toBe(true);
  });

  it('reports invalid regex without throwing', () => {
    const result = evaluate(
      {
        agent_text: 'anything',
        turns: 1,
        tool_calls: [],
      },
      {
        artifact_id_or_pattern: 'x',
        must_surface_within_turns: 1,
        must_contain_phrase_pattern: ['('], // unbalanced
      },
    );
    expect(result.passed).toBe(false);
    expect(result.diagnostic).toMatch(/invalid regex/);
  });
});
