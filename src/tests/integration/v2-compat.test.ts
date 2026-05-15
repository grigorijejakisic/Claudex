/**
 * V2 schema compatibility tests — verifies v3 code operates correctly
 * against a database originally created with v2 constraints.
 *
 * These tests would have caught ALL Session 9 bugs:
 * - sessions.scope NOT NULL in v2 but v3 code passes NULL
 * - sessions.cwd NOT NULL in v2 but v3 code passes NULL
 * - observations_fts had 4 columns in v2 but v3 triggers only populate 2
 * - pressure_scores schema differences (UNIQUE constraint, missing columns)
 *
 * The key insight: all other tests use fresh v3 schemas (via createTestDb),
 * so they never exercise the upgrade path from a live v2 database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createSession, endSession } from '../../core/sessions.js';
import { insertObservation } from '../../core/observations.js';
import { updatePressureScore } from '../../core/pressure.js';
import { createArtifact } from '../../core/artifacts.js';
import { addJournalEntry } from '../../core/journal.js';

// ---------------------------------------------------------------------------
// V2 fixture builder
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory database with v2-like schema constraints.
 * Key differences from v3:
 * - sessions: scope/cwd/project are NOT NULL with defaults
 * - observations: no consumed column, no obs_type column
 * - observations_fts: 4 columns (title, content, category, tool_name)
 * - pressure_scores: UNIQUE constraint instead of PRIMARY KEY, no NOT NULL on some cols
 */
