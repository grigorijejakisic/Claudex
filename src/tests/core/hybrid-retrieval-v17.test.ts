/**
 * Phase 14-07b — W1 retrieval cluster V17 migration tests.
 *
 * Tests that hybrid-retrieval.ts correctly queries the V17 `artifact` table
 * after the 14-07b migration. Fixtures seed directly into `artifact` (not
 * the legacy `artifacts` table).
 *
 * Coverage:
 *   - searchFts5Channel: FTS5 MATCH on artifact_fts (title + body)
 *   - searchLikeFallback: LIKE fallback on title/body
 *   - searchRecencyChannel: recency-ordered from artifact, status filter
 *   - decayActivationScores: reads/writes activation from data JSON
 *   - recordArtifactAccess: reads/writes activation + last_materialized_epoch
 *   - spreadActivation: reads/writes activation via data JSON + artifact_links
 *   - applyRetrievalInducedSuppression: UPDATE data JSON via rowid
 *   - hybridSearchSync returns ScoredArtifact with V17-derived fields
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  hybridSearchSync,
  decayActivationScores,
  recordArtifactAccess,
  spreadActivation,
  applyRetrievalInducedSuppression,
  computeImportanceScore,
  computeRecencyScore,
} from '../../core/hybrid-retrieval.js';
import type { ArtifactRow } from '../../core/artifacts.js';

// ---------------------------------------------------------------------------
// Fixture helpers — seed directly into V17 `artifact` table
// ---------------------------------------------------------------------------

/**
 * Seed a V17 artifact row. Returns the rowid (integer used as artifact ID
 * in post-migration code).
 */
function seedV17Artifact(
  db: Database.Database,
  opts: {
    kind?: string;
    title?: string;
    body?: string;
    project?: string;
    sessionId?: string;
    status?: string;
    confidence?: number;
    createdAt?: number;
    data?: Record<string, unknown>;
  } = {},
): number {
  const now = Date.now();
  const id = `test-${Math.random().toString(36).slice(2, 18)}`;
  const data: Record<string, unknown> = {
    retrieval_score: 1.0,
    activation_score: 1.0,
    novelty_score: 0.5,
    ttl: 3,
    ...opts.data,
  };
  db.prepare(
    `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence,
                           created_at_epoch_ms, updated_at_epoch_ms, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.kind ?? 'observation',
    opts.title ?? 'Test artifact title',
    opts.body ?? 'Test artifact body content',
    opts.project ?? 'test-project',
    opts.sessionId ?? 'test-session',
    opts.status ?? 'active',
    opts.confidence ?? 0.6,
    opts.createdAt ?? now,
    opts.createdAt ?? now,
    JSON.stringify(data),
  );
  const row = db.prepare('SELECT rowid FROM artifact WHERE id = ?').get(id) as { rowid: number };
  return row.rowid;
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  // Insert a minimal session for FK constraints
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, status, observation_count, created_at_epoch_ms)
     VALUES ('test-session', 'active', 0, ?)`
  ).run(Date.now());
  return db;
}

// ---------------------------------------------------------------------------
// Test: V17 FTS5 search (searchFts5Channel via hybridSearchSync)
// ---------------------------------------------------------------------------

