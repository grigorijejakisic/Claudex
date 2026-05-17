/**
 * Tests for the V7 unified schema test helper (Phase 14-07b W5).
 *
 * Covers:
 *   - createV17Artifact: inserts a V17 artifact row, returns correct id
 *   - createLegacyArtifact: inserts a legacy artifacts row, returns INTEGER rowid
 *   - migrateFixtureToV17: field-mapping transformation (no DB writes)
 *   - assertV17Shape: accepts valid V17 rows; throws on malformed rows
 *   - runMigrateFixtureToV37: runs the V36→V37 migration on a test DB
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  createV17Artifact,
  createLegacyArtifact,
  migrateFixtureToV17,
  assertV17Shape,
  runMigrateFixtureToV37,
  type V17ArtifactFixture,
  type LegacyArtifactFixture,
} from './v7-unified-schema.js';

// ─── DB setup ─────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ─── createV17Artifact ────────────────────────────────────────────────────────

describe('createV17Artifact', () => {
  it('inserts a V17 artifact row and returns a TEXT id', () => {
    const id = createV17Artifact(db, {
      kind: 'observation',
      project: 'test-project',
      title: 'Test observation',
      body: 'Some content',
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBe(32); // 32-char hex prefix

    const row = db.prepare('SELECT * FROM artifact WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!['kind']).toBe('observation');
    expect(row!['project']).toBe('test-project');
    expect(row!['title']).toBe('Test observation');
    expect(row!['body']).toBe('Some content');
    expect(row!['status']).toBe('active');
  });

  it('uses provided id when supplied', () => {
    const customId = 'a'.repeat(32);
    const returned = createV17Artifact(db, {
      id: customId,
      kind: 'learning',
      project: 'proj',
      title: 'Custom ID test',
    });

    expect(returned).toBe(customId);
    const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(customId);
    expect(row).toBeDefined();
  });

  it('applies default values for optional fields', () => {
    const id = createV17Artifact(db, {
      kind: 'decision',
      project: 'p1',
      title: 'Defaults test',
    });

    const row = db.prepare('SELECT * FROM artifact WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row['status']).toBe('active');
    expect(row['confidence']).toBe(0.6);
    expect(row['session_id']).toBe('test-session');
    expect(row['body']).toBe('');
    expect(row['data']).toBe('{}');
  });

  it('stores data sidecar as JSON', () => {
    const id = createV17Artifact(db, {
      kind: 'observation',
      project: 'p1',
      title: 'With data',
      data: { ttl: 5, activation_score: 1.2 },
    });

    const row = db.prepare('SELECT data FROM artifact WHERE id = ?').get(id) as { data: string };
    const parsed = JSON.parse(row.data);
    expect(parsed['ttl']).toBe(5);
    expect(parsed['activation_score']).toBe(1.2);
  });

  it('is idempotent: double insert returns same id without error', () => {
    const fixture = { kind: 'observation', project: 'p', title: 'idempotent', body: 'b' };
    const id1 = createV17Artifact(db, fixture);
    const id2 = createV17Artifact(db, fixture);
    expect(id1).toBe(id2);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM artifact WHERE id = ?').get(id1) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('generates different ids for different content', () => {
    const id1 = createV17Artifact(db, { kind: 'obs', project: 'p', title: 'A', body: 'body1' });
    const id2 = createV17Artifact(db, { kind: 'obs', project: 'p', title: 'B', body: 'body2' });
    expect(id1).not.toBe(id2);
  });
});

// ─── createLegacyArtifact ─────────────────────────────────────────────────────

describe('createLegacyArtifact', () => {
  it('inserts a legacy artifacts row and returns INTEGER rowid', () => {
    const rowid = createLegacyArtifact(db, {
      summary: 'Legacy test artifact',
      project: 'test-project',
    });

    expect(typeof rowid).toBe('number');
    expect(rowid).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(rowid) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!['summary']).toBe('Legacy test artifact');
    expect(row!['project']).toBe('test-project');
  });

  it('applies default values', () => {
    const rowid = createLegacyArtifact(db, { summary: 'defaults test' });

    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(rowid) as Record<string, unknown>;
    expect(row['artifact_type']).toBe('observation');
    expect(row['state']).toBe('fresh');
    expect(row['ttl']).toBe(3);
    expect(row['importance']).toBe(3);
    expect(row['session_id']).toBe('test-session');
    expect(row['project']).toBe('test-project');
  });

  it('stores all specified fields', () => {
    const fixture: LegacyArtifactFixture = {
      session_id: 'sess-1',
      project: 'proj-x',
      artifact_type: 'learning',
      artifact_ref: 'ref:123',
      summary: 'A learning artifact',
      content: 'Detailed content',
      state: 'packed',
      ttl: 6,
      importance: 5,
    };
    const rowid = createLegacyArtifact(db, fixture);

    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(rowid) as Record<string, unknown>;
    expect(row['session_id']).toBe('sess-1');
    expect(row['artifact_type']).toBe('learning');
    expect(row['state']).toBe('packed');
    expect(row['importance']).toBe(5);
    expect(row['content']).toBe('Detailed content');
  });
});

// ─── migrateFixtureToV17 ──────────────────────────────────────────────────────

describe('migrateFixtureToV17', () => {
  it('maps summary → title and content → body', () => {
    const result = migrateFixtureToV17({
      summary: 'My summary',
      content: 'My body content',
    });
    expect(result.title).toBe('My summary');
    expect(result.body).toBe('My body content');
  });

  it('maps importance (1-5) → confidence (0-1)', () => {
    expect(migrateFixtureToV17({ summary: 'x', importance: 5 }).confidence).toBeCloseTo(1.0);
    expect(migrateFixtureToV17({ summary: 'x', importance: 1 }).confidence).toBeCloseTo(0.2);
    expect(migrateFixtureToV17({ summary: 'x', importance: 3 }).confidence).toBeCloseTo(0.6);
  });

  it('maps state enum: fresh→active, packed→stale, materialized→superseded', () => {
    expect(migrateFixtureToV17({ summary: 'x', state: 'fresh' }).status).toBe('active');
    expect(migrateFixtureToV17({ summary: 'x', state: 'packed' }).status).toBe('stale');
    expect(migrateFixtureToV17({ summary: 'x', state: 'materialized' }).status).toBe('superseded');
  });

  it('maps artifact_type → kind', () => {
    expect(migrateFixtureToV17({ summary: 'x', artifact_type: 'learning' }).kind).toBe('learning');
    expect(migrateFixtureToV17({ summary: 'x', artifact_type: 'decision' }).kind).toBe('decision');
  });

  it('defaults kind to observation when artifact_type is absent', () => {
    expect(migrateFixtureToV17({ summary: 'x' }).kind).toBe('observation');
  });

  it('puts ttl in data sidecar', () => {
    const result = migrateFixtureToV17({ summary: 'x', ttl: 7 });
    expect(result.data?.['ttl']).toBe(7);
  });

  it('derives V17 id from legacy numeric id when provided', () => {
    const result = migrateFixtureToV17({
      id: 42,
      summary: 'with id',
      project: 'p',
      timestamp_epoch_ms: 1000000,
    });
    expect(typeof result.id).toBe('string');
    expect(result.id!.length).toBe(32);
  });

  it('does not set id when no legacy numeric id is present', () => {
    const result = migrateFixtureToV17({ summary: 'no id' });
    expect(result.id).toBeUndefined();
  });

  it('preserves content as empty string when absent', () => {
    const result = migrateFixtureToV17({ summary: 'no content' });
    expect(result.body).toBe('');
  });
});

// ─── assertV17Shape ───────────────────────────────────────────────────────────

describe('assertV17Shape', () => {
  const validRow = {
    id: 'a'.repeat(32),
    kind: 'observation',
    title: 'Test title',
    body: 'body text',
    scope: null,
    status: 'active',
    confidence: 0.8,
    created_at_epoch_ms: Date.now(),
    updated_at_epoch_ms: Date.now(),
    session_id: 'sess-1',
    project: 'proj-1',
    data: '{}',
  };

  it('does not throw for a valid V17 row', () => {
    expect(() => assertV17Shape(validRow)).not.toThrow();
  });

  it('throws when id is empty', () => {
    expect(() => assertV17Shape({ ...validRow, id: '' })).toThrow(/id must be a non-empty string/);
  });

  it('throws when id is too long', () => {
    expect(() => assertV17Shape({ ...validRow, id: 'a'.repeat(65) })).toThrow(/length.*exceeds/);
  });

  it('throws when kind is missing', () => {
    expect(() => assertV17Shape({ ...validRow, kind: '' })).toThrow(/kind/);
  });

  it('throws when body is not a string', () => {
    expect(() => assertV17Shape({ ...validRow, body: null })).toThrow(/body/);
  });

  it('throws when status is invalid', () => {
    expect(() => assertV17Shape({ ...validRow, status: 'fresh' })).toThrow(/status/);
  });

  it('throws when confidence is out of range', () => {
    expect(() => assertV17Shape({ ...validRow, confidence: 1.5 })).toThrow(/confidence/);
    expect(() => assertV17Shape({ ...validRow, confidence: -0.1 })).toThrow(/confidence/);
  });

  it('throws when created_at_epoch_ms is not positive', () => {
    expect(() => assertV17Shape({ ...validRow, created_at_epoch_ms: -1 })).toThrow(/created_at_epoch_ms/);
  });

  it('throws when project is empty', () => {
    expect(() => assertV17Shape({ ...validRow, project: '' })).toThrow(/project/);
  });

  it('throws for null input', () => {
    expect(() => assertV17Shape(null)).toThrow(/expected an object/);
  });
});

// ─── runMigrateFixtureToV37 ───────────────────────────────────────────────────

describe('runMigrateFixtureToV37', () => {
  it('creates artifact_id_map table after running', () => {
    // Seed a legacy artifact so the migration has something to map
    db.prepare(
      `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
       VALUES ('s', 'p', 'observation', 'test', 'fresh', 3, 3)`
    ).run();

    // Run the migration
    runMigrateFixtureToV37(db);

    // artifact_id_map should now exist
    const mapCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='artifact_id_map'`
    ).get() as { n: number }).n;
    expect(mapCount).toBe(1);
  });

  it('populates artifact_id_map and V17 artifact for pre-existing legacy rows', () => {
    // Insert legacy row
    db.prepare(
      `INSERT INTO artifacts (session_id, project, artifact_type, summary, content, state, ttl, importance, timestamp_epoch_ms)
       VALUES ('s', 'proj', 'learning', 'Summary here', 'Body here', 'fresh', 3, 4, 1000000)`
    ).run();

    runMigrateFixtureToV37(db);

    // V17 artifact table should have this row
    const v17Count = (db.prepare('SELECT COUNT(*) AS n FROM artifact').get() as { n: number }).n;
    expect(v17Count).toBeGreaterThan(0);

    // The V17 row should have correct title/body mapping
    const v17Row = db.prepare('SELECT title, body, confidence, status FROM artifact LIMIT 1').get() as Record<string, unknown>;
    expect(v17Row['title']).toBe('Summary here');
    expect(v17Row['body']).toBe('Body here');
    expect((v17Row['confidence'] as number)).toBeCloseTo(0.8); // importance=4 → 4/5=0.8
    expect(v17Row['status']).toBe('active'); // state='fresh' → 'active'
  });

  it('is idempotent — safe to call multiple times', () => {
    runMigrateFixtureToV37(db);
    runMigrateFixtureToV37(db);

    // Should not throw; map table still exists
    const mapCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='artifact_id_map'`
    ).get() as { n: number }).n;
    expect(mapCount).toBe(1);
  });
});