function createV2Fixture(): DatabaseType {
  const db = new Database(':memory:');

  db.exec(`
    -- V2 observations (no consumed, no obs_type)
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '__global__',
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      files_modified TEXT NOT NULL DEFAULT '',
      timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch()),
      access_count INTEGER DEFAULT 0,
      last_accessed_at_epoch_ms INTEGER,
      deleted_at_epoch_ms INTEGER DEFAULT NULL
    );

    -- V2 FTS with 4 columns
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title, content, category, tool_name,
      content=observations, content_rowid=id,
      tokenize='porter unicode61'
    );

    -- V2 FTS triggers (4-column)
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, category, tool_name)
      VALUES (new.id, new.title, new.content, new.category, new.tool_name);
    END;

    CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, category, tool_name)
      VALUES ('delete', old.id, old.title, old.content, old.category, old.tool_name);
    END;

    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, category, tool_name)
      VALUES ('delete', old.id, old.title, old.content, old.category, old.tool_name);
      INSERT INTO observations_fts(rowid, title, content, category, tool_name)
      VALUES (new.id, new.title, new.content, new.category, new.tool_name);
    END;

    -- V2 sessions table (stricter constraints: NOT NULL on scope, cwd, project)
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'unknown',
      project TEXT NOT NULL DEFAULT '__global__',
      cwd TEXT NOT NULL DEFAULT '.',
      source TEXT DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'active',
      observation_count INTEGER DEFAULT 0,
      created_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at_epoch_ms INTEGER,
      adapter TEXT DEFAULT 'unknown'
    );

    -- V2 pressure_scores (UNIQUE constraint, no NOT NULL on last_touched_epoch)
    CREATE TABLE pressure_scores (
      file_path TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '__global__',
      raw_pressure REAL NOT NULL DEFAULT 0.0,
      temperature TEXT NOT NULL DEFAULT 'COLD',
      last_touched_epoch INTEGER,
      decay_rate REAL DEFAULT 0.1,
      UNIQUE(file_path, project)
    );

    -- V2 schema_versions (with applied_at TEXT, not applied_at_epoch_ms)
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime())
    );

    INSERT INTO schema_versions (version) VALUES (200);
  `);

  // V2 databases were created before PRAGMA user_version was used (pre-versioning).
  // user_version = 0 triggers the legacy detection path in runMigrations():
  // version === 0 + tables exist = legacy DB → migrateV1toV2 → user_version = 2.
  // This is the realistic scenario: v2 code never set user_version.

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2 schema compatibility', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = createV2Fixture();
  });

  afterEach(() => {
    db.close();
  });

  // ── Test 1: initializeSchema upgrades v2 DB without errors ──────────────

  it('initializeSchema upgrades v2 DB without errors', () => {
    expect(() => initializeSchema(db)).not.toThrow();

    // All v3 tables should exist
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map(r => r.name);

    expect(tables).toContain('observations');
    expect(tables).toContain('sessions');
    expect(tables).toContain('pressure_scores');
    expect(tables).toContain('learnings');
    expect(tables).toContain('decisions');
    expect(tables).toContain('thread_state');
    expect(tables).toContain('checkpoint_tracking');
    expect(tables).toContain('checkpoint_meta');
    expect(tables).toContain('session_journal');
    expect(tables).toContain('artifacts');
    expect(tables).toContain('verified_facts');
    expect(tables).toContain('telemetry');

    // FTS5 should exist as a virtual table
    const vtables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'")
        .all() as Array<{ name: string }>
    ).map(r => r.name);
    expect(vtables).toContain('observations_fts');
  });

  // ── Test 2: createSession succeeds on upgraded v2 DB ────────────────────

  it('createSession succeeds on upgraded v2 DB', () => {
    initializeSchema(db);

    // v3 code passes scope as undefined (defaults to 'unknown')
    // This would fail on v2 NOT NULL constraint if upgrade didn't relax it
    expect(() =>
      createSession(db, {
        session_id: 'test-sess-1',
        project: 'proj',
        cwd: '/test',
      })
    ).not.toThrow();

    const row = db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get('test-sess-1') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.session_id).toBe('test-sess-1');
    expect(row.project).toBe('proj');
    expect(row.status).toBe('active');
  });

  // ── Test 3: insertObservation succeeds on upgraded v2 DB ────────────────

  it('insertObservation succeeds on upgraded v2 DB', () => {
    initializeSchema(db);

    // Create a session first (observations reference session_id)
    createSession(db, { session_id: 'obs-sess', project: 'proj', cwd: '/test' });

    // v3 insertObservation uses consumed and obs_type columns not present in v2
    const id = insertObservation(db, {
      session_id: 'obs-sess',
      project: 'proj',
      tool_name: 'Read',
      category: 'code',
      title: 'Read main.ts',
      content: 'File contents of main.ts',
      importance: 3,
      files_modified: ['src/main.ts'],
    });

    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(id) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.title).toBe('Read main.ts');
    expect(row.consumed).toBe(0);
  });

  // ── Test 4: updatePressureScore succeeds on upgraded v2 DB ──────────────

  it('updatePressureScore succeeds on upgraded v2 DB', () => {
    initializeSchema(db);

    // v3 uses PRIMARY KEY (file_path, project); v2 used UNIQUE constraint
    // The upgrade must handle the ON CONFLICT correctly
    expect(() =>
      updatePressureScore(db, 'src/index.ts', 'proj', 0.8)
    ).not.toThrow();

    const row = db
      .prepare('SELECT * FROM pressure_scores WHERE file_path = ?')
      .get('src/index.ts') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.raw_pressure).toBe(0.8);
    expect(row.temperature).toBe('HOT');

    // Upsert (accumulate) should also work
    expect(() =>
      updatePressureScore(db, 'src/index.ts', 'proj', 0.3)
    ).not.toThrow();

    const updated = db
      .prepare('SELECT * FROM pressure_scores WHERE file_path = ?')
      .get('src/index.ts') as Record<string, unknown>;

    expect((updated.raw_pressure as number)).toBeCloseTo(1.1);
  });

  // ── Test 5: createArtifact succeeds on upgraded v2 DB ───────────────────

  it('createArtifact succeeds on upgraded v2 DB', () => {
    initializeSchema(db);

    // artifacts table doesn't exist in v2 at all — must be created by upgrade
    const id = createArtifact(
      db,
      'art-sess',
      'proj',
      'observation',
      'obs:1',
      'Summary of observation',
      'Full content here',
      4,
    );

    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare('SELECT * FROM artifacts WHERE id = ?')
      .get(id) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.artifact_type).toBe('observation');
    expect(row.state).toBe('fresh');
    expect(row.importance).toBe(4);
  });

  // ── Test 6: addJournalEntry succeeds on upgraded v2 DB ──────────────────

  it('addJournalEntry succeeds on upgraded v2 DB', () => {
    initializeSchema(db);

    // session_journal doesn't exist in v2 — must be created by upgrade
    const id = addJournalEntry(
      db,
      'journal-sess',
      'proj',
      'flow',
      'User requested refactoring of auth module',
    );

    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare('SELECT * FROM session_journal WHERE id = ?')
      .get(id) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.entry_type).toBe('flow');
    expect(row.content).toBe('User requested refactoring of auth module');
  });

  // ── Test 7: FTS5 index has correct 2-column schema after upgrade ────────

  it('FTS5 index has correct 2-column schema after upgrade', () => {
    initializeSchema(db);

    // PRAGMA table_info returns user-defined columns for FTS5 virtual tables.
    // v2 had 4 columns (title, content, category, tool_name).
    // After upgrade, should have only 2 (title, content).
    const ftsInfo = db.pragma('table_info(observations_fts)') as Array<{
      name: string;
      cid: number;
    }>;

    const colNames = ftsInfo.map(c => c.name);
    expect(colNames).toContain('title');
    expect(colNames).toContain('content');
    expect(colNames).not.toContain('category');
    expect(colNames).not.toContain('tool_name');
    expect(ftsInfo.length).toBe(2);
  });

  // ── Test 8: v3 operations work end-to-end on upgraded v2 DB ─────────────

  it('v3 operations work end-to-end on upgraded v2 DB', () => {
    initializeSchema(db);

    // Full pipeline: create session → insert observation → create artifact →
    // update pressure → add journal entry → end session
    // All must succeed without throws.

    // 1. Create session
    createSession(db, {
      session_id: 'e2e-sess',
      project: 'e2e-proj',
      cwd: '/e2e/test',
      source: 'test',
    });

    // 2. Insert observation
    const obsId = insertObservation(db, {
      session_id: 'e2e-sess',
      project: 'e2e-proj',
      tool_name: 'Edit',
      category: 'code',
      title: 'Edited auth.ts',
      content: 'Changed JWT expiry from 1h to 24h',
      importance: 4,
      files_modified: ['src/auth.ts'],
      obs_type: 'tool_result',
    });
    expect(obsId).toBeGreaterThan(0);

    // 3. Create artifact
    const artId = createArtifact(
      db,
      'e2e-sess',
      'e2e-proj',
      'observation',
      `obs:${obsId}`,
      'JWT expiry change',
      'Changed JWT expiry from 1h to 24h in auth.ts',
      4,
    );
    expect(artId).toBeGreaterThan(0);

    // 4. Update pressure score
    updatePressureScore(db, 'src/auth.ts', 'e2e-proj', 0.9);

    const pressure = db
      .prepare("SELECT * FROM pressure_scores WHERE file_path = 'src/auth.ts'")
      .get() as Record<string, unknown>;
    expect(pressure).toBeDefined();
    expect(pressure.temperature).toBe('HOT');

    // 5. Add journal entry
    const journalId = addJournalEntry(
      db,
      'e2e-sess',
      'e2e-proj',
      'milestone',
      'Auth module refactoring complete',
    );
    expect(journalId).toBeGreaterThan(0);

    // 6. End session
    endSession(db, 'e2e-sess', 'completed');

    const session = db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get('e2e-sess') as Record<string, unknown>;
    expect(session.status).toBe('completed');
    expect(session.ended_at_epoch_ms).not.toBeNull();

    // Verify all data is queryable
    const obs = db
      .prepare('SELECT COUNT(*) as cnt FROM observations WHERE session_id = ?')
      .get('e2e-sess') as { cnt: number };
    expect(obs.cnt).toBe(1);

    const arts = db
      .prepare('SELECT COUNT(*) as cnt FROM artifacts WHERE session_id = ?')
      .get('e2e-sess') as { cnt: number };
    expect(arts.cnt).toBe(1);

    const journal = db
      .prepare('SELECT COUNT(*) as cnt FROM session_journal WHERE session_id = ?')
      .get('e2e-sess') as { cnt: number };
    expect(journal.cnt).toBe(1);
  });
});