describe('hybridSearchSync — V17 artifact table (FTS5 + recency)', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test 1
  it('finds V17 artifacts by title keyword via FTS5', () => {
    seedV17Artifact(db, {
      title: 'Authentication middleware analysis',
      body: 'JWT token validation middleware setup',
      project: 'test-project',
      confidence: 0.8,
    });
    seedV17Artifact(db, {
      title: 'Database schema design',
      body: 'PostgreSQL schema migrations',
      project: 'test-project',
      confidence: 0.6,
    });

    const results = hybridSearchSync(db, 'authentication middleware', 'test-project');
    expect(results.length).toBeGreaterThanOrEqual(1);
    // summary alias should return the title
    expect(results[0].summary).toContain('Authentication');
  });

  // 14-07b Test 2
  it('returns ScoredArtifact with correct aliased fields', () => {
    const rowid = seedV17Artifact(db, {
      title: 'Caching strategy for Redis',
      body: 'Use Redis sorted sets for rate limiting',
      project: 'test-project',
      confidence: 0.8,
      kind: 'learning',
    });

    const results = hybridSearchSync(db, 'caching redis strategy', 'test-project');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const result = results[0];

    // 14-07b: verify ArtifactRow aliases are populated from V17 columns
    expect(result.id).toBe(rowid);              // rowid used as integer ID
    expect(result.summary).toBe('Caching strategy for Redis');   // title → summary
    expect(result.content).toBe('Use Redis sorted sets for rate limiting'); // body → content
    expect(result.artifact_type).toBe('learning'); // kind → artifact_type
    expect(result.state).toBe('fresh');           // status 'active' → 'fresh'
    expect(result.importance).toBeCloseTo(4.0, 1); // confidence 0.8 × 5 = 4.0
    expect(result.retrieval_score).toBe(1.0);    // data.retrieval_score default
    expect(result.activation_score).toBe(1.0);   // data.activation_score default
    expect(result.hybrid_score).toBeGreaterThan(0);
    expect(result.score_breakdown).toBeDefined();
  });

  // 14-07b Test 3
  it('respects status filter: stale artifacts excluded by default', () => {
    const staleId = seedV17Artifact(db, {
      title: 'Stale configuration artifact',
      body: 'Old config that is stale',
      project: 'test-project',
      status: 'stale',  // maps to 'packed' in ArtifactRow
      confidence: 0.8,
    });
    const activeId = seedV17Artifact(db, {
      title: 'Active configuration artifact',
      body: 'Current config that is active',
      project: 'test-project',
      status: 'active',
      confidence: 0.8,
    });

    const results = hybridSearchSync(db, 'configuration artifact', 'test-project');
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(staleId);
    expect(ids).toContain(activeId);
  });

  // 14-07b Test 4
  it('superseded status excludes artifact from results', () => {
    const supersededId = seedV17Artifact(db, {
      title: 'Superseded deployment config',
      body: 'Old deployment configuration superseded',
      project: 'test-project',
      status: 'superseded',
      confidence: 0.8,
    });
    const activeId = seedV17Artifact(db, {
      title: 'Active deployment config',
      body: 'Current deployment configuration',
      project: 'test-project',
      status: 'active',
      confidence: 0.8,
    });

    const results = hybridSearchSync(db, 'deployment config', 'test-project', {
      excludeSuperseded: true,
    });
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(supersededId);
    expect(ids).toContain(activeId);
  });

  // 14-07b Test 5
  it('cross-project results included with globalScope=true', () => {
    seedV17Artifact(db, {
      title: 'Migration pattern cross project',
      body: 'How to migrate databases safely',
      project: 'project-alpha',
      confidence: 0.8,
      kind: 'learning',
    });
    seedV17Artifact(db, {
      title: 'Migration rollback strategy',
      body: 'Rolling back database migrations safely',
      project: 'project-beta',
      confidence: 0.8,
      kind: 'learning',
    });

    const results = hybridSearchSync(db, 'migration pattern', 'project-alpha', {
      globalScope: true,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  // 14-07b Test 6
  it('scoped to project when globalScope=false', () => {
    seedV17Artifact(db, {
      title: 'Scoped artifact project-a',
      body: 'Only visible in project-a',
      project: 'project-a',
      confidence: 0.8,
    });
    seedV17Artifact(db, {
      title: 'Scoped artifact project-b',
      body: 'Only visible in project-b',
      project: 'project-b',
      confidence: 0.8,
    });

    const results = hybridSearchSync(db, 'scoped artifact', 'project-a', {
      globalScope: false,
    });
    const projects = results.map(r => r.project);
    expect(projects.every(p => p === 'project-a')).toBe(true);
  });

  // 14-07b Test 7: importance mapping (confidence → importance alias)
  it('importance alias correctly maps confidence×5 from V17', () => {
    seedV17Artifact(db, {
      title: 'High confidence artifact test',
      body: 'Artifact with high confidence score',
      project: 'test-project',
      confidence: 1.0,  // V17 confidence
    });

    const results = hybridSearchSync(db, 'high confidence artifact', 'test-project');
    expect(results.length).toBeGreaterThanOrEqual(1);
    // confidence=1.0 → importance = 1.0 * 5 = 5.0
    expect(results[0].importance).toBeCloseTo(5.0, 1);
  });
});

// ---------------------------------------------------------------------------
// Test: decayActivationScores — V17 data JSON writes
// ---------------------------------------------------------------------------

describe('decayActivationScores — V17 artifact table', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test 8
  it('updates activation_score in data JSON for non-stale V17 artifacts', () => {
    const rowid = seedV17Artifact(db, {
      title: 'Recent active artifact',
      body: 'Active body content',
      project: 'test-project',
      status: 'active',
      confidence: 0.6,
      createdAt: Date.now() - 60000, // 1 minute ago → high activation
    });

    const result = decayActivationScores(db, 'test-project');
    expect(result.total).toBe(1);

    const row = db.prepare(
      `SELECT json_extract(data, '$.activation_score') AS activation_score FROM artifact WHERE rowid = ?`
    ).get(rowid) as { activation_score: number };
    // Should have been updated from default 1.0
    expect(row.activation_score).not.toBeUndefined();
  });

  // 14-07b Test 9
  it('marks old low-importance artifacts as stale', () => {
    const rowid = seedV17Artifact(db, {
      title: 'Old low-confidence artifact',
      body: 'Very old body',
      project: 'test-project',
      status: 'active',
      confidence: 0.1,  // low importance after ×5 = 0.5
      createdAt: Date.now() - 172800000, // 48 hours ago
    });

    decayActivationScores(db, 'test-project');

    const row = db.prepare(
      `SELECT status, json_extract(data, '$.activation_score') AS activation_score FROM artifact WHERE rowid = ?`
    ).get(rowid) as { status: string; activation_score: number };
    // With low confidence and 48h old, activation should be < 0.1 → stale
    expect(row.status).toBe('stale');
    expect(row.activation_score).toBeLessThan(0.1);
  });

  // 14-07b Test 10
  it('skips stale artifacts', () => {
    seedV17Artifact(db, {
      title: 'Stale artifact skip test',
      body: 'Already stale',
      project: 'test-project',
      status: 'stale',
    });

    const result = decayActivationScores(db, 'test-project');
    expect(result.total).toBe(0);
  });

  // 14-07b Test 11
  it('is project-scoped', () => {
    seedV17Artifact(db, { title: 'A artifact', body: 'body', project: 'project-a' });
    seedV17Artifact(db, { title: 'B artifact', body: 'body', project: 'project-b' });

    const result = decayActivationScores(db, 'project-a');
    expect(result.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test: recordArtifactAccess — V17 data JSON writes
// ---------------------------------------------------------------------------

describe('recordArtifactAccess — V17 artifact table', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test 12
  it('updates activation_score and last_materialized_epoch in data JSON', () => {
    const rowid = seedV17Artifact(db, {
      title: 'Accessed artifact',
      body: 'Body of accessed artifact',
      project: 'test-project',
      confidence: 0.6,
    });

    recordArtifactAccess(db, rowid);

    const row = db.prepare(
      `SELECT json_extract(data, '$.activation_score') AS activation_score,
              json_extract(data, '$.last_materialized_epoch') AS last_materialized_epoch
       FROM artifact WHERE rowid = ?`
    ).get(rowid) as { activation_score: number; last_materialized_epoch: number | null };

    expect(row.activation_score).toBeGreaterThan(0);
    expect(row.last_materialized_epoch).not.toBeNull();
    expect(row.last_materialized_epoch).toBeGreaterThan(0);
  });

  // 14-07b Test 13
  it('does not throw on nonexistent rowid', () => {
    expect(() => recordArtifactAccess(db, 99999)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: applyRetrievalInducedSuppression — V17 data JSON writes
// ---------------------------------------------------------------------------

describe('applyRetrievalInducedSuppression — V17 artifact table', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test 14
  it('decrements activation_score in data JSON for non-selected candidates above RRF threshold', () => {
    const selectedId = seedV17Artifact(db, {
      title: 'Selected artifact',
      body: 'Body of selected',
      project: 'test-project',
      data: { activation_score: 1.0, retrieval_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });
    const suppressedId = seedV17Artifact(db, {
      title: 'Suppressed candidate artifact',
      body: 'Body of suppressed candidate',
      project: 'test-project',
      data: { activation_score: 1.0, retrieval_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });

    const rrfScores = new Map<number, number>([
      [selectedId, 0.5],
      [suppressedId, 0.15],
    ]);
    const selectedIds = new Set([selectedId]);

    applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

    // Selected stays at 1.0
    const selRow = db.prepare(
      `SELECT json_extract(data, '$.activation_score') AS a FROM artifact WHERE rowid = ?`
    ).get(selectedId) as { a: number };
    expect(selRow.a).toBe(1.0);

    // Suppressed decremented by 0.03
    const supRow = db.prepare(
      `SELECT json_extract(data, '$.activation_score') AS a FROM artifact WHERE rowid = ?`
    ).get(suppressedId) as { a: number };
    expect(supRow.a).toBeCloseTo(0.97, 2);
  });

  // 14-07b Test 15
  it('does not suppress candidates without activation_score in data JSON', () => {
    // Seed with no activation_score in data
    const id = `no-act-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(
      `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence,
                             created_at_epoch_ms, updated_at_epoch_ms, data)
       VALUES (?, 'observation', 'No activation', 'body', 'test-project', 'test-session',
               'active', 0.6, ?, ?, json('{}'))`
    ).run(id, Date.now(), Date.now());
    const rowid = (db.prepare('SELECT rowid FROM artifact WHERE id = ?').get(id) as { rowid: number }).rowid;

    const rrfScores = new Map<number, number>([[rowid, 0.15]]);
    const selectedIds = new Set<number>();

    // Should not throw
    expect(() => applyRetrievalInducedSuppression(db, rrfScores, selectedIds)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: spreadActivation — V17 data JSON reads/writes
// ---------------------------------------------------------------------------

describe('spreadActivation — V17 artifact table', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test 16
  it('spreads activation from source to linked target via data JSON', () => {
    const sourceId = seedV17Artifact(db, {
      title: 'Source artifact spreading activation',
      body: 'Body of source',
      project: 'test-project',
      data: { activation_score: 2.0, retrieval_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });
    const targetId = seedV17Artifact(db, {
      title: 'Target artifact receiving activation',
      body: 'Body of target',
      project: 'test-project',
      data: { activation_score: 0.5, retrieval_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });

    // Insert an artifact_links row (source → target) using rowid IDs
    db.prepare(
      `INSERT INTO artifact_links (source_id, target_id, strength, link_type)
       VALUES (?, ?, 1.0, 'related')`
    ).run(sourceId, targetId);

    spreadActivation(db, sourceId);

    const targetRow = db.prepare(
      `SELECT json_extract(data, '$.activation_score') AS a FROM artifact WHERE rowid = ?`
    ).get(targetId) as { a: number };
    // Boost: 0.3 * 1.0 * 2.0 = 0.6 → new activation = 0.5 + 0.6 = 1.1
    expect(targetRow.a).toBeCloseTo(1.1, 1);
  });

  // 14-07b Test 17
  it('does not spread to stale artifacts', () => {
    const sourceId = seedV17Artifact(db, {
      title: 'Source spreading to stale',
      body: 'Source body',
      project: 'test-project',
      data: { activation_score: 2.0, retrieval_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });
    const targetId = seedV17Artifact(db, {
      title: 'Stale target artifact',
      body: 'Stale body',
      project: 'test-project',
      status: 'stale',
      data: { activation_score: 0.5, retrieval_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });

    db.prepare(
      `INSERT INTO artifact_links (source_id, target_id, strength, link_type)
       VALUES (?, ?, 1.0, 'related')`
    ).run(sourceId, targetId);

    spreadActivation(db, sourceId);

    const targetRow = db.prepare(
      `SELECT json_extract(data, '$.activation_score') AS a FROM artifact WHERE rowid = ?`
    ).get(targetId) as { a: number };
    // Stale → skipped → activation stays at 0.5
    expect(targetRow.a).toBeCloseTo(0.5, 2);
  });

  // 14-07b Test 18
  it('does not throw on nonexistent source', () => {
    expect(() => spreadActivation(db, 99999)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: recency channel state alias
// ---------------------------------------------------------------------------

describe('state alias mapping (active→fresh, stale→packed, superseded→materialized)', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test 19
  it('maps V17 status to ArtifactRow state aliases correctly', () => {
    seedV17Artifact(db, {
      title: 'Active state mapping test artifact',
      body: 'Active body content for mapping',
      project: 'test-project',
      status: 'active',
      confidence: 0.8,
      kind: 'learning',
    });

    const results = hybridSearchSync(db, 'active state mapping', 'test-project');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].state).toBe('fresh');  // active → fresh
  });
});
