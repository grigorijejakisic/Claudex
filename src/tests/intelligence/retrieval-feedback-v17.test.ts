/**
 * Phase 14-07b — W1 retrieval cluster: retrieval-feedback.ts V17 migration tests.
 *
 * Tests that retrieval-feedback.ts correctly queries/writes the V17 `artifact`
 * table after the 14-07b migration. Fixtures seed directly into `artifact`.
 *
 * Coverage:
 *   - updateRetrievalScore: reads/writes retrieval_score in data JSON
 *   - getRetrievalScoreMultiplier: reads retrieval_score from V17 data JSON
 *   - penalizeUnreferencedArtifacts: JOINs against V17 artifact via rowid
 *   - recordWasReferenced: reads title (as summary) from V17 artifact
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  updateRetrievalScore,
  getRetrievalScoreMultiplier,
  recordWasReferenced,
  penalizeUnreferencedArtifacts,
} from '../../intelligence/retrieval-feedback.js';

// ---------------------------------------------------------------------------
// Fixture helpers — seed directly into V17 `artifact` table
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, status, observation_count, created_at_epoch_ms)
     VALUES ('test-sess', 'active', 0, ?)`
  ).run(Date.now());
  return db;
}

function seedV17Artifact(
  db: Database.Database,
  opts: {
    title?: string;
    body?: string;
    project?: string;
    kind?: string;
    status?: string;
    confidence?: number;
    data?: Record<string, unknown>;
  } = {},
): number {
  const now = Date.now();
  const id = `rf-test-${Math.random().toString(36).slice(2, 18)}`;
  const data = {
    retrieval_score: 1.0,
    activation_score: 1.0,
    novelty_score: 0.5,
    ttl: 3,
    ...opts.data,
  };
  db.prepare(
    `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence,
                           created_at_epoch_ms, updated_at_epoch_ms, data)
     VALUES (?, ?, ?, ?, ?, 'test-sess', ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.kind ?? 'learning',
    opts.title ?? 'Test artifact',
    opts.body ?? 'Test artifact body',
    opts.project ?? 'test-project',
    opts.status ?? 'active',
    opts.confidence ?? 0.6,
    now,
    now,
    JSON.stringify(data),
  );
  const row = db.prepare('SELECT rowid FROM artifact WHERE id = ?').get(id) as { rowid: number };
  return row.rowid;
}

function getRetrievalScore(db: Database.Database, rowid: number): number {
  const row = db.prepare(
    `SELECT COALESCE(json_extract(data, '$.retrieval_score'), 1.0) AS rs FROM artifact WHERE rowid = ?`
  ).get(rowid) as { rs: number };
  return row.rs;
}

// ---------------------------------------------------------------------------
// Tests: updateRetrievalScore — reads/writes data JSON
// ---------------------------------------------------------------------------

describe('updateRetrievalScore — V17 artifact data JSON', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test RF-1
  it('increases retrieval_score on positive signal', () => {
    const rowid = seedV17Artifact(db, { data: { retrieval_score: 1.0 } });
    const before = getRetrievalScore(db, rowid);

    updateRetrievalScore(db, rowid, 0.1);

    const after = getRetrievalScore(db, rowid);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(1.1, 2);
  });

  // 14-07b Test RF-2
  it('decreases retrieval_score on negative signal', () => {
    const rowid = seedV17Artifact(db, { data: { retrieval_score: 1.0 } });
    const before = getRetrievalScore(db, rowid);

    updateRetrievalScore(db, rowid, -0.2);

    const after = getRetrievalScore(db, rowid);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(0.8, 2);
  });

  // 14-07b Test RF-3
  it('clamps retrieval_score to [0.1, 3.0]', () => {
    const rowid = seedV17Artifact(db, { data: { retrieval_score: 1.0 } });

    // Repeatedly apply negative signal
    for (let i = 0; i < 50; i++) updateRetrievalScore(db, rowid, -1.0);
    expect(getRetrievalScore(db, rowid)).toBeGreaterThanOrEqual(0.1);

    // Repeatedly apply positive signal
    for (let i = 0; i < 50; i++) updateRetrievalScore(db, rowid, 1.0);
    expect(getRetrievalScore(db, rowid)).toBeLessThanOrEqual(3.0);
  });

  // 14-07b Test RF-4
  it('is a no-op for nonexistent rowid', () => {
    expect(() => updateRetrievalScore(db, 99999, 0.1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: getRetrievalScoreMultiplier — reads data JSON
// ---------------------------------------------------------------------------

describe('getRetrievalScoreMultiplier — V17 artifact data JSON', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test RF-5
  it('returns base retrieval_score from data JSON when no retrieval events', () => {
    const rowid = seedV17Artifact(db, { data: { retrieval_score: 1.5 } });

    const multiplier = getRetrievalScoreMultiplier(db, rowid);
    // No retrieval events → base returned directly
    expect(multiplier).toBe(1.5);
  });

  // 14-07b Test RF-6
  it('returns 1.0 for nonexistent rowid', () => {
    const multiplier = getRetrievalScoreMultiplier(db, 99999);
    expect(multiplier).toBe(1.0);
  });

  // 14-07b Test RF-7
  it('suppresses multiplier with enough unreferenced retrieval events', () => {
    const rowid = seedV17Artifact(db, { data: { retrieval_score: 1.0 } });

    // Insert 5 unreferenced events
    const stmt = db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'test-sess', 0)`
    );
    for (let i = 0; i < 5; i++) stmt.run(rowid);

    const multiplier = getRetrievalScoreMultiplier(db, rowid);
    // 5 unreferenced → suppression applied
    expect(multiplier).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// Tests: recordWasReferenced — reads title as summary from V17
// ---------------------------------------------------------------------------

describe('recordWasReferenced — V17 artifact title as summary', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test RF-8
  it('marks event as referenced when V17 title tokens match assistant text', () => {
    const rowid = seedV17Artifact(db, {
      title: 'migration pattern schema database',
      body: 'body content',
    });

    db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'test-sess', NULL)`
    ).run(rowid);

    db.prepare(
      `INSERT INTO conversation_turns (session_id, project, turn_number, assistant_text)
       VALUES ('test-sess', 'test-project', 1, 'I applied the migration pattern for the schema database.')`
    ).run();

    recordWasReferenced(db, 'test-sess');

    const event = db.prepare(
      `SELECT was_referenced FROM retrieval_events WHERE artifact_id = ?`
    ).get(rowid) as { was_referenced: number };
    expect(event.was_referenced).toBe(1);
  });

  // 14-07b Test RF-9
  it('marks event as unreferenced when title has no overlap with assistant text', () => {
    const rowid = seedV17Artifact(db, {
      title: 'migration schema database pattern',
      body: 'body content',
    });

    db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'test-sess', NULL)`
    ).run(rowid);

    db.prepare(
      `INSERT INTO conversation_turns (session_id, project, turn_number, assistant_text)
       VALUES ('test-sess', 'test-project', 1, 'The weather looks nice outside today.')`
    ).run();

    recordWasReferenced(db, 'test-sess');

    const event = db.prepare(
      `SELECT was_referenced FROM retrieval_events WHERE artifact_id = ?`
    ).get(rowid) as { was_referenced: number };
    expect(event.was_referenced).toBe(0);
  });

  // 14-07b Test RF-10
  it('handles artifact with null title gracefully', () => {
    // Directly insert artifact with null title
    const id = `null-title-${Date.now()}`;
    db.prepare(
      `INSERT INTO artifact (id, kind, title, body, project, session_id, status, confidence,
                             created_at_epoch_ms, updated_at_epoch_ms, data)
       VALUES (?, 'observation', NULL, 'body', 'test-project', 'test-sess', 'active', 0.6, ?, ?, '{}')`
    ).run(id, Date.now(), Date.now());
    const rowid = (db.prepare('SELECT rowid FROM artifact WHERE id = ?').get(id) as { rowid: number }).rowid;

    db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'test-sess', NULL)`
    ).run(rowid);

    db.prepare(
      `INSERT INTO conversation_turns (session_id, project, turn_number, assistant_text)
       VALUES ('test-sess', 'test-project', 1, 'Some assistant response.')`
    ).run();

    // Should not throw
    expect(() => recordWasReferenced(db, 'test-sess')).not.toThrow();

    const event = db.prepare(
      `SELECT was_referenced FROM retrieval_events WHERE artifact_id = ?`
    ).get(rowid) as { was_referenced: number };
    expect(event.was_referenced).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: penalizeUnreferencedArtifacts — JOINs against V17 artifact via rowid
// ---------------------------------------------------------------------------

describe('penalizeUnreferencedArtifacts — V17 JOIN via rowid', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 14-07b Test RF-11
  it('penalizes V17 artifact with 3+ unreferenced retrievals', () => {
    const rowid = seedV17Artifact(db, {
      project: 'test-project',
      data: { retrieval_score: 1.0, activation_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });

    // Insert 3 unreferenced retrieval events (hits the UNREFERENCED_THRESHOLD)
    const stmt = db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'test-sess', 0)`
    );
    for (let i = 0; i < 3; i++) stmt.run(rowid);

    const before = getRetrievalScore(db, rowid);
    penalizeUnreferencedArtifacts(db, 'test-project');
    const after = getRetrievalScore(db, rowid);

    expect(after).toBeLessThan(before);
  });

  // 14-07b Test RF-12
  it('does not penalize V17 artifact with referenced retrievals', () => {
    const rowid = seedV17Artifact(db, {
      project: 'test-project',
      data: { retrieval_score: 1.0, activation_score: 1.0, novelty_score: 0.5, ttl: 3 },
    });

    // 3 referenced retrievals → no penalty (referenced_count > 0 fails HAVING clause)
    const stmt = db.prepare(
      `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced) VALUES (?, 'test-sess', 1)`
    );
    for (let i = 0; i < 3; i++) stmt.run(rowid);

    const before = getRetrievalScore(db, rowid);
    penalizeUnreferencedArtifacts(db, 'test-project');
    const after = getRetrievalScore(db, rowid);

    expect(after).toBe(before);
  });
});
