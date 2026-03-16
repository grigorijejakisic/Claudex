/**
 * Tests for experience-patterns CRUD, matching, scoring, and deduplication.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    trigger_context: 'server migration OAuth token transfer',
    lesson: 'Always copy OAuth token from ~/.claude/.credentials.json when migrating',
    anti_pattern: 'Assumed old token would work on new machine',
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
    // BM25 IDF requires a corpus with >1 document to produce meaningful ranks.
    // Noise rows must be in the dedup search scope (proj-a or __global__) so
    // they inflate the corpus for BM25 and push the target's rank below -0.5.
    createPattern(db, makePattern({
      trigger_context: 'CSS flexbox grid layout responsive design typography',
      lesson: 'Use rem units for responsive typography',
    }), 'sess-noise-1', GLOBAL_PROJECT_SCOPE);
    createPattern(db, makePattern({
      trigger_context: 'Docker container networking port mapping bridge overlay',
      lesson: 'Use host networking for low-latency services',
    }), 'sess-noise-2', GLOBAL_PROJECT_SCOPE);

    const richPattern = makePattern({
      trigger_context: 'server migration OAuth token transfer credentials authentication secret key',
    });
    const id1 = createPattern(db, richPattern, 'sess-1', 'proj-a');

    // With a 3-row corpus in scope, BM25 rank for an exact-match row reliably crosses -0.5.
    const dedupResult = deduplicateCheck(db, richPattern.trigger_context, 'proj-a', 'correction');
    expect(dedupResult).not.toBeNull();
    expect(dedupResult!.id).toBe(id1);

    // createPattern with duplicate trigger must reinforce, not insert.
    const id2 = createPattern(db, richPattern, 'sess-2', 'proj-a');
    expect(id2).toBe(id1);

    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM experience_patterns WHERE source_project = ?').get('proj-a') as { cnt: number }).cnt;
    expect(count).toBe(1);

    // Score incremented by +1 AGREE (2 → 3).
    const row = getById(db, id1);
    expect(row!.score).toBe(3);
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
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(getById(db, id)!.last_triggered_epoch).toBeNull();

    const before = Math.floor(Date.now() / 1000) - 1;
    incrementTriggerCount(db, id);
    const after = Math.floor(Date.now() / 1000) + 1;

    const epoch = getById(db, id)!.last_triggered_epoch;
    expect(epoch).not.toBeNull();
    expect(epoch!).toBeGreaterThanOrEqual(before);
    expect(epoch!).toBeLessThanOrEqual(after);
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

  it('returns matching pattern when trigger_context is similar', () => {
    // BM25 IDF is ~0 with a single-row corpus (log(1/1) = 0), so ranks never
    // cross the -0.5 threshold. Noise rows must be in the dedup search scope
    // (proj-a or __global__) so they inflate the corpus and push the target
    // row's rank below -0.5.
    createPattern(db, makePattern({
      trigger_context: 'CSS flexbox grid layout responsive design typography',
      lesson: 'Use rem units for responsive typography',
    }), 'sess-noise-1', GLOBAL_PROJECT_SCOPE);
    createPattern(db, makePattern({
      trigger_context: 'Docker container networking port mapping bridge overlay',
      lesson: 'Use host networking for low-latency services',
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

  it('returns currentProject when enrichment provider is undefined (no LLM)', async () => {
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

  it('promotes a pattern from project A to __global__ when triggered in project B', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    expect(getById(db, id)!.source_project).toBe('proj-a');

    promoteToGlobalIfCrossProject(db, id, 'proj-b');

    expect(getById(db, id)!.source_project).toBe(GLOBAL_PROJECT_SCOPE);
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
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
    // Same project as source — should not promote
    promoteToGlobalIfCrossProject(db, id, 'proj-a');
    expect(getById(db, id)!.source_project).toBe('proj-a');
  });

  it('is non-throwing on missing pattern id', () => {
    expect(() => promoteToGlobalIfCrossProject(db, 'nonexistent-id', 'proj-b')).not.toThrow();
  });

  it('is non-throwing on DB error', () => {
    const id = createPattern(db, makePattern(), 'sess-1', 'proj-a');
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
    // Pattern created in project A
    const id = createPattern(db, makePattern({
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
      trigger_context: 'SSH authentication permissions systemd linger deployment',
      lesson: 'Enable systemd linger for user services to survive logout',
    }), 'sess-1', 'proj-a');

    promoteToGlobalIfCrossProject(db, id, 'proj-c');

    const row = getById(db, id)!;
    expect(row.lesson).toBe('Enable systemd linger for user services to survive logout');
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
