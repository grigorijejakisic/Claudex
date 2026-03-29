import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { computeQValue, getQValueBoosts, applyQValueReranking } from '../../intelligence/retrieval-rl.js';
import { recordOutcome } from '../../intelligence/outcome-tracker.js';

describe('retrieval-rl', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns default Q-value for patterns with no outcomes', () => {
    const q = computeQValue(db, 'nonexistent');
    expect(q).toBe(0.5);
  });

  it('increases Q-value after success outcomes', () => {
    recordOutcome(db, { sessionId: 's1', project: 'p1', patternId: 'pat-1', approach: 'a', outcome: 'success' });
    recordOutcome(db, { sessionId: 's2', project: 'p1', patternId: 'pat-1', approach: 'a', outcome: 'success' });

    const q = computeQValue(db, 'pat-1');
    expect(q).toBeGreaterThan(0.5);
  });

  it('decreases Q-value after failure outcomes', () => {
    recordOutcome(db, { sessionId: 's1', project: 'p1', patternId: 'pat-2', approach: 'a', outcome: 'failure' });
    recordOutcome(db, { sessionId: 's2', project: 'p1', patternId: 'pat-2', approach: 'a', outcome: 'failure' });

    const q = computeQValue(db, 'pat-2');
    expect(q).toBeLessThan(0.5);
  });

  it('computes boosts with UCB exploration', () => {
    recordOutcome(db, { sessionId: 's1', project: 'p1', patternId: 'pat-a', approach: 'a', outcome: 'success' });
    // pat-b has no outcomes — should get max exploration bonus

    const boosts = getQValueBoosts(db, ['pat-a', 'pat-b']);
    expect(boosts.size).toBe(2);
    // pat-b (unseen) should have a boost (exploration bonus for unobserved)
    expect(boosts.get('pat-b')!).toBeGreaterThanOrEqual(0.5);
  });

  it('reranks patterns by Q-value while preserving input structure', () => {
    recordOutcome(db, { sessionId: 's1', project: 'p1', patternId: 'low-q', approach: 'a', outcome: 'failure' });
    recordOutcome(db, { sessionId: 's2', project: 'p1', patternId: 'low-q', approach: 'a', outcome: 'failure' });
    recordOutcome(db, { sessionId: 's3', project: 'p1', patternId: 'high-q', approach: 'a', outcome: 'success' });
    recordOutcome(db, { sessionId: 's4', project: 'p1', patternId: 'high-q', approach: 'a', outcome: 'success' });

    const input = [
      { id: 'low-q', score: 10 },
      { id: 'high-q', score: 8 },
    ];

    const reranked = applyQValueReranking(db, input);
    expect(reranked.length).toBe(2);
    // high-q should be boosted above low-q despite lower base score
    expect(reranked[0].id).toBe('high-q');
  });
});
