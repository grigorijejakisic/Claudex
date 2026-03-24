/**
 * Tests for Memory Policy interface, DefaultMemoryPolicy, and policy registry.
 *
 * Covers:
 * - DefaultMemoryPolicy returns correct values for all methods
 * - Policy registry get/set/reset works
 * - Custom policy can override specific methods
 * - Zero behavior change: default policy produces identical results to hard-coded constants
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

import { DefaultMemoryPolicy } from '../../intelligence/default-policy.js';
import {
  DEDUP_COSINE_THRESHOLD,
  NEGATIVE_LEARNING_THRESHOLD,
  MAX_SUPPRESSION,
  SUPPRESSION_STEP,
  MULTIPLIER_FLOOR,
  CLUSTER_COSINE_THRESHOLD,
  PREDICTION_CONFIDENCE_THRESHOLD,
  HARMFUL_MULTIPLIER,
  RIF_MIN_RRF,
  STABILITY_HALF_LIVES,
  HALF_LIVES,
} from '../../intelligence/default-policy.js';
import { getPolicy, setPolicy, resetToDefault } from '../../intelligence/policy-registry.js';
import type {
  MemoryPolicy,
  ObservationCandidate,
  PolicyContext,
  StoreAction,
  ConsolidateAction,
  PatternAction,
} from '../../intelligence/memory-policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    sessionId: 'sess-1',
    project: 'proj-1',
    hourOfDay: 14,
    dayOfWeek: 2,
    hoursSinceLastSession: 1,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<ObservationCandidate> = {}): ObservationCandidate {
  return {
    textToEmbed: 'test observation content',
    sessionId: 'sess-1',
    project: 'proj-1',
    bestMatchScore: 0,
    ...overrides,
  };
}

let db: TestDatabase;

beforeEach(() => {
  db = createTestDb();
  createSession(db, {
    session_id: 'sess-1',
    project: 'proj-1',
    cwd: '/test',
    source: 'test',
  });
  resetToDefault();
});

afterEach(() => {
  resetToDefault();
});

// ---------------------------------------------------------------------------
// DefaultMemoryPolicy — shouldStore
// ---------------------------------------------------------------------------

describe('DefaultMemoryPolicy.shouldStore', () => {
  const policy = new DefaultMemoryPolicy();
  const ctx = makeContext();

  it('returns add when no match (score below threshold)', () => {
    const candidate = makeCandidate({ bestMatchScore: 0.5 });
    const result = policy.shouldStore(candidate, ctx);
    expect(result.action).toBe('add');
  });

  it('returns add when score exactly at threshold', () => {
    const candidate = makeCandidate({ bestMatchScore: 0.85 });
    const result = policy.shouldStore(candidate, ctx);
    expect(result.action).toBe('add');
  });

  it('returns skip for same-session duplicate above threshold', () => {
    const candidate = makeCandidate({
      bestMatchScore: 0.90,
      bestMatchSessionId: 'sess-1',
      bestMatchObsId: 42,
    });
    const result = policy.shouldStore(candidate, ctx);
    expect(result.action).toBe('skip');
  });

  it('returns update for cross-session duplicate above threshold', () => {
    const candidate = makeCandidate({
      bestMatchScore: 0.90,
      bestMatchSessionId: 'sess-2',
      bestMatchObsId: 42,
    });
    const result = policy.shouldStore(candidate, ctx);
    expect(result).toEqual({ action: 'update', targetId: 42 });
  });

  it('returns add if above threshold but no valid obsId (bestMatchObsId = 0)', () => {
    const candidate = makeCandidate({
      bestMatchScore: 0.90,
      bestMatchSessionId: 'sess-2',
      bestMatchObsId: 0,
    });
    const result = policy.shouldStore(candidate, ctx);
    expect(result.action).toBe('add');
  });

  it('returns add if above threshold but no valid obsId (same session)', () => {
    // Even same-session, if obsId is 0, we add (no observation to skip against)
    const candidate = makeCandidate({
      bestMatchScore: 0.90,
      bestMatchSessionId: 'sess-1',
      bestMatchObsId: 0,
    });
    const result = policy.shouldStore(candidate, ctx);
    expect(result.action).toBe('add');
  });

  it('DEDUP_COSINE_THRESHOLD constant is 0.85', () => {
    expect(DEDUP_COSINE_THRESHOLD).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
// DefaultMemoryPolicy — scoreForRetrieval
// ---------------------------------------------------------------------------

describe('DefaultMemoryPolicy.scoreForRetrieval', () => {
  const policy = new DefaultMemoryPolicy();
  const ctx = makeContext();

  function seedArtifact(id: number): void {
    cachedPrepare(db,
      `INSERT INTO artifacts (id, session_id, project, artifact_type, artifact_ref, summary, content, importance)
       VALUES (?, 'sess-1', 'proj-1', 'observation', ?, 'test', 'test', 3)`
    ).run(id, String(id));
  }

  function seedRetrievalEvents(artifactId: number, unreferenced: number, referenced: number): void {
    for (let i = 0; i < unreferenced; i++) {
      cachedPrepare(db,
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'sess-1', 0)`
      ).run(artifactId);
    }
    for (let i = 0; i < referenced; i++) {
      cachedPrepare(db,
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'sess-1', 1)`
      ).run(artifactId);
    }
  }

  it('returns base score when unreferenced < 3', () => {
    seedArtifact(1);
    seedRetrievalEvents(1, 2, 0);
    const result = policy.scoreForRetrieval(1, 1.0, ctx, db);
    expect(result).toBe(1.0);
  });

  it('applies suppression when unreferenced >= 3', () => {
    seedArtifact(2);
    seedRetrievalEvents(2, 3, 0);
    const result = policy.scoreForRetrieval(2, 1.0, ctx, db);
    // suppression = max(-0.5, -0.1 * (3 - 2)) = -0.1
    // multiplier = 1.0 * (1.0 + (-0.1)) = 0.9
    expect(result).toBeCloseTo(0.9, 5);
  });

  it('caps suppression at -0.5', () => {
    seedArtifact(3);
    seedRetrievalEvents(3, 10, 0);
    const result = policy.scoreForRetrieval(3, 1.0, ctx, db);
    // suppression = max(-0.5, -0.1 * (10 - 2)) = max(-0.5, -0.8) = -0.5
    // multiplier = 1.0 * (1.0 + (-0.5)) = 0.5
    expect(result).toBeCloseTo(0.5, 5);
  });

  it('scales suppression by unreferenced ratio when referenced > 0', () => {
    seedArtifact(4);
    seedRetrievalEvents(4, 4, 4);
    const result = policy.scoreForRetrieval(4, 1.0, ctx, db);
    // raw suppression = max(-0.5, -0.1 * (4 - 2)) = -0.2
    // ratio = 4 / (4 + 4) = 0.5
    // scaled suppression = -0.2 * 0.5 = -0.1
    // multiplier = 1.0 * (1.0 + (-0.1)) = 0.9
    expect(result).toBeCloseTo(0.9, 5);
  });

  it('enforces 0.5 floor', () => {
    seedArtifact(5);
    seedRetrievalEvents(5, 10, 0);
    const result = policy.scoreForRetrieval(5, 0.8, ctx, db);
    // suppression = -0.5
    // multiplier = 0.8 * 0.5 = 0.4 → floored to 0.5
    expect(result).toBe(0.5);
  });

  it('constants match', () => {
    expect(NEGATIVE_LEARNING_THRESHOLD).toBe(3);
    expect(MAX_SUPPRESSION).toBe(-0.5);
    expect(SUPPRESSION_STEP).toBe(-0.1);
    expect(MULTIPLIER_FLOOR).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// DefaultMemoryPolicy — shouldConsolidate
// ---------------------------------------------------------------------------

describe('DefaultMemoryPolicy.shouldConsolidate', () => {
  const policy = new DefaultMemoryPolicy();

  it('merges cluster of 3+', () => {
    expect(policy.shouldConsolidate(3, 0.85)).toBe('merge');
    expect(policy.shouldConsolidate(5, 0.9)).toBe('merge');
  });

  it('merges pairs (cluster of 2)', () => {
    expect(policy.shouldConsolidate(2, 0.8)).toBe('merge');
  });

  it('skips singletons', () => {
    expect(policy.shouldConsolidate(1, 0.9)).toBe('skip');
    expect(policy.shouldConsolidate(0, 0.0)).toBe('skip');
  });

  it('CLUSTER_COSINE_THRESHOLD is 0.8', () => {
    expect(CLUSTER_COSINE_THRESHOLD).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// DefaultMemoryPolicy — getPredictionThreshold
// ---------------------------------------------------------------------------

describe('DefaultMemoryPolicy.getPredictionThreshold', () => {
  const policy = new DefaultMemoryPolicy();
  const ctx = makeContext();

  it('returns 0.4', () => {
    expect(policy.getPredictionThreshold(ctx)).toBe(0.4);
  });

  it('PREDICTION_CONFIDENCE_THRESHOLD is 0.4', () => {
    expect(PREDICTION_CONFIDENCE_THRESHOLD).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// DefaultMemoryPolicy — evaluatePattern
// ---------------------------------------------------------------------------

describe('DefaultMemoryPolicy.evaluatePattern', () => {
  const policy = new DefaultMemoryPolicy();

  it('returns promote for candidate with triggered >= 2', () => {
    expect(policy.evaluatePattern(1, 0, 2, 0, 'candidate')).toBe('promote');
  });

  it('returns promote for established with helpful >= 3 and verified >= 2', () => {
    expect(policy.evaluatePattern(3, 0, 5, 2, 'established')).toBe('promote');
  });

  it('returns invert when harmful > helpful + 3', () => {
    expect(policy.evaluatePattern(1, 5, 6, 3, 'established')).toBe('invert');
  });

  it('returns demote when harmful > helpful and harmful >= 2', () => {
    expect(policy.evaluatePattern(1, 3, 4, 1, 'proven')).toBe('demote');
  });

  it('returns keep for balanced pattern', () => {
    expect(policy.evaluatePattern(2, 2, 4, 1, 'established')).toBe('keep');
  });

  it('returns keep for candidate with only 1 trigger', () => {
    expect(policy.evaluatePattern(1, 0, 1, 0, 'candidate')).toBe('keep');
  });

  it('inversion takes priority over demotion', () => {
    // harmful (6) > helpful (1) + 3 -> invert (not demote)
    expect(policy.evaluatePattern(1, 6, 7, 1, 'candidate')).toBe('invert');
  });

  it('HARMFUL_MULTIPLIER is 4', () => {
    expect(HARMFUL_MULTIPLIER).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// DefaultMemoryPolicy — getHalfLife
// ---------------------------------------------------------------------------

describe('DefaultMemoryPolicy.getHalfLife', () => {
  const policy = new DefaultMemoryPolicy();

  it('returns correct transient half-lives', () => {
    expect(policy.getHalfLife('', 1, 'transient')).toBe(3);
    expect(policy.getHalfLife('', 3, 'transient')).toBe(14);
    expect(policy.getHalfLife('', 5, 'transient')).toBe(90);
  });

  it('returns correct standard half-lives', () => {
    expect(policy.getHalfLife('', 1, 'standard')).toBe(7);
    expect(policy.getHalfLife('', 3, 'standard')).toBe(30);
    expect(policy.getHalfLife('', 5, 'standard')).toBe(365);
  });

  it('returns correct stable half-lives', () => {
    expect(policy.getHalfLife('', 1, 'stable')).toBe(14);
    expect(policy.getHalfLife('', 5, 'stable')).toBe(Infinity);
  });

  it('returns Infinity for all permanent half-lives', () => {
    for (let imp = 1; imp <= 5; imp++) {
      expect(policy.getHalfLife('', imp, 'permanent')).toBe(Infinity);
    }
  });

  it('falls back to standard for unknown stability class', () => {
    expect(policy.getHalfLife('', 3, 'unknown')).toBe(30);
  });

  it('matches STABILITY_HALF_LIVES table exactly', () => {
    for (const [stability, table] of Object.entries(STABILITY_HALF_LIVES)) {
      for (const [impStr, expected] of Object.entries(table)) {
        const imp = Number(impStr);
        expect(policy.getHalfLife('', imp, stability)).toBe(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DefaultMemoryPolicy — shouldSuppressCandidate
// ---------------------------------------------------------------------------

describe('DefaultMemoryPolicy.shouldSuppressCandidate', () => {
  const policy = new DefaultMemoryPolicy();

  it('suppresses at RIF_MIN_RRF threshold', () => {
    expect(policy.shouldSuppressCandidate(0.01)).toBe(true);
  });

  it('suppresses above threshold', () => {
    expect(policy.shouldSuppressCandidate(0.05)).toBe(true);
  });

  it('does not suppress below threshold', () => {
    expect(policy.shouldSuppressCandidate(0.005)).toBe(false);
    expect(policy.shouldSuppressCandidate(0)).toBe(false);
  });

  it('RIF_MIN_RRF is 0.01', () => {
    expect(RIF_MIN_RRF).toBe(0.01);
  });
});

// ---------------------------------------------------------------------------
// Policy Registry
// ---------------------------------------------------------------------------

describe('Policy Registry', () => {
  it('getPolicy returns DefaultMemoryPolicy by default', () => {
    const policy = getPolicy();
    expect(policy).toBeInstanceOf(DefaultMemoryPolicy);
  });

  it('setPolicy replaces the active policy', () => {
    const custom = {
      shouldStore: () => ({ action: 'skip' as const, reason: 'custom' }),
      scoreForRetrieval: () => 42,
      shouldConsolidate: () => 'skip' as const,
      getPredictionThreshold: () => 0.9,
      evaluatePattern: () => 'keep' as const,
      getHalfLife: () => 999,
      shouldSuppressCandidate: () => false,
    };
    setPolicy(custom);
    expect(getPolicy()).toBe(custom);
    expect(getPolicy().getPredictionThreshold(makeContext())).toBe(0.9);
  });

  it('resetToDefault restores DefaultMemoryPolicy', () => {
    setPolicy({
      shouldStore: () => ({ action: 'skip' as const, reason: 'custom' }),
      scoreForRetrieval: () => 42,
      shouldConsolidate: () => 'skip' as const,
      getPredictionThreshold: () => 0.9,
      evaluatePattern: () => 'keep' as const,
      getHalfLife: () => 999,
      shouldSuppressCandidate: () => false,
    });
    resetToDefault();
    expect(getPolicy()).toBeInstanceOf(DefaultMemoryPolicy);
    expect(getPolicy().getPredictionThreshold(makeContext())).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// Custom Policy Override
// ---------------------------------------------------------------------------

describe('Custom policy overrides', () => {
  /** Helper to create a custom policy that delegates to DefaultMemoryPolicy for non-overridden methods. */
  function createCustomPolicy(overrides: Partial<MemoryPolicy>): MemoryPolicy {
    const base = new DefaultMemoryPolicy();
    return {
      shouldStore: overrides.shouldStore ?? base.shouldStore.bind(base),
      scoreForRetrieval: overrides.scoreForRetrieval ?? base.scoreForRetrieval.bind(base),
      shouldConsolidate: overrides.shouldConsolidate ?? base.shouldConsolidate.bind(base),
      getPredictionThreshold: overrides.getPredictionThreshold ?? base.getPredictionThreshold.bind(base),
      evaluatePattern: overrides.evaluatePattern ?? base.evaluatePattern.bind(base),
      getHalfLife: overrides.getHalfLife ?? base.getHalfLife.bind(base),
      shouldSuppressCandidate: overrides.shouldSuppressCandidate ?? base.shouldSuppressCandidate.bind(base),
    };
  }

  it('can override shouldStore while keeping other defaults', () => {
    const customPolicy = createCustomPolicy({
      shouldStore: () => ({ action: 'skip', reason: 'always skip' }),
    });
    setPolicy(customPolicy);

    const policy = getPolicy();
    const result = policy.shouldStore(makeCandidate(), makeContext());
    expect(result).toEqual({ action: 'skip', reason: 'always skip' });

    // Other methods still use defaults
    expect(policy.getPredictionThreshold(makeContext())).toBe(0.4);
    expect(policy.shouldSuppressCandidate(0.01)).toBe(true);
    expect(policy.getHalfLife('', 3, 'standard')).toBe(30);
  });

  it('can override prediction threshold for aggressive injection', () => {
    const aggressivePolicy = createCustomPolicy({
      getPredictionThreshold: () => 0.2, // Lower threshold = more aggressive injection
    });
    setPolicy(aggressivePolicy);

    expect(getPolicy().getPredictionThreshold(makeContext())).toBe(0.2);
  });

  it('can override getHalfLife to make everything permanent', () => {
    const permanentPolicy = createCustomPolicy({
      getHalfLife: () => Infinity,
    });
    setPolicy(permanentPolicy);

    expect(getPolicy().getHalfLife('', 1, 'transient')).toBe(Infinity);
  });

  it('can override shouldSuppressCandidate to disable RIF', () => {
    const noRifPolicy = createCustomPolicy({
      shouldSuppressCandidate: () => false,
    });
    setPolicy(noRifPolicy);

    expect(getPolicy().shouldSuppressCandidate(0.05)).toBe(false);
  });
});
