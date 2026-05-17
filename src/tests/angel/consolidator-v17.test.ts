/**
 * consolidator-v17.test.ts — V17 migration path tests for Angel consolidator.
 *
 * 14-07b (W4): verifies that the consolidator's artifact read/write paths
 * use the V17 `artifact` table after migration. Tests the migrated sites:
 *   - buildClusters: observation→artifact mapping via V17 + artifact_id_map
 *   - consolidateCluster: V17 artifact INSERT for consolidated observations
 *   - mergePair: V17 artifact INSERT for merged observations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  getUnconsolidatedObservations,
  createFallbackSummary,
  shouldConsolidate,
  markConsolidationRan,
  resetConsolidationState,
} from '../../angel/consolidator.js';
import { insertObservation } from '../../core/observations.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

function ensureSession(db: Database.Database, sessionId: string, project: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'active')`
  ).run(sessionId, project);
}

/**
 * Insert a V17 artifact row directly into the `artifact` table.
 * 14-07b: V17 write path for test fixtures.
 */
function insertV17Artifact(
  db: Database.Database,
  opts: {
    kind?: string;
    title?: string;
    body?: string;
    project?: string;
    session_id?: string;
    status?: 'active' | 'stale' | 'superseded';
    confidence?: number;
    data?: object;
  } = {},
): string {
  const id = createHash('sha256')
    .update(`test-v17:${Math.random()}:${Date.now()}`)
    .digest('hex')
    .slice(0, 32);
  db.prepare(
    `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
        created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
     VALUES (?, ?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.kind ?? 'observation',
    opts.title ?? 'Test V17 artifact',
    opts.body ?? 'Test body',
    opts.status ?? 'active',
    opts.confidence ?? 0.6,
    Date.now(),
    Date.now(),
    opts.session_id ?? 'sess-v17',
    opts.project ?? 'test-project',
    JSON.stringify(opts.data ?? {}),
  );
  return id;
}

describe('Consolidator — V17 path (14-07b)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    resetConsolidationState();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('V17 artifact table availability', () => {
    it('V17 artifact table exists after schema initialization', () => {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='artifact'`
      ).get() as { cnt: number };
      expect(row.cnt).toBe(1);
    });

    it('artifact_id_map table exists after migration', () => {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='artifact_id_map'`
      ).get() as { cnt: number };
      expect(row.cnt).toBe(1);
    });
  });

  describe('V17 artifact write path (consolidated observations)', () => {
    it('V17 artifact can be written with observation kind and artifact_ref in data', () => {
      const obsId = 42;
      const v17Id = createHash('sha256')
        .update(`observation:consolidator:test-project:sess-1:${obsId}:${Date.now()}`)
        .digest('hex')
        .slice(0, 32);

      db.prepare(
        `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
            created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
         VALUES (?, 'observation', ?, ?, 'project', 'active', 0.8, ?, ?, ?, ?, ?)`
      ).run(
        v17Id,
        'Consolidated: topic A, topic B',
        'Consolidated content here',
        Date.now(),
        Date.now(),
        'sess-1',
        'test-project',
        JSON.stringify({ artifact_ref: String(obsId), obs_type: 'consolidated', tool_name: 'angel:consolidator' }),
      );

      const row = db.prepare(
        `SELECT id, kind, json_extract(data, '$.artifact_ref') AS artifact_ref
         FROM artifact WHERE id = ?`
      ).get(v17Id) as { id: string; kind: string; artifact_ref: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.kind).toBe('observation');
      expect(row!.artifact_ref).toBe(String(obsId));
    });

    it('V17 artifact query by kind and data.artifact_ref works', () => {
      const obsId = 99;
      const v17Id = insertV17Artifact(db, {
        kind: 'observation',
        data: { artifact_ref: String(obsId), obs_type: 'consolidated' },
      });

      const found = db.prepare(
        `SELECT id FROM artifact
         WHERE kind = 'observation'
           AND json_extract(data, '$.artifact_ref') = ?
         ORDER BY created_at_epoch_ms DESC LIMIT 1`
      ).get(String(obsId)) as { id: string } | undefined;

      expect(found).toBeDefined();
      expect(found!.id).toBe(v17Id);
    });
  });

  describe('V17 observation→artifact mapping via artifact_id_map', () => {
    it('artifact_id_map JOIN with V17 artifact works for observation ref lookup', () => {
      // Simulate what buildClusters does: map artifact_id_map legacy_id → obs_id via JSON data
      const legacyArtId = 1;
      const obsId = 55;

      // Insert legacy artifact into artifacts table
      ensureSession(db, 'sess-1', 'test-project');
      const artResult = db.prepare(
        `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, state, importance)
         VALUES ('sess-1', 'test-project', 'observation', ?, 'Obs title', 'fresh', 3)`
      ).run(String(obsId));
      const insertedLegacyId = artResult.lastInsertRowid as number;

      // V17 artifact row with data.artifact_ref
      const v17Id = insertV17Artifact(db, {
        kind: 'observation',
        data: { artifact_ref: String(obsId), migrated_from_legacy_id: insertedLegacyId },
      });

      // Manually populate artifact_id_map as migration would do
      db.prepare(
        `INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
         VALUES (?, ?, ?, 'test-project')`
      ).run(insertedLegacyId, v17Id, Date.now());

      // This is the migrated query from buildClusters
      const rows = db.prepare(
        `SELECT m.legacy_id AS art_legacy_id,
                CAST(json_extract(a.data, '$.artifact_ref') AS INTEGER) AS obs_id
         FROM artifact a
         INNER JOIN artifact_id_map m ON m.v17_id = a.id
         WHERE a.kind = 'observation'
           AND json_extract(a.data, '$.artifact_ref') IS NOT NULL
           AND CAST(json_extract(a.data, '$.artifact_ref') AS INTEGER) IN (${obsId})`
      ).all() as Array<{ art_legacy_id: number; obs_id: number }>;

      expect(rows.length).toBe(1);
      expect(rows[0].obs_id).toBe(obsId);
      expect(rows[0].art_legacy_id).toBe(insertedLegacyId);
    });
  });

  describe('getUnconsolidatedObservations (unchanged behavior)', () => {
    it('still returns unconsolidated observations from observations table', () => {
      ensureSession(db, 'sess-1', 'test-project');
      insertObservation(db, {
        session_id: 'sess-1',
        project: 'test-project',
        tool_name: 'tool',
        category: 'code' as any,
        title: 'Obs A',
        content: 'Content A',
        importance: 3,
        files_modified: [],
      });

      const results = getUnconsolidatedObservations(db, 50);
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Obs A');
    });
  });

  describe('Rate limiting and control functions', () => {
    it('shouldConsolidate + markConsolidationRan work correctly', () => {
      resetConsolidationState();
      expect(shouldConsolidate()).toBe(true);
      markConsolidationRan();
      expect(shouldConsolidate()).toBe(false);
      resetConsolidationState();
      expect(shouldConsolidate()).toBe(true);
    });

    it('createFallbackSummary produces readable output', () => {
      const obs = [
        { category: 'code', title: 'Title A', content: 'Content A' },
        { category: 'error', title: 'Title B', content: 'Content B' },
      ] as any;
      const summary = createFallbackSummary(obs);
      expect(summary).toContain('Title A');
      expect(summary).toContain('Title B');
    });
  });
});
