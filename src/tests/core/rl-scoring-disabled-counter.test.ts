import { describe, it, expect, beforeEach } from 'vitest';
import {
  incrementRlScoringDisabledCounter,
  getRlScoringDisabledCount,
  resetRlScoringDisabledCounter,
} from '../../core/rl-scoring-disabled-counter.js';

describe('rl-scoring-disabled-counter (ABL-01)', () => {
  beforeEach(() => resetRlScoringDisabledCounter());

  it('increments per category', () => {
    incrementRlScoringDisabledCounter('qmultiplier');
    incrementRlScoringDisabledCounter('qmultiplier');
    incrementRlScoringDisabledCounter('memrl-scorer');
    expect(getRlScoringDisabledCount('qmultiplier')).toBe(2);
    expect(getRlScoringDisabledCount('memrl-scorer')).toBe(1);
    expect(getRlScoringDisabledCount('retrieval-rl')).toBe(0);
    expect(getRlScoringDisabledCount('rl-trainer-heartbeat')).toBe(0);
  });

  it('returns total across categories when called without arg', () => {
    incrementRlScoringDisabledCounter('qmultiplier');
    incrementRlScoringDisabledCounter('rl-trainer-heartbeat');
    incrementRlScoringDisabledCounter('memrl-scorer');
    expect(getRlScoringDisabledCount()).toBe(3);
  });

  it('reset clears all categories', () => {
    incrementRlScoringDisabledCounter('qmultiplier');
    incrementRlScoringDisabledCounter('memrl-scorer');
    incrementRlScoringDisabledCounter('retrieval-rl');
    resetRlScoringDisabledCounter();
    expect(getRlScoringDisabledCount()).toBe(0);
    expect(getRlScoringDisabledCount('qmultiplier')).toBe(0);
  });

  it('starts at zero and stays zero with no increments', () => {
    expect(getRlScoringDisabledCount()).toBe(0);
    expect(getRlScoringDisabledCount('qmultiplier')).toBe(0);
  });
});
