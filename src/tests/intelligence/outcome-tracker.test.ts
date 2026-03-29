import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { recordOutcome, getPatternEffectiveness, inferOutcomeFromSession } from '../../intelligence/outcome-tracker.js';
import { createPattern } from '../../intelligence/experience-patterns.js';

describe('outcome-tracker', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('records an outcome', () => {
    const id = recordOutcome(db, {
      sessionId: 'sess-1',
      project: 'proj-1',
      patternId: 'pat-1',
      approach: 'used pattern suggestion',
      outcome: 'success',
      impact: 'Tests passed',
    });
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM solution_outcomes WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.outcome).toBe('success');
    expect(row.pattern_id).toBe('pat-1');
  });

  it('records multiple outcomes and computes effectiveness', () => {
    recordOutcome(db, { sessionId: 's1', project: 'p1', patternId: 'pat-1', approach: 'a', outcome: 'success' });
    recordOutcome(db, { sessionId: 's2', project: 'p1', patternId: 'pat-1', approach: 'a', outcome: 'success' });
    recordOutcome(db, { sessionId: 's3', project: 'p1', patternId: 'pat-1', approach: 'a', outcome: 'failure' });

    const eff = getPatternEffectiveness(db, ['pat-1']);
    expect(eff.size).toBe(1);
    const score = eff.get('pat-1')!;
    // Bayesian: (2 successes + 1) / (3 total + 2) = 3/5 = 0.6
    expect(score).toBeCloseTo(0.6, 1);
  });

  it('returns empty map for patterns with no outcomes', () => {
    const eff = getPatternEffectiveness(db, ['nonexistent']);
    expect(eff.size).toBe(0);
  });

  it('infers success when no correction detected', () => {
    const patId = createPattern(db, {
      pattern_type: 'correction',
      trigger_context: 'test trigger for outcome',
      lesson: 'test lesson',
    }, 'sess-1', 'proj-1');

    inferOutcomeFromSession(db, 'sess-1', 'proj-1', [patId], false, true, true);

    const outcomes = db.prepare('SELECT * FROM solution_outcomes WHERE pattern_id = ?').all(patId);
    expect(outcomes.length).toBe(1);
    expect((outcomes[0] as Record<string, unknown>).outcome).toBe('success');
  });

  it('infers failure when correction detected', () => {
    const patId = createPattern(db, {
      pattern_type: 'correction',
      trigger_context: 'another trigger for outcome test',
      lesson: 'another lesson',
    }, 'sess-2', 'proj-1');

    inferOutcomeFromSession(db, 'sess-2', 'proj-1', [patId], true, true, false);

    const outcomes = db.prepare('SELECT * FROM solution_outcomes WHERE pattern_id = ?').all(patId);
    expect(outcomes.length).toBe(1);
    expect((outcomes[0] as Record<string, unknown>).outcome).toBe('failure');
  });
});
