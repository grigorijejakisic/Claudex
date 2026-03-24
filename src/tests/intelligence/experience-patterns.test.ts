/**
 * Tests for experience-patterns CRUD, matching, scoring, and deduplication.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { tokenizeQuery } from '../../shared/search-utils.js';
import {
  createPattern,
  findMatchingPatterns,
  updatePatternScore,
  incrementTriggerCount,
  incrementUsefulCount,
  pruneDeadPatterns,
  deduplicateCheck,
  classifyPatternScope,
  promoteToGlobalIfCrossProject,
  generateTopicKey,
  computeConfidence,
  checkMaturityPromotion,
  shouldInvertToWarning,
  getMaturityWeight,
  updatePatternConfidence,
  promotePatternMaturity,
  invertToWarning,
  decayPatternConfidence,
  incrementVerificationCount,
  type ExtractionInput,
  type ExperiencePattern,
} from '../../intelligence/experience-patterns.js';
import { GLOBAL_PROJECT_SCOPE } from '../../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePattern(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    pattern_type: 'correction',
    trigger_context: 'server migration OAuth token transfer credentials authentication',
    lesson: 'Always copy OAuth token from ~/.claude/.credentials.json when migrating servers. The token is machine-specific and must be explicitly transferred during server migration.',
    anti_pattern: 'Assumed old OAuth token would work on new machine without explicit migration transfer',
    severity: 'important',
    ...overrides,
  };
}

function getById(db: TestDatabase, id: string): ExperiencePattern | undefined {
  return db.prepare('SELECT * FROM experience_patterns WHERE id = ?').get(id) as ExperiencePattern | undefined;
}

// ---------------------------------------------------------------------------
// createPattern
// ---------------------------------------------------------------------------

describe('createPattern', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates a pattern with correct defaults (score=2, times_triggered=0)', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(id).toBeTruthy();

    const row = getById(db, id);
    expect(row).toBeDefined();
    expect(row!.score).toBe(2);
    expect(row!.times_triggered).toBe(0);
    expect(row!.times_useful).toBe(0);
    expect(row!.last_triggered_epoch).toBeNull();
  });

  it('generates a ULID-format id (26 chars uppercase alphanumeric)', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('stores all provided fields correctly', () => {
    const input = makePattern({ severity: 'critical', pattern_type: 'behavioral' });
    const id = createPattern(db, input, 'sess-1', 'proj-a');
    const row = getById(db, id);

    expect(row!.pattern_type).toBe('behavioral');
    expect(row!.trigger_context).toBe(input.trigger_context);
    expect(row!.lesson).toBe(input.lesson);
    expect(row!.anti_pattern).toBe(input.anti_pattern);
    expect(row!.severity).toBe('critical');
    expect(row!.source_session).toBe('sess-1');
    expect(row!.source_project).toBe('proj-a');
  });

  it('defaults severity to "important" when not provided', () => {
    const input: ExtractionInput = {
      pattern_type: 'correction',
      trigger_context: 'deploy missing environment variables',
      lesson: 'Check .env.production before deploying',
    };
    const id = createPattern(db, input, 'sess-1', 'proj-a');
    expect(getById(db, id)!.severity).toBe('important');
  });

  it('stores null anti_pattern when not provided', () => {
    const input: ExtractionInput = {
      pattern_type: 'discovery',
      trigger_context: 'FTS5 query with special characters',
      lesson: 'Wrap FTS5 queries in try/catch with LIKE fallback',
    };
    const id = createPattern(db, input, 'sess-1', 'proj-a');
    expect(getById(db, id)!.anti_pattern).toBeNull();
  });

  it('deduplicates: same trigger_context increments score instead of creating new row', () => {
    // Seed noise rows to give FTS5 BM25 a multi-document corpus.
    // Global-scoped patterns use 'discovery' type (only type eligible for global scope).
    createPattern(db, makePattern({
      trigger_context: 'CSS flexbox grid layout responsive design typography',
      lesson: 'Use rem units for responsive typography',
      pattern_type: 'discovery',
    }), 'sess-noise-1', GLOBAL_PROJECT_SCOPE);
    createPattern(db, makePattern({
      trigger_context: 'Docker container networking port mapping bridge overlay',
      lesson: 'Use host networking for low-latency services',
      pattern_type: 'discovery',
    }), 'sess-noise-2', GLOBAL_PROJECT_SCOPE);

    const richPattern = makePattern({
      trigger_context: 'server migration OAuth token transfer credentials authentication secret key',
    });
    const id1 = createPattern(db, richPattern, 'sess-1', 'proj-a');

    // Inserting a duplicate trigger_context returns the existing pattern ID
    const id2 = createPattern(db, richPattern, 'sess-2', 'proj-a');
    expect(id2).toBe(id1);

    // No new row was created — only the original remains
    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM experience_patterns WHERE source_project = ?').get('proj-a') as { cnt: number }).cnt;
    expect(count).toBe(1);

    // Score incremented by +1 AGREE (2 → 3).
    const row = getById(db, id1);
    expect(row!.score).toBe(3);
  });

  it('creates a new row when trigger_context is different', () => {
    const id1 = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth token transfer credentials authentication secret key',
    }), 'sess-1', 'proj-a');

    const id2 = createPattern(db, makePattern({
      trigger_context: 'CSS flexbox grid layout responsive design typography',
    }), 'sess-2', 'proj-a');

    expect(id2).not.toBe(id1);

    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM experience_patterns WHERE source_project = ?').get('proj-a') as { cnt: number }).cnt;
    expect(count).toBe(2);
  });

  it('returns empty string on DB error (non-throwing)', () => {
    db.close();
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(id).toBe('');
    // Reopen for afterEach
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// findMatchingPatterns
// ---------------------------------------------------------------------------

describe('findMatchingPatterns', () => {
  let db: TestDatabase;
  const project = 'proj-a';

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns empty array when no patterns exist', () => {
    const results = findMatchingPatterns(db, 'server migration', project);
    expect(results).toEqual([]);
  });

  it('returns empty array for short/empty prompts', () => {
    createPattern(db, makePattern(), 'sess-1', project);
    expect(findMatchingPatterns(db, '', project)).toEqual([]);
    expect(findMatchingPatterns(db, 'ab', project)).toEqual([]);
  });

  it('matches patterns by FTS5 on trigger_context', () => {
    const id = createPattern(db, makePattern(), 'sess-1', project);
    const results = findMatchingPatterns(db, 'OAuth token migration', project);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(id);
  });

  it('filters out patterns with score < 2', () => {
    const id = createPattern(db, makePattern(), 'sess-1', project);
    // Reduce score below threshold
    updatePatternScore(db, id, -3); // score becomes MAX(0, 2-3) = 0
    const results = findMatchingPatterns(db, 'OAuth token migration', project);
    expect(results).toEqual([]);
  });

  it('caps results at limit (default 3)', () => {
    // Insert 5 patterns with distinct but overlapping keywords
    for (let i = 0; i < 5; i++) {
      createPattern(db, makePattern({
        trigger_context: `server migration token transfer step ${i} OAuth credentials`,
        lesson: `Step ${i} lesson for OAuth migration`,
      }), `sess-${i}`, project);
    }
    const results = findMatchingPatterns(db, 'server migration OAuth token', project);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('respects explicit limit parameter', () => {
    for (let i = 0; i < 4; i++) {
      createPattern(db, makePattern({
        trigger_context: `deploy environment variable missing production server ${i}`,
        lesson: `Lesson ${i} about deploy env vars`,
      }), `sess-${i}`, project);
    }
    const results = findMatchingPatterns(db, 'deploy environment production', project, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('searches current project first, then __global__', () => {
    // Use trigger_contexts that share strong FTS5-matching keywords with the query
    // so both rows are returned and ordering can be verified.
    // O21: Only 'discovery' patterns may be globally scoped — use that type here.
    const globalId = createPattern(db, makePattern({
      trigger_context: 'OAuth token migration credentials server transfer authentication',
      lesson: 'Global OAuth lesson',
      pattern_type: 'discovery',
    }), 'sess-1', GLOBAL_PROJECT_SCOPE);

    const localId = createPattern(db, makePattern({
      trigger_context: 'OAuth token migration credentials server transfer authentication',
      lesson: 'Local OAuth lesson',
    }), 'sess-2', project);

    const results = findMatchingPatterns(db, 'OAuth token migration credentials server transfer', project, 5);
    // Both results MUST appear — the test only has meaning when both are present.
    const localIdx = results.findIndex(r => r.id === localId);
    const globalIdx = results.findIndex(r => r.id === globalId);
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    // Local project result must come before global.
    expect(localIdx).toBeLessThan(globalIdx);
  });

  it('does not return patterns from unrelated projects', () => {
    // Seed a pattern in the expected project so the test query can find it.
    const expectedId = createPattern(db, makePattern({
      trigger_context: 'OAuth token migration credentials transfer completely-unrelated project',
      lesson: 'Lesson for the expected project',
    }), 'sess-0', 'completely-unrelated');

    // Seed a pattern in an excluded project (not global) with matching keywords.
    const excludedId = createPattern(db, makePattern({
      trigger_context: 'OAuth token migration credentials transfer other project',
      lesson: 'Lesson for other project',
    }), 'sess-1', 'other-project');

    const results = findMatchingPatterns(db, 'OAuth token migration credentials transfer', 'completely-unrelated', 5);

    // The expected project's pattern must be present.
    expect(results.some(r => r.id === expectedId)).toBe(true);
    // The excluded project's pattern must NOT appear (not global, not current project).
    expect(results.some(r => r.id === excludedId)).toBe(false);
    // All returned rows must belong to the queried project or __global__.
    expect(results.every(r => r.source_project === 'completely-unrelated' || r.source_project === GLOBAL_PROJECT_SCOPE)).toBe(true);
  });

  it('ranks critical patterns first', () => {
    const importantId = createPattern(db, makePattern({
      trigger_context: 'OAuth token migration important severity credentials',
      lesson: 'Important lesson',
      severity: 'important',
    }), 'sess-1', project);

    const criticalId = createPattern(db, makePattern({
      trigger_context: 'OAuth token migration critical severity credentials',
      lesson: 'Critical lesson',
      severity: 'critical',
    }), 'sess-2', project);

    const results = findMatchingPatterns(db, 'OAuth token migration credentials', project, 5);
    const critIdx = results.findIndex(r => r.id === criticalId);
    const impIdx = results.findIndex(r => r.id === importantId);
    // Both patterns must be present — the ordering assertion is only meaningful when both are found.
    expect(critIdx).toBeGreaterThanOrEqual(0);
    expect(impIdx).toBeGreaterThanOrEqual(0);
    expect(critIdx).toBeLessThan(impIdx);
  });

  it('does not match unrelated prompts', () => {
    createPattern(db, makePattern({
      trigger_context: 'OAuth token server migration SSH credentials',
      lesson: 'OAuth lesson',
    }), 'sess-1', project);

    // Completely unrelated domain
    const results = findMatchingPatterns(db, 'CSS flexbox grid layout responsive design', project);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updatePatternScore
// ---------------------------------------------------------------------------

describe('updatePatternScore', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('increments score by positive delta', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternScore(db, id, 1);
    expect(getById(db, id)!.score).toBe(3);
  });

  it('decrements score by negative delta', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternScore(db, id, -1);
    expect(getById(db, id)!.score).toBe(1);
  });

  it('floors score at 0 — never goes negative', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternScore(db, id, -10);
    expect(getById(db, id)!.score).toBe(0);
  });

  it('is non-throwing on missing id', () => {
    expect(() => updatePatternScore(db, 'nonexistent-id', -1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// incrementTriggerCount
// ---------------------------------------------------------------------------

describe('incrementTriggerCount', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('increments times_triggered', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(getById(db, id)!.times_triggered).toBe(0);

    incrementTriggerCount(db, id);
    expect(getById(db, id)!.times_triggered).toBe(1);

    incrementTriggerCount(db, id);
    expect(getById(db, id)!.times_triggered).toBe(2);
  });

  it('updates last_triggered_epoch', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
      const expectedEpoch = Math.floor(new Date('2026-01-15T12:00:00Z').getTime() / 1000);

      const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
      expect(getById(db, id)!.last_triggered_epoch).toBeNull();

      incrementTriggerCount(db, id);

      const epoch = getById(db, id)!.last_triggered_epoch;
      expect(epoch).not.toBeNull();
      expect(epoch).toBe(expectedEpoch);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is non-throwing on missing id', () => {
    expect(() => incrementTriggerCount(db, 'nonexistent-id')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// incrementUsefulCount
// ---------------------------------------------------------------------------

describe('incrementUsefulCount', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('increments times_useful', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(getById(db, id)!.times_useful).toBe(0);

    incrementUsefulCount(db, id);
    expect(getById(db, id)!.times_useful).toBe(1);

    incrementUsefulCount(db, id);
    expect(getById(db, id)!.times_useful).toBe(2);
  });

  it('is non-throwing on missing id', () => {
    expect(() => incrementUsefulCount(db, 'nonexistent-id')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pruneDeadPatterns
// ---------------------------------------------------------------------------

describe('pruneDeadPatterns', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('removes patterns with score <= 0', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternScore(db, id, -10); // score -> 0

    const removed = pruneDeadPatterns(db);
    expect(removed).toBe(1);
    expect(getById(db, id)).toBeUndefined();
  });

  it('keeps patterns with score > 0', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    // score = 2, above threshold

    const removed = pruneDeadPatterns(db);
    expect(removed).toBe(0);
    expect(getById(db, id)).toBeDefined();
  });

  it('removes only dead patterns, keeps live ones', () => {
    const liveId = createPattern(db, makePattern({
      trigger_context: 'live pattern OAuth credentials migration',
      lesson: 'Live lesson',
    }), 'sess-1', 'proj-a');

    const deadId = createPattern(db, makePattern({
      trigger_context: 'dead pattern deploy environment variables',
      lesson: 'Dead lesson',
    }), 'sess-2', 'proj-a');

    updatePatternScore(db, deadId, -10); // score -> 0

    const removed = pruneDeadPatterns(db);
    expect(removed).toBe(1);
    expect(getById(db, liveId)).toBeDefined();
    expect(getById(db, deadId)).toBeUndefined();
  });

  it('returns count of removed patterns', () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = createPattern(db, makePattern({
        trigger_context: `dead pattern ${i} OAuth migration credentials`,
        lesson: `Lesson ${i}`,
      }), `sess-${i}`, 'proj-a');
      updatePatternScore(db, id, -10);
      ids.push(id);
    }

    const removed = pruneDeadPatterns(db);
    expect(removed).toBe(3);
  });

  it('returns 0 when nothing to prune', () => {
    expect(pruneDeadPatterns(db)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deduplicateCheck
// ---------------------------------------------------------------------------
// Dedup eligibility: initial score is 2, threshold is score >= 2, so newly
// created patterns are immediately eligible for dedup matching. No additional
// validation is required before a pattern participates in dedup checks.
// ---------------------------------------------------------------------------

describe('deduplicateCheck', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('returns null when no patterns exist', () => {
    const result = deduplicateCheck(db, 'OAuth token server migration');
    expect(result).toBeNull();
  });

  it('returns null for very short trigger_context (< 5 chars)', () => {
    createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(deduplicateCheck(db, 'hi')).toBeNull();
    expect(deduplicateCheck(db, '')).toBeNull();
  });

  // NOTE: This test depends on FTS5 BM25 rank behavior (threshold < -0.5).
  // Noise rows are required to give BM25 a multi-document corpus so that IDF
  // produces meaningful (non-zero) ranks. If the SQLite FTS5 tokenizer or BM25
  // weighting changes, this test may need its noise rows or keyword density adjusted.
  it('returns matching pattern when trigger_context is similar (BM25-coupled)', () => {
    // Noise rows give FTS5 BM25 a multi-document corpus for meaningful ranking.
    // Global-scoped patterns use 'discovery' type (only type eligible for global scope).
    createPattern(db, makePattern({
      trigger_context: 'CSS flexbox grid layout responsive design typography',
      lesson: 'Use rem units for responsive typography',
      pattern_type: 'discovery',
    }), 'sess-noise-1', GLOBAL_PROJECT_SCOPE);
    createPattern(db, makePattern({
      trigger_context: 'Docker container networking port mapping bridge overlay',
      lesson: 'Use host networking for low-latency services',
      pattern_type: 'discovery',
    }), 'sess-noise-2', GLOBAL_PROJECT_SCOPE);

    const richTrigger = 'server migration OAuth token transfer credentials authentication secret key';
    const id = createPattern(db, makePattern({ trigger_context: richTrigger }), 'sess-1', 'proj-a');

    const result = deduplicateCheck(db, richTrigger, 'proj-a', 'correction');
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
  });

  it('returns null when no similar pattern exists', () => {
    createPattern(db, makePattern({
      trigger_context: 'OAuth token server migration credentials',
    }), 'sess-1', 'proj-a');

    // Completely unrelated topic should not match
    const result = deduplicateCheck(db, 'CSS grid flexbox responsive layout styling');
    expect(result).toBeNull();
  });

  it('is non-throwing on DB error', () => {
    db.close();
    expect(() => deduplicateCheck(db, 'some trigger context')).not.toThrow();
    const result = deduplicateCheck(db, 'some trigger context');
    expect(result).toBeNull();
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// classifyPatternScope — heuristic tier (no LLM)
// ---------------------------------------------------------------------------

describe('classifyPatternScope (heuristic — no enrichment provider)', () => {
  it('returns currentProject for project-specific content (file paths present)', async () => {
    const pattern: ExtractionInput = {
      pattern_type: 'correction',
      trigger_context: 'editing src/adapters/cc-hooks/stop.ts TypeScript migration',
      lesson: 'Update tsconfig.json when adding new source directories',
      anti_pattern: 'Forgot to update path mapping in tsconfig',
    };
    const result = await classifyPatternScope(pattern, 'my-project', null);
    expect(result).toBe('my-project');
  });

  it('returns GLOBAL_PROJECT_SCOPE for platform/tool knowledge without file paths', async () => {
    const pattern: ExtractionInput = {
      pattern_type: 'correction',
      trigger_context: 'server migration SSH authentication token transfer',
      lesson: 'Always copy OAuth token from credentials file when migrating servers',
      anti_pattern: 'Assumed token would persist across machines',
    };
    const result = await classifyPatternScope(pattern, 'my-project', null);
    expect(result).toBe(GLOBAL_PROJECT_SCOPE);
  });

  it('returns currentProject when no global signal is present', async () => {
    const pattern: ExtractionInput = {
      pattern_type: 'behavioral',
      trigger_context: 'database query returning wrong results after refactor',
      lesson: 'Run integration tests after any schema change',
    };
    const result = await classifyPatternScope(pattern, 'proj-a', null);
    expect(result).toBe('proj-a');
  });

  it('returns currentProject when global signal AND file path signal are both present', async () => {
    const pattern: ExtractionInput = {
      pattern_type: 'correction',
      trigger_context: 'OAuth authentication src/auth.ts token handling',
      lesson: 'Validate token expiry in src/auth.ts before making API calls',
    };
    const result = await classifyPatternScope(pattern, 'proj-b', null);
    // File path signal (src/) overrides global signal (OAuth) → project-scoped
    expect(result).toBe('proj-b');
  });

  it('returns GLOBAL_PROJECT_SCOPE via heuristic fallback when enrichment provider is undefined', async () => {
    // No enrichment provider → skips LLM tier → heuristic detects global signals
    // (docker, deployment, permissions) with no project-specific file paths → global.
    const pattern: ExtractionInput = {
      pattern_type: 'discovery',
      trigger_context: 'docker deployment container permissions',
      lesson: 'Use non-root user in Docker containers for production deployments',
    };
    const result = await classifyPatternScope(pattern, 'proj-c');
    expect(result).toBe(GLOBAL_PROJECT_SCOPE);
  });

  it('is non-throwing — returns currentProject on unexpected input', async () => {
    const pattern: ExtractionInput = {
      pattern_type: 'correction',
      trigger_context: '',
      lesson: '',
    };
    await expect(classifyPatternScope(pattern, 'proj-safe', null)).resolves.toBe('proj-safe');
  });
});

// ---------------------------------------------------------------------------
// promoteToGlobalIfCrossProject
// ---------------------------------------------------------------------------

describe('promoteToGlobalIfCrossProject', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('promotes a discovery pattern from project A to __global__ when triggered in project B', () => {
    const id = createPattern(db, makePattern({ pattern_type: 'discovery' }), 'sess-1', 'proj-a');
    expect(getById(db, id)!.source_project).toBe('proj-a');

    promoteToGlobalIfCrossProject(db, id, 'proj-b');

    expect(getById(db, id)!.source_project).toBe(GLOBAL_PROJECT_SCOPE);
  });

  it('does NOT promote non-discovery patterns (correction/behavioral)', () => {
    const corrId = createPattern(db, makePattern({ pattern_type: 'correction' }), 'sess-1', 'proj-a');
    const behId = createPattern(db, makePattern({ pattern_type: 'behavioral', trigger_context: 'behavioral loop signal' }), 'sess-1', 'proj-a');

    promoteToGlobalIfCrossProject(db, corrId, 'proj-b');
    promoteToGlobalIfCrossProject(db, behId, 'proj-b');

    expect(getById(db, corrId)!.source_project).toBe('proj-a');
    expect(getById(db, behId)!.source_project).toBe('proj-a');
  });

  it('does NOT re-promote a pattern already in __global__', () => {
    // createPattern with __global__ allowed for 'discovery' type
    const id = createPattern(db, makePattern({ pattern_type: 'discovery' }), 'sess-1', GLOBAL_PROJECT_SCOPE);
    expect(getById(db, id)!.source_project).toBe(GLOBAL_PROJECT_SCOPE);

    promoteToGlobalIfCrossProject(db, id, 'proj-x');

    // Must still be __global__ (no double update)
    expect(getById(db, id)!.source_project).toBe(GLOBAL_PROJECT_SCOPE);
  });

  it('does NOT demote a pattern triggered in its own project', () => {
    const id = createPattern(db, makePattern({ pattern_type: 'discovery' }), 'sess-1', 'proj-a');
    // Same project as source — should not promote
    promoteToGlobalIfCrossProject(db, id, 'proj-a');
    expect(getById(db, id)!.source_project).toBe('proj-a');
  });

  it('is non-throwing on missing pattern id', () => {
    expect(() => promoteToGlobalIfCrossProject(db, 'nonexistent-id', 'proj-b')).not.toThrow();
  });

  it('is non-throwing on DB error', () => {
    const id = createPattern(db, makePattern({ pattern_type: 'discovery' }), 'sess-1', 'proj-a');
    db.close();
    expect(() => promoteToGlobalIfCrossProject(db, id, 'proj-b')).not.toThrow();
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// Cross-project matching: create in A, promote, find from B
// ---------------------------------------------------------------------------

describe('cross-project matching after promotion', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('finds a pattern from project B after it is promoted to __global__', () => {
    // Pattern created in project A (discovery type — only discovery can be promoted)
    const id = createPattern(db, makePattern({
      pattern_type: 'discovery',
      trigger_context: 'OAuth token migration credentials server transfer authentication',
      lesson: 'Always transfer OAuth credentials during server migration',
    }), 'sess-1', 'proj-a');

    // Confirm it is scoped to proj-a and not visible from proj-b
    const beforePromotion = findMatchingPatterns(db, 'OAuth token migration credentials', 'proj-b');
    expect(beforePromotion.some(p => p.id === id)).toBe(false);

    // Simulate cross-project trigger: promote to global
    promoteToGlobalIfCrossProject(db, id, 'proj-b');
    expect(getById(db, id)!.source_project).toBe(GLOBAL_PROJECT_SCOPE);

    // Now it should be visible from proj-b via __global__ fallback
    const afterPromotion = findMatchingPatterns(db, 'OAuth token migration credentials', 'proj-b');
    expect(afterPromotion.some(p => p.id === id)).toBe(true);
  });

  it('promoted pattern retains its original lesson and score', () => {
    const id = createPattern(db, makePattern({
      pattern_type: 'discovery',
      trigger_context: 'SSH authentication permissions systemd linger deployment',
      lesson: 'Systemd linger is required for user services to survive logout',
    }), 'sess-1', 'proj-a');

    promoteToGlobalIfCrossProject(db, id, 'proj-c');

    const row = getById(db, id)!;
    expect(row.lesson).toBe('Systemd linger is required for user services to survive logout');
    expect(row.score).toBe(2);
    expect(row.source_project).toBe(GLOBAL_PROJECT_SCOPE);
  });
});

// ---------------------------------------------------------------------------
// generateTopicKey
// ---------------------------------------------------------------------------

describe('generateTopicKey', () => {
  it('returns first 3 significant words (length >= 3) joined by underscore', () => {
    const key = generateTopicKey({
      id: '01ABC',
      trigger_context: 'server migration OAuth token transfer credentials',
    });
    // 'server' (6), 'migration' (9), 'OAuth' (5) — all >= 3, take first 3
    expect(key).toBe('server_migration_oauth');
  });

  it('includes 3-char technical words like SSH, API, key', () => {
    const key = generateTopicKey({
      id: '01ABC',
      trigger_context: 'SSH key auth token',
    });
    // 'SSH' (3, >= 3 — include), 'key' (3, include), 'auth' (4, include) — take first 3
    expect(key).toBe('ssh_key_auth');
  });

  it('falls back to first 8 chars of id when no significant words found (< 3 chars)', () => {
    const key = generateTopicKey({
      id: '01ABCDEFGHIJ',
      trigger_context: 'do it',
    });
    // 'do' (2, skip), 'it' (2, skip) — no words >= 3
    expect(key).toBe('01ABCDEF');
  });

  it('caps at 3 words even when more are available', () => {
    const key = generateTopicKey({
      id: '01ABC',
      trigger_context: 'server migration oauth token transfer credentials session',
    });
    const parts = key.split('_');
    expect(parts.length).toBeLessThanOrEqual(3);
  });

  it('lowercases all words in the key', () => {
    const key = generateTopicKey({
      id: '01ABC',
      trigger_context: 'OAuth TOKEN Server migration',
    });
    expect(key).toBe(key.toLowerCase());
  });

  it('is non-throwing on empty trigger_context', () => {
    expect(() => generateTopicKey({ id: '01ABCDEFGHIJ', trigger_context: '' })).not.toThrow();
    const key = generateTopicKey({ id: '01ABCDEFGHIJ', trigger_context: '' });
    expect(key).toBe('01ABCDEF');
  });
});

// ---------------------------------------------------------------------------
// Topic-aware scoring (Stop hook logic, exercised via updatePatternScore)
// ---------------------------------------------------------------------------

describe('topic-aware scoring', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('penalises only the pattern whose topic overlaps the correction', () => {
    // Pattern A: related to OAuth token migration
    const idA = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth token transfer credentials',
      lesson: 'Always copy OAuth token',
    }), 'sess-1', 'proj-a');

    // Pattern B: unrelated — about CSS layout
    const idB = createPattern(db, makePattern({
      trigger_context: 'flexbox grid layout responsive design columns',
      lesson: 'Use CSS grid for two-dimensional layouts',
    }), 'sess-1', 'proj-a');

    const topicKeyA = generateTopicKey({ id: idA, trigger_context: 'server migration OAuth token transfer credentials' });
    const topicKeyB = generateTopicKey({ id: idB, trigger_context: 'flexbox grid layout responsive design columns' });

    // Simulate correction prompt: mentions OAuth/token — overlaps with A, not B
    const correctionWords = tokenizeQuery('you keep forgetting OAuth token migration credentials').slice(0, 5);

    // Replicate Stop hook per-pattern scoring logic
    const awaitingIds = [idA, idB];
    const awaitingTopicKeys = [topicKeyA, topicKeyB];
    for (let i = 0; i < awaitingIds.length; i++) {
      const patternWords = awaitingTopicKeys[i].split('_').filter(Boolean);
      const hasOverlap = correctionWords.some(w => patternWords.includes(w));
      if (hasOverlap) {
        updatePatternScore(db, awaitingIds[i], -1);
      }
      // else: no penalty, no reward
    }

    // Pattern A penalised (score: 2 → 1); Pattern B untouched (score: 2)
    expect(getById(db, idA)!.score).toBe(1);
    expect(getById(db, idB)!.score).toBe(2);
  });

  it('does not penalise any pattern when correction topic has no overlap', () => {
    const idA = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth token transfer',
      lesson: 'Copy OAuth token during migration',
    }), 'sess-1', 'proj-a');

    const topicKeyA = generateTopicKey({ id: idA, trigger_context: 'server migration OAuth token transfer' });

    // Correction is about something completely unrelated
    const correctionWords = tokenizeQuery('stop using wrong indent style tabs spaces').slice(0, 5);

    const patternWords = topicKeyA.split('_').filter(Boolean);
    const hasOverlap = correctionWords.some(w => patternWords.includes(w));
    if (hasOverlap) {
      updatePatternScore(db, idA, -1);
    }

    // No overlap — score unchanged
    expect(getById(db, idA)!.score).toBe(2);
  });

  it('rewards all patterns when no correction this turn', () => {
    const idA = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth token',
      lesson: 'OAuth migration lesson',
    }), 'sess-1', 'proj-a');

    const idB = createPattern(db, makePattern({
      trigger_context: 'flexbox grid layout columns',
      lesson: 'CSS grid lesson',
    }), 'sess-1', 'proj-a');

    // No correction — reward all
    for (const patternId of [idA, idB]) {
      updatePatternScore(db, patternId, 1);
    }

    expect(getById(db, idA)!.score).toBe(3);
    expect(getById(db, idB)!.score).toBe(3);
  });

  it('penalises all overlapping patterns when correction matches multiple', () => {
    const idA = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth credentials transfer',
      lesson: 'Lesson A',
    }), 'sess-1', 'proj-a');

    const idB = createPattern(db, makePattern({
      trigger_context: 'migration credentials deployment server transfer',
      lesson: 'Lesson B',
    }), 'sess-1', 'proj-a');

    const topicKeyA = generateTopicKey({ id: idA, trigger_context: 'server migration OAuth credentials transfer' });
    const topicKeyB = generateTopicKey({ id: idB, trigger_context: 'migration credentials deployment server transfer' });

    // Correction mentions migration and server — overlaps with both A and B
    const correctionWords = tokenizeQuery('same migration server mistake again credentials').slice(0, 5);

    for (const [id, key] of [[idA, topicKeyA], [idB, topicKeyB]] as [string, string][]) {
      const patternWords = key.split('_').filter(Boolean);
      const hasOverlap = correctionWords.some(w => patternWords.includes(w));
      if (hasOverlap) {
        updatePatternScore(db, id, -1);
      }
    }

    expect(getById(db, idA)!.score).toBe(1);
    expect(getById(db, idB)!.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 15: Pattern Maturity Lifecycle
// ---------------------------------------------------------------------------

describe('computeConfidence (Laplace smoothing)', () => {
  it('returns 0.5 for a new pattern (0 helpful, 0 harmful)', () => {
    expect(computeConfidence(0, 0)).toBe(0.5);
  });

  it('increases with helpful feedback', () => {
    // (3+1)/(3+0+2) = 4/5 = 0.8
    expect(computeConfidence(3, 0)).toBeCloseTo(0.8, 5);
  });

  it('decreases with harmful feedback', () => {
    // (0+1)/(0+3+2) = 1/5 = 0.2
    expect(computeConfidence(0, 3)).toBeCloseTo(0.2, 5);
  });

  it('is symmetric: (1,1) = 0.5', () => {
    // (1+1)/(1+1+2) = 2/4 = 0.5
    expect(computeConfidence(1, 1)).toBe(0.5);
  });

  it('never reaches 0 or 1', () => {
    expect(computeConfidence(100, 0)).toBeLessThan(1);
    expect(computeConfidence(0, 100)).toBeGreaterThan(0);
  });

  it('handles large values correctly', () => {
    // (1000+1)/(1000+0+2) = 1001/1002 ≈ 0.999
    expect(computeConfidence(1000, 0)).toBeCloseTo(0.999, 2);
  });
});

describe('checkMaturityPromotion', () => {
  function makeFullPattern(overrides: Partial<ExperiencePattern> = {}): ExperiencePattern {
    return {
      id: 'test-id',
      pattern_type: 'correction',
      trigger_context: 'test context',
      lesson: 'test lesson',
      anti_pattern: null,
      severity: 'important',
      score: 2,
      times_triggered: 0,
      times_useful: 0,
      source_session: 'sess-1',
      source_project: 'proj-a',
      created_at_epoch: 0,
      last_triggered_epoch: null,
      abstraction_level: 'tip',
      verified: 0,
      verification_count: 0,
      helpful_count: 0,
      harmful_count: 0,
      escalation_level: 'pattern',
      maturity: 'candidate',
      confidence: 0.5,
      ...overrides,
    };
  }

  it('returns null for a fresh candidate pattern', () => {
    expect(checkMaturityPromotion(makeFullPattern())).toBeNull();
  });

  it('promotes candidate → established when times_triggered >= 2', () => {
    expect(checkMaturityPromotion(makeFullPattern({ times_triggered: 2 }))).toBe('established');
    expect(checkMaturityPromotion(makeFullPattern({ times_triggered: 5 }))).toBe('established');
  });

  it('does NOT promote candidate with times_triggered = 1', () => {
    expect(checkMaturityPromotion(makeFullPattern({ times_triggered: 1 }))).toBeNull();
  });

  it('promotes established → proven when helpful >= 3 AND verification >= 2', () => {
    expect(checkMaturityPromotion(makeFullPattern({
      maturity: 'established',
      helpful_count: 3,
      verification_count: 2,
    }))).toBe('proven');
  });

  it('does NOT promote established → proven when helpful < 3', () => {
    expect(checkMaturityPromotion(makeFullPattern({
      maturity: 'established',
      helpful_count: 2,
      verification_count: 2,
    }))).toBeNull();
  });

  it('does NOT promote established → proven when verification < 2', () => {
    expect(checkMaturityPromotion(makeFullPattern({
      maturity: 'established',
      helpful_count: 5,
      verification_count: 1,
    }))).toBeNull();
  });

  it('returns null for already-proven patterns', () => {
    expect(checkMaturityPromotion(makeFullPattern({
      maturity: 'proven',
      times_triggered: 100,
      helpful_count: 50,
      verification_count: 20,
    }))).toBeNull();
  });

  it('handles null maturity gracefully (treats as candidate)', () => {
    expect(checkMaturityPromotion(makeFullPattern({
      maturity: null,
      times_triggered: 3,
    }))).toBe('established');
  });
});

describe('shouldInvertToWarning', () => {
  function makeFullPattern(overrides: Partial<ExperiencePattern> = {}): ExperiencePattern {
    return {
      id: 'test-id',
      pattern_type: 'correction',
      trigger_context: 'test context',
      lesson: 'test lesson',
      anti_pattern: null,
      severity: 'important',
      score: 2,
      times_triggered: 0,
      times_useful: 0,
      source_session: 'sess-1',
      source_project: 'proj-a',
      created_at_epoch: 0,
      last_triggered_epoch: null,
      abstraction_level: 'tip',
      verified: 0,
      verification_count: 0,
      helpful_count: 0,
      harmful_count: 0,
      escalation_level: 'pattern',
      maturity: 'candidate',
      confidence: 0.5,
      ...overrides,
    };
  }

  it('returns false when harmful <= helpful + 3', () => {
    expect(shouldInvertToWarning(makeFullPattern({ helpful_count: 0, harmful_count: 3 }))).toBe(false);
    expect(shouldInvertToWarning(makeFullPattern({ helpful_count: 2, harmful_count: 5 }))).toBe(false);
  });

  it('returns true when harmful > helpful + 3', () => {
    expect(shouldInvertToWarning(makeFullPattern({ helpful_count: 0, harmful_count: 4 }))).toBe(true);
    expect(shouldInvertToWarning(makeFullPattern({ helpful_count: 1, harmful_count: 5 }))).toBe(true);
  });

  it('returns false for equal counts', () => {
    expect(shouldInvertToWarning(makeFullPattern({ helpful_count: 5, harmful_count: 5 }))).toBe(false);
  });
});

describe('getMaturityWeight', () => {
  it('returns 0.5 for candidate', () => {
    expect(getMaturityWeight('candidate')).toBe(0.5);
  });

  it('returns 1.0 for established', () => {
    expect(getMaturityWeight('established')).toBe(1.0);
  });

  it('returns 1.5 for proven', () => {
    expect(getMaturityWeight('proven')).toBe(1.5);
  });

  it('returns 0.5 for null (default to candidate)', () => {
    expect(getMaturityWeight(null)).toBe(0.5);
  });

  it('returns 0.5 for undefined', () => {
    expect(getMaturityWeight(undefined)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Phase 15: DB-backed maturity operations
// ---------------------------------------------------------------------------

describe('updatePatternConfidence', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('updates confidence in the database', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternConfidence(db, id, 0.85);
    const row = getById(db, id)!;
    expect(row.confidence).toBeCloseTo(0.85, 5);
  });

  it('floors confidence at 0.01', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternConfidence(db, id, 0.001);
    const row = getById(db, id)!;
    expect(row.confidence).toBeCloseTo(0.01, 5);
  });

  it('is non-throwing on missing id', () => {
    expect(() => updatePatternConfidence(db, 'nonexistent', 0.5)).not.toThrow();
  });
});

describe('promotePatternMaturity', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('promotes a pattern to established', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    promotePatternMaturity(db, id, 'established');
    const row = getById(db, id)!;
    expect(row.maturity).toBe('established');
  });

  it('promotes a pattern to proven', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    promotePatternMaturity(db, id, 'proven');
    const row = getById(db, id)!;
    expect(row.maturity).toBe('proven');
  });

  it('is non-throwing on missing id', () => {
    expect(() => promotePatternMaturity(db, 'nonexistent', 'proven')).not.toThrow();
  });
});

describe('invertToWarning', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('prepends WARNING prefix and changes type to behavioral', () => {
    const id = createPattern(db, makePattern({
      pattern_type: 'correction',
      lesson: 'Use exact field names from CC payload',
    }), 'sess-1', 'proj-a');

    invertToWarning(db, id);

    const row = getById(db, id)!;
    expect(row.lesson).toBe('WARNING: Avoid this — Use exact field names from CC payload');
    expect(row.pattern_type).toBe('behavioral');
  });

  it('does not double-invert a pattern already prefixed with WARNING', () => {
    const id = createPattern(db, makePattern({
      lesson: 'Use exact field names',
    }), 'sess-1', 'proj-a');

    invertToWarning(db, id);
    const lessonAfterFirst = getById(db, id)!.lesson;

    invertToWarning(db, id);
    const lessonAfterSecond = getById(db, id)!.lesson;

    expect(lessonAfterFirst).toBe(lessonAfterSecond);
  });

  it('is non-throwing on missing id', () => {
    expect(() => invertToWarning(db, 'nonexistent')).not.toThrow();
  });
});

describe('decayPatternConfidence', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('decays confidence for all patterns when no triggered IDs', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    // Default confidence is 0.5
    decayPatternConfidence(db, []);
    const row = getById(db, id)!;
    expect(row.confidence).toBeCloseTo(0.5 * 0.995, 5);
  });

  it('excludes triggered patterns from decay', () => {
    const id1 = createPattern(db, makePattern({
      trigger_context: 'server migration OAuth token transfer pattern one',
    }), 'sess-1', 'proj-a');
    const id2 = createPattern(db, makePattern({
      trigger_context: 'CSS flexbox grid layout responsive design pattern two',
    }), 'sess-2', 'proj-a');

    decayPatternConfidence(db, [id1]);

    // id1 should NOT decay (it was triggered)
    expect(getById(db, id1)!.confidence).toBeCloseTo(0.5, 5);
    // id2 should decay
    expect(getById(db, id2)!.confidence).toBeCloseTo(0.5 * 0.995, 5);
  });

  it('does not decay below 0.01 floor', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternConfidence(db, id, 0.015);
    decayPatternConfidence(db, []);
    const row = getById(db, id)!;
    expect(row.confidence).toBeGreaterThanOrEqual(0.01);
  });

  it('is non-throwing on DB error', () => {
    db.close();
    expect(() => decayPatternConfidence(db, [])).not.toThrow();
    db = createTestDb();
  });
});

// ---------------------------------------------------------------------------
// Phase 15: Harmful multiplier (4×)
// ---------------------------------------------------------------------------

describe('harmful multiplier (4×)', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('harmful feedback drops score by 4 per increment', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    // Initial score = 2
    updatePatternScore(db, id, -4); // harmful: -4 score
    const row = getById(db, id)!;
    expect(row.score).toBe(0); // MAX(0, 2-4) = 0
    expect(row.harmful_count).toBe(1);
  });

  it('helpful feedback increments score by 1', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    updatePatternScore(db, id, 1); // helpful: +1
    expect(getById(db, id)!.score).toBe(3);
    expect(getById(db, id)!.helpful_count).toBe(1);
  });

  it('4× harmful is asymmetric — one harmful outweighs four helpful', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    // +1 four times = score 6, helpful_count 4
    for (let i = 0; i < 4; i++) updatePatternScore(db, id, 1);
    expect(getById(db, id)!.score).toBe(6);

    // -4 once = score 2, harmful_count 1
    updatePatternScore(db, id, -4);
    expect(getById(db, id)!.score).toBe(2);
    expect(getById(db, id)!.harmful_count).toBe(1);
    expect(getById(db, id)!.helpful_count).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Phase 15: Integration — maturity + confidence in pattern creation defaults
// ---------------------------------------------------------------------------

describe('pattern maturity defaults on creation', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('new pattern starts as candidate with confidence 0.5', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    const row = getById(db, id)!;
    expect(row.maturity).toBe('candidate');
    expect(row.confidence).toBeCloseTo(0.5, 5);
  });

  it('full lifecycle: candidate → established → proven', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');

    // Simulate 2 triggers → candidate should promote to established
    incrementTriggerCount(db, id);
    incrementTriggerCount(db, id);
    let row = getById(db, id)!;
    const promo1 = checkMaturityPromotion(row);
    expect(promo1).toBe('established');
    promotePatternMaturity(db, id, promo1!);
    expect(getById(db, id)!.maturity).toBe('established');

    // Simulate 3 helpful + 2 verified → established should promote to proven
    for (let i = 0; i < 3; i++) updatePatternScore(db, id, 1);
    incrementVerificationCount(db, id);
    incrementVerificationCount(db, id);
    row = getById(db, id)!;
    const promo2 = checkMaturityPromotion(row);
    expect(promo2).toBe('proven');
    promotePatternMaturity(db, id, promo2!);
    expect(getById(db, id)!.maturity).toBe('proven');
  });
});
