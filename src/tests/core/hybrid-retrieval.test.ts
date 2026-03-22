import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createArtifact } from '../../core/artifacts.js';
import {
  hybridSearchSync,
  computeRecencyScore,
  computeImportanceScore,
  computeThreeFactorScore,
  computeActivation,
  decayActivationScores,
  recordArtifactAccess,
} from '../../core/hybrid-retrieval.js';
import type { ArtifactRow } from '../../core/artifacts.js';

// ---------------------------------------------------------------------------
// Three-factor scoring unit tests
// ---------------------------------------------------------------------------

describe('computeRecencyScore', () => {
  it('returns ~1.0 for very recent artifact', () => {
    const now = Math.floor(Date.now() / 1000);
    const artifact = {
      timestamp_epoch: now - 60, // 1 minute ago
      last_materialized_epoch: null,
    } as ArtifactRow;

    const score = computeRecencyScore(artifact);
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('returns near 0 for old artifact', () => {
    const now = Math.floor(Date.now() / 1000);
    const artifact = {
      timestamp_epoch: now - 86400, // 24 hours ago
      last_materialized_epoch: null,
    } as ArtifactRow;

    const score = computeRecencyScore(artifact);
    expect(score).toBeLessThan(0.01);
  });

  it('uses last_materialized_epoch when available', () => {
    const now = Math.floor(Date.now() / 1000);
    const artifact = {
      timestamp_epoch: now - 86400, // created 24h ago
      last_materialized_epoch: now - 60, // accessed 1 min ago
    } as ArtifactRow;

    const score = computeRecencyScore(artifact);
    expect(score).toBeGreaterThan(0.95); // Should be recent due to access
  });
});

describe('computeImportanceScore', () => {
  it('normalizes importance to 0-1 range', () => {
    expect(computeImportanceScore({ importance: 5 } as ArtifactRow)).toBe(1.0);
    expect(computeImportanceScore({ importance: 3 } as ArtifactRow)).toBe(0.6);
    expect(computeImportanceScore({ importance: 1 } as ArtifactRow)).toBe(0.2);
  });
});

describe('computeThreeFactorScore', () => {
  it('combines recency, importance, and relevance with equal weights', () => {
    const now = Math.floor(Date.now() / 1000);
    const artifact = {
      timestamp_epoch: now - 60,
      last_materialized_epoch: null,
      importance: 5,
    } as ArtifactRow;

    const score = computeThreeFactorScore(artifact, 0.8);
    // All three factors contribute: recency ~1.0, importance 1.0, relevance 0.8
    expect(score).toBeGreaterThan(2.0);
    expect(score).toBeLessThanOrEqual(3.0);
  });

  it('respects custom weights', () => {
    const now = Math.floor(Date.now() / 1000);
    const artifact = {
      timestamp_epoch: now - 60,
      last_materialized_epoch: null,
      importance: 5,
    } as ArtifactRow;

    const defaultScore = computeThreeFactorScore(artifact, 0.5);
    const heavyRelevance = computeThreeFactorScore(artifact, 0.5, {
      alpha: 0.0,
      beta: 0.0,
      gamma: 5.0,
    });

    // With only gamma weight, score should be 5.0 * 0.5 = 2.5
    expect(heavyRelevance).toBeCloseTo(2.5, 1);
    // Heavy relevance weighting should differ from equal-weight default
    expect(heavyRelevance).toBeGreaterThan(defaultScore);
  });
});

// ---------------------------------------------------------------------------
// ACT-R activation tests
// ---------------------------------------------------------------------------

describe('computeActivation', () => {
  it('returns positive activation for recent artifact', () => {
    const now = Math.floor(Date.now() / 1000);
    const artifact = {
      timestamp_epoch: now - 60,
      last_materialized_epoch: null,
      importance: 3,
      state: 'fresh',
    } as ArtifactRow;

    const activation = computeActivation(artifact);
    expect(activation).toBeGreaterThan(0);
  });

  it('returns higher activation for higher importance', () => {
    const now = Math.floor(Date.now() / 1000);
    const lowImp = {
      timestamp_epoch: now - 3600,
      last_materialized_epoch: null,
      importance: 1,
      state: 'fresh',
    } as ArtifactRow;

    const highImp = {
      timestamp_epoch: now - 3600,
      last_materialized_epoch: null,
      importance: 5,
      state: 'fresh',
    } as ArtifactRow;

    expect(computeActivation(highImp)).toBeGreaterThan(computeActivation(lowImp));
  });

  it('returns higher activation for materialized artifacts', () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = {
      timestamp_epoch: now - 3600,
      last_materialized_epoch: null,
      importance: 3,
      state: 'fresh',
    } as ArtifactRow;

    const materialized = {
      timestamp_epoch: now - 3600,
      last_materialized_epoch: now - 60,
      importance: 3,
      state: 'materialized',
    } as ArtifactRow;

    expect(computeActivation(materialized)).toBeGreaterThan(computeActivation(fresh));
  });
});

describe('decayActivationScores', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('updates activation scores for non-packed artifacts', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Test obs', 'some content', 3);

    const result = decayActivationScores(db, 'myproject');
    expect(result.total).toBe(1);

    const rows = db.prepare('SELECT activation_score FROM artifacts WHERE project = ?')
      .all('myproject') as Array<{ activation_score: number }>;
    expect(rows[0].activation_score).not.toBe(1.0); // Should have been updated
  });

  it('packs artifacts below activation threshold', () => {
    // Create artifact with old timestamp to ensure low activation
    const id = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Old obs', 'old content', 1);

    // Set timestamp to 48 hours ago — very old, low importance
    const oldTime = Math.floor(Date.now() / 1000) - 172800;
    db.prepare('UPDATE artifacts SET timestamp_epoch = ? WHERE id = ?').run(oldTime, id);

    const result = decayActivationScores(db, 'myproject');

    // With importance=1 and 48h old, activation should be < 0.1
    const rows = db.prepare('SELECT state, activation_score FROM artifacts WHERE id = ?')
      .all(id) as Array<{ state: string; activation_score: number }>;

    // Should be packed due to low activation
    expect(rows[0].state).toBe('packed');
    expect(rows[0].activation_score).toBeLessThan(0.1);
  });

  it('is project-scoped', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null, 'A obs', 'content a', 3);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null, 'B obs', 'content b', 3);

    const result = decayActivationScores(db, 'project-a');
    expect(result.total).toBe(1);
  });

  it('does not affect already packed artifacts', () => {
    const id = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Packed', 'content', 3);
    db.prepare("UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?").run(id);

    const result = decayActivationScores(db, 'myproject');
    expect(result.total).toBe(0);
    expect(result.packed).toBe(0);
  });

  it('returns zeros on empty project', () => {
    const result = decayActivationScores(db, 'nonexistent');
    expect(result.total).toBe(0);
    expect(result.packed).toBe(0);
  });
});

