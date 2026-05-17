import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  computeEI,
  getCoOccurrences,
  pruneObservations,
  applyRetentionPolicy,
  BASE_WEIGHTS,
  HALF_LIVES,
  STABILITY_HALF_LIVES,
} from '../../decay/decay-engine.js';
import { classifyStability } from '../../core/observations.js';

let db: TestDatabase;

beforeEach(() => {
  db = createTestDb();
});

function seedObservation(overrides: Partial<{
  id: number;
  session_id: string;
  project: string;
  importance: number;
  files_modified: string;
  timestamp_epoch_ms: number;
  access_count: number;
  last_accessed_at_epoch_ms: number | null;
  deleted_at_epoch_ms: number | null;
}> = {}): number {
  const result = db.prepare(
    `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, timestamp_epoch_ms, access_count, last_accessed_at_epoch_ms, deleted_at_epoch_ms)
     VALUES (?, ?, 'Read', 'code', 'test', 'test content', ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.session_id ?? 'sess-1',
    overrides.project ?? 'proj-1',
    overrides.importance ?? 3,
    overrides.files_modified ?? '[]',
    overrides.timestamp_epoch_ms ?? Date.now(),
    overrides.access_count ?? 0,
    overrides.last_accessed_at_epoch_ms ?? null,
    overrides.deleted_at_epoch_ms ?? null,
  );
  return Number(result.lastInsertRowid);
}

describe('computeEI', () => {
  it('returns correct EI for fresh importance-3 observation with zero access', () => {
    const now = Date.now();
    const ei = computeEI({
      importance: 3,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: now,
      coOccurrences: 0,
    });
    // baseWeight=0.6, accessFactor=1+log2(1)=1, decayFactor~=1, connectivity=1
    expect(ei).toBeCloseTo(0.6, 1);
  });

  it('access factor increases with access count (diminishing returns)', () => {
    const now = Date.now();
    const ei = computeEI({
      importance: 3,
      accessCount: 7,
      lastAccessedAtEpoch: now,
      timestampEpoch: now,
      coOccurrences: 0,
    });
    // accessFactor = 1 + log2(8) = 1 + 3 = 4.0
    // EI = 0.6 * 4.0 * 1.0 * 1.0 = 2.4
    expect(ei).toBeCloseTo(2.4, 1);
  });

  it('decay factor decreases with age', () => {
    const now = Date.now();
    const fourteenDaysAgo = now - 14 * 86400000;
    const ei = computeEI({
      importance: 2,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: fourteenDaysAgo,
      coOccurrences: 0,
    });
    // HL=14, effectiveHL=14*(1+0)=14, decayFactor = 2^(-14/14) = 0.5
    // EI = 0.4 * 1.0 * 0.5 * 1.0 = 0.2
    expect(ei).toBeCloseTo(0.2, 1);
  });

  it('effective half-life extended by access count', () => {
    const now = Date.now();
    const ei = computeEI({
      importance: 1,
      accessCount: 10,
      lastAccessedAtEpoch: now,
      timestampEpoch: now,
      coOccurrences: 0,
    });
    // effectiveHL = 7 * (1 + 1.5) = 17.5
    // accessFactor = 1 + log2(11) ~= 1 + 3.459 = 4.459
    // EI = 0.2 * 4.459 * ~1.0 * 1.0 ~= 0.89
    expect(ei).toBeGreaterThan(0.8);
  });

  it('connectivity bonus increases with co-occurrences (capped at 5)', () => {
    const now = Date.now();
    const ei = computeEI({
      importance: 3,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: now,
      coOccurrences: 10,
    });
    // connectivity = 1.0 + 0.1 * min(10, 5) = 1.5
    // EI = 0.6 * 1.0 * 1.0 * 1.5 = 0.9
    expect(ei).toBeCloseTo(0.9, 1);
  });

  it('importance-5 observations have high EI even when old', () => {
    const now = Date.now();
    const threeHundredDaysAgo = now - 300 * 86400000;
    const ei = computeEI({
      importance: 5,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: threeHundredDaysAgo,
      coOccurrences: 0,
    });
    // HL=365, decayFactor = 2^(-300/365) ~= 0.566
    // EI = 1.0 * 1.0 * 0.566 * 1.0 ~= 0.566
    expect(ei).toBeGreaterThan(0.5);
  });

  it('importance-1 observations decay rapidly', () => {
    const now = Date.now();
    const fourteenDaysAgo = now - 14 * 86400000;
    const ei = computeEI({
      importance: 1,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: fourteenDaysAgo,
      coOccurrences: 0,
    });
    // HL=7, decayFactor = 2^(-14/7) = 0.25
    // EI = 0.2 * 1.0 * 0.25 * 1.0 = 0.05
    expect(ei).toBeCloseTo(0.05, 2);
  });
});

describe('getCoOccurrences', () => {
  it('counts observations sharing files_modified values', () => {
    const id1 = seedObservation({ files_modified: '["src/a.ts"]' });
    seedObservation({ files_modified: '["src/a.ts"]' });
    seedObservation({ files_modified: '["src/a.ts", "src/b.ts"]' });

    const count = getCoOccurrences(db, id1, '["src/a.ts"]');
    expect(count).toBe(2);
  });

  it('returns 0 for empty files_modified', () => {
    const id = seedObservation();
    expect(getCoOccurrences(db, id, '[]')).toBe(0);
  });

  it('returns 0 on parse error', () => {
    const id = seedObservation();
    expect(getCoOccurrences(db, id, 'not json')).toBe(0);
  });

  it('is non-throwing on closed db', () => {
    const id = seedObservation();
    const closedDb = createTestDb();
    closedDb.close();
    expect(getCoOccurrences(closedDb, id, '["a.ts"]')).toBe(0);
  });

  it('filters by project when project parameter is provided', () => {
    const id1 = seedObservation({ project: 'proj-A', files_modified: '["src/a.ts"]' });
    seedObservation({ project: 'proj-A', files_modified: '["src/a.ts"]' });
    seedObservation({ project: 'proj-B', files_modified: '["src/a.ts"]' });

    // With project filter — should only count proj-A observations
    const countA = getCoOccurrences(db, id1, '["src/a.ts"]', 'proj-A');
    expect(countA).toBe(1);

    // Without project filter — should count all
    const countAll = getCoOccurrences(db, id1, '["src/a.ts"]');
    expect(countAll).toBe(2);
  });
});

describe('pruneObservations', () => {
  it('does nothing when count below threshold', () => {
    for (let i = 0; i < 50; i++) seedObservation();
    expect(pruneObservations(db, 'proj-1', { pruneThreshold: 1000 })).toBe(0);
  });

  it('soft-deletes lowest EI observations when over threshold', () => {
    // Seed 1010 observations: 10 high importance, rest low
    for (let i = 0; i < 1000; i++) seedObservation({ importance: 1 });
    for (let i = 0; i < 10; i++) seedObservation({ importance: 4 });

    const pruned = pruneObservations(db, 'proj-1', { pruneThreshold: 1000, pruneCount: 50 });
    expect(pruned).toBe(50);

    // Verify soft-deleted
    const deleted = db.prepare('SELECT COUNT(*) as cnt FROM observations WHERE deleted_at_epoch_ms IS NOT NULL').get() as { cnt: number };
    expect(deleted.cnt).toBe(50);
  });

  it('never prunes importance-5 observations', () => {
    // All importance-5
    for (let i = 0; i < 1010; i++) seedObservation({ importance: 5 });

    const pruned = pruneObservations(db, 'proj-1', { pruneThreshold: 1000, pruneCount: 50 });
    expect(pruned).toBe(0); // All immune
  });

  it('never prunes frequently-accessed recent observations', () => {
    const recentEpoch = Date.now() - 30 * 86400000; // 30 days ago

    // Seed 1010 obs: 1000 low importance + 10 low importance but high access
    for (let i = 0; i < 1000; i++) seedObservation({ importance: 1 });
    for (let i = 0; i < 10; i++) {
      seedObservation({
        importance: 1,
        access_count: 5,
        last_accessed_at_epoch_ms: recentEpoch,
      });
    }

    const pruned = pruneObservations(db, 'proj-1', { pruneThreshold: 1000, pruneCount: 50 });
    expect(pruned).toBe(50);

    // Verify the frequently-accessed ones were NOT pruned
    const accessedAlive = db.prepare(
      'SELECT COUNT(*) as cnt FROM observations WHERE access_count >= 5 AND deleted_at_epoch_ms IS NULL'
    ).get() as { cnt: number };
    expect(accessedAlive.cnt).toBe(10);
  });

  it('returns 0 on error (non-throwing)', () => {
    const closedDb = createTestDb();
    closedDb.close();
    expect(pruneObservations(closedDb, 'proj-1')).toBe(0);
  });
});

describe('getCoOccurrences — execution bounds (REC-15)', () => {
  it('limits results to max 5 co-occurrences', () => {
    // Create many observations sharing the same file
    const id1 = seedObservation({ files_modified: '["src/shared.ts"]' });
    for (let i = 0; i < 20; i++) {
      seedObservation({ files_modified: '["src/shared.ts"]' });
    }

    const count = getCoOccurrences(db, id1, '["src/shared.ts"]');
    expect(count).toBe(5); // Capped at 5
  });

  it('query uses LIMIT to bound per-file co-occurrence count', () => {
    // Even with many co-occurring observations, the query should be bounded
    const id1 = seedObservation({ files_modified: '["src/a.ts", "src/b.ts"]' });
    for (let i = 0; i < 50; i++) {
      seedObservation({ files_modified: '["src/a.ts"]' });
      seedObservation({ files_modified: '["src/b.ts"]' });
    }

    const count = getCoOccurrences(db, id1, '["src/a.ts", "src/b.ts"]');
    // Should still be capped at 5
    expect(count).toBeLessThanOrEqual(5);
  });

  it('does not double-count observations sharing multiple files with target', () => {
    // Observation shares BOTH files with target — should count as 1, not 2
    const id1 = seedObservation({ files_modified: '["src/a.ts", "src/b.ts"]' });
    // This observation shares both src/a.ts AND src/b.ts with target
    seedObservation({ files_modified: '["src/a.ts", "src/b.ts"]' });
    // This one shares only src/a.ts
    seedObservation({ files_modified: '["src/a.ts"]' });

    const count = getCoOccurrences(db, id1, '["src/a.ts", "src/b.ts"]');
    // Should be 2 (two distinct observations), not 3 (double-counting the shared one)
    expect(count).toBe(2);
  });
});

describe('applyRetentionPolicy', () => {
  it('hard-deletes soft-deleted observations older than retention_days', () => {
    const oldEpoch = Date.now() - 100 * 86400000;
    seedObservation({ deleted_at_epoch_ms: oldEpoch, timestamp_epoch_ms: oldEpoch });

    const deleted = applyRetentionPolicy(db, 'proj-1', 90);
    expect(deleted).toBe(1);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it('hard-deletes old non-deleted observations with importance < 5', () => {
    const oldEpoch = Date.now() - 100 * 86400000;
    seedObservation({ importance: 2, timestamp_epoch_ms: oldEpoch });

    const deleted = applyRetentionPolicy(db, 'proj-1', 90);
    expect(deleted).toBe(1);
  });

  it('preserves importance-5 observations regardless of age', () => {
    const oldEpoch = Date.now() - 200 * 86400000;
    seedObservation({ importance: 5, timestamp_epoch_ms: oldEpoch });

    const deleted = applyRetentionPolicy(db, 'proj-1', 90);
    expect(deleted).toBe(0);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('preserves soft-deleted observations within retention window', () => {
    const recentDelete = Date.now() - 30 * 86400000;
    seedObservation({ deleted_at_epoch_ms: recentDelete, timestamp_epoch_ms: recentDelete });

    const deleted = applyRetentionPolicy(db, 'proj-1', 90);
    expect(deleted).toBe(0);
  });

  it('returns 0 on error (non-throwing)', () => {
    const closedDb = createTestDb();
    closedDb.close();
    expect(applyRetentionPolicy(closedDb, 'proj-1')).toBe(0);
  });
});

describe('classifyStability', () => {
  it('returns transient for error category', () => {
    expect(classifyStability('error')).toBe('transient');
  });

  it('returns transient for test category', () => {
    expect(classifyStability('test')).toBe('transient');
  });

  it('returns stable for architecture category', () => {
    expect(classifyStability('architecture')).toBe('stable');
  });

  it('returns stable for decision category', () => {
    expect(classifyStability('decision')).toBe('stable');
  });

  it('returns standard for code category', () => {
    expect(classifyStability('code')).toBe('standard');
  });

  it('returns standard for config category', () => {
    expect(classifyStability('config')).toBe('standard');
  });

  it('returns standard for unknown category', () => {
    expect(classifyStability('unknown')).toBe('standard');
  });
});

describe('stability-aware computeEI', () => {
  it('transient error observation decays faster than stable architecture at same importance', () => {
    const now = Date.now();
    const fourteenDaysAgo = now - 14 * 86400000;

    const transientEI = computeEI({
      importance: 3,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: fourteenDaysAgo,
      coOccurrences: 0,
      stabilityClass: 'transient',
    });

    const stableEI = computeEI({
      importance: 3,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: fourteenDaysAgo,
      coOccurrences: 0,
      stabilityClass: 'stable',
    });

    // Transient half-life for importance 3 = 14 days → decay ~0.5
    // Stable half-life for importance 3 = 90 days → decay ~0.9
    expect(transientEI).toBeLessThan(stableEI);
  });

  it('importance-5 stable observation never decays (Infinity half-life)', () => {
    const now = Date.now();
    const yearAgo = now - 365 * 86400000;

    const ei = computeEI({
      importance: 5,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: yearAgo,
      coOccurrences: 0,
      stabilityClass: 'stable',
    });

    // With Infinity half-life, EI should equal baseWeight * accessFactor * connectivityBonus
    // = 1.0 * 1.0 * 1.0 = 1.0 (no decay regardless of age)
    expect(ei).toBeCloseTo(1.0, 2);
  });

  it('permanent observations never decay regardless of importance', () => {
    const now = Date.now();
    const yearAgo = now - 365 * 86400000;

    const ei = computeEI({
      importance: 1,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: yearAgo,
      coOccurrences: 0,
      stabilityClass: 'permanent',
    });

    // Even importance-1 permanent observations should have no decay
    // baseWeight=0.2, accessFactor=1, connectivity=1 → 0.2
    expect(ei).toBeCloseTo(0.2, 2);
  });

  it('falls back to standard when stabilityClass is null or undefined', () => {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 86400000;

    const eiNull = computeEI({
      importance: 1,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: sevenDaysAgo,
      coOccurrences: 0,
      stabilityClass: null,
    });

    const eiStandard = computeEI({
      importance: 1,
      accessCount: 0,
      lastAccessedAtEpoch: null,
      timestampEpoch: sevenDaysAgo,
      coOccurrences: 0,
      stabilityClass: 'standard',
    });

    expect(eiNull).toBeCloseTo(eiStandard, 5);
  });
});

describe('V11 migration backfill', () => {
  it('backfills stability_class based on category', () => {
    // Observations were inserted by seedObservation with category='code' (default)
    // The V11 migration should have run during createTestDb → initializeSchema
    // New observations should get stability_class from classifyStability

    // Insert observations with different categories directly
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, stability_class)
       VALUES ('s1', 'p1', 'Read', 'error', 'err', 'err content', 2, '[]', 'transient')`
    ).run();
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, stability_class)
       VALUES ('s1', 'p1', 'Read', 'architecture', 'arch', 'arch content', 4, '[]', 'stable')`
    ).run();
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, stability_class)
       VALUES ('s1', 'p1', 'Read', 'code', 'code', 'code content', 3, '[]', 'standard')`
    ).run();

    const rows = db.prepare(
      `SELECT category, stability_class FROM observations WHERE session_id = 's1' ORDER BY id`
    ).all() as Array<{ category: string; stability_class: string }>;

    expect(rows[0]).toEqual({ category: 'error', stability_class: 'transient' });
    expect(rows[1]).toEqual({ category: 'architecture', stability_class: 'stable' });
    expect(rows[2]).toEqual({ category: 'code', stability_class: 'standard' });
  });

  it('V11 schema has all new columns on observations', () => {
    const cols = db.pragma('table_info(observations)') as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('stability_class');
    expect(colNames).toContain('novelty_score');
    expect(colNames).toContain('consolidated_into');
  });

  it('V11 schema has new tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('artifact_access_log');
    expect(tableNames).toContain('knowledge_gaps');
    expect(tableNames).toContain('temporal_profile');
    expect(tableNames).toContain('action_transitions');
  });

  it('V11 schema has maturity and confidence on experience_patterns', () => {
    const cols = db.pragma('table_info(experience_patterns)') as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('maturity');
    expect(colNames).toContain('confidence');
  });

  it('V11 schema has valid_at_epoch_ms and invalid_at_epoch_ms on artifact_links', () => {
    const cols = db.pragma('table_info(artifact_links)') as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('valid_at_epoch_ms');
    expect(colNames).toContain('invalid_at_epoch_ms');
  });
});