describe('recordArtifactAccess', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('updates activation score and last_materialized_epoch', () => {
    const id = createArtifact(db, 'sess-1', 'myproject', 'observation', null, 'Test', 'content', 3);

    recordArtifactAccess(db, id);

    const row = db.prepare('SELECT activation_score, last_materialized_epoch FROM artifacts WHERE id = ?')
      .get(id) as { activation_score: number; last_materialized_epoch: number | null };

    expect(row.activation_score).toBeGreaterThan(0);
    expect(row.last_materialized_epoch).not.toBeNull();
  });

  it('does not throw on nonexistent artifact', () => {
    // Should not throw
    recordArtifactAccess(db, 99999);
  });
});

// ---------------------------------------------------------------------------
// Hybrid search integration tests
// ---------------------------------------------------------------------------

describe('hybridSearchSync', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty for short queries', () => {
    const results = hybridSearchSync(db, 'ab', 'myproject');
    expect(results).toHaveLength(0);
  });

  it('returns empty for empty query', () => {
    const results = hybridSearchSync(db, '', 'myproject');
    expect(results).toHaveLength(0);
  });

  it('finds artifacts by keyword match', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null,
      'Authentication middleware analysis', 'JWT token validation in Express', 4);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null,
      'Database schema choice', 'PostgreSQL for main storage', 3);

    const results = hybridSearchSync(db, 'authentication middleware', 'myproject');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].summary).toContain('Authentication');
  });

  it('returns scored artifacts with hybrid_score', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null,
      'Docker container configuration', 'Dockerfile for Node.js app', 4);

    const results = hybridSearchSync(db, 'docker container', 'myproject');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].hybrid_score).toBeGreaterThan(0);
    expect(results[0].score_breakdown).toBeDefined();
  });

  it('ranks higher importance artifacts above lower', () => {
    createArtifact(db, 'sess-1', 'myproject', 'observation', null,
      'Server deployment analysis', 'Deploy server to AWS', 2);
    createArtifact(db, 'sess-1', 'myproject', 'decision', null,
      'Server architecture decision', 'Microservices server pattern', 5);

    const results = hybridSearchSync(db, 'server deployment architecture', 'myproject');
    if (results.length >= 2) {
      // Higher importance should tend to rank higher
      expect(results[0].importance).toBeGreaterThanOrEqual(results[1].importance);
    }
  });

  it('respects limit option', () => {
    for (let i = 0; i < 10; i++) {
      createArtifact(db, 'sess-1', 'myproject', 'observation', null,
        `Testing analysis ${i}`, `Test content ${i}`, 3);
    }

    const results = hybridSearchSync(db, 'testing analysis', 'myproject', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('excludes superseded artifacts by default', () => {
    const id1 = createArtifact(db, 'sess-1', 'myproject', 'observation', null,
      'API endpoint analysis v1', 'Old API version', 4);
    const id2 = createArtifact(db, 'sess-1', 'myproject', 'observation', null,
      'API endpoint analysis v2', 'New API version', 4);

    // Flag id1 as superseded by id2
    db.prepare('UPDATE artifacts SET superseded_by = ? WHERE id = ?').run(id2, id1);

    const results = hybridSearchSync(db, 'API endpoint analysis', 'myproject');
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(id1);
    expect(ids).toContain(id2);
  });

  it('includes superseded artifacts when excludeSuperseded=false', () => {
    const id1 = createArtifact(db, 'sess-1', 'myproject', 'observation', null,
      'Config analysis v1', 'Old config', 4);
    const id2 = createArtifact(db, 'sess-1', 'myproject', 'observation', null,
      'Config analysis v2', 'New config', 4);

    db.prepare('UPDATE artifacts SET superseded_by = ? WHERE id = ?').run(id2, id1);

    const results = hybridSearchSync(db, 'config analysis', 'myproject', {
      excludeSuperseded: false,
    });
    const ids = results.map(r => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it('includes cross-project results with globalScope', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null,
      'Caching strategy analysis', 'Redis caching pattern', 4);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null,
      'Caching layer implementation', 'Memcached setup', 4);

    const results = hybridSearchSync(db, 'caching strategy', 'project-a', {
      globalScope: true,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('scopes to project with globalScope=false', () => {
    createArtifact(db, 'sess-1', 'project-a', 'observation', null,
      'Migration plan analysis', 'Database migration', 4);
    createArtifact(db, 'sess-1', 'project-b', 'observation', null,
      'Migration script review', 'SQL migration', 4);

    const results = hybridSearchSync(db, 'migration plan', 'project-a', {
      globalScope: false,
    });
    const projects = results.map(r => r.project);
    expect(projects.every(p => p === 'project-a')).toBe(true);
  });

  it('returns empty when no artifacts exist for project', () => {
    // No artifacts in this project at all — both FTS5 and recency channels return nothing
    const results = hybridSearchSync(db, 'some query text', 'empty-project');
    expect(results).toHaveLength(0);
  });

  it('is non-throwing on any error', () => {
    // Closed database should not throw
    const closedDb = createTestDb();
    closedDb.close();

    const results = hybridSearchSync(closedDb, 'test query', 'myproject');
    expect(results).toHaveLength(0);
  });
});
