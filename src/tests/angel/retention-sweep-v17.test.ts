/**
 * retention-sweep-v17.test.ts — V17 migration path tests for Angel retention sweep.
 *
 * 14-07b (W4): verifies the migrated retention-sweep paths against V17 `artifact` table:
 *   - pruneArtifacts: DELETE FROM artifact with V17 status/confidence semantics
 *   - pruneArtifactLinks: orphan check via artifact_id_map
 *   - pruneObservations: observation retention guard via V17 artifact + data.artifact_ref
 *
 * V17 field mapping verified:
 *   state='packed' → status='stale'
 *   state='fresh'/'materialized' → status='active'
 *   superseded_by IS NOT NULL (forward) → status='superseded' (V17 marks superseded rows)
 *   importance (1-5) → confidence (0-1): threshold importance<3 → confidence<0.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  pruneArtifacts,
  pruneArtifactLinks,
  pruneObservations,
  resetSweepRateLimit,
} from '../../angel/retention-sweep.js';
import { DEFAULT_RETENTION_CONFIG } from '../../angel/types.js';
import { insertObservation } from '../../core/observations.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

const config = { ...DEFAULT_RETENTION_CONFIG };

function daysAgoMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

function ensureSession(db: Database.Database, sessionId: string, project = 'test-project'): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'active')`
  ).run(sessionId, project);
}

/**
 * Insert a V17 artifact row. Returns the TEXT id.
 * 14-07b: test fixture for V17 retention-sweep tests.
 */
function insertV17Artifact(
  db: Database.Database,
  opts: {
    kind?: string;
    title?: string;
    body?: string;
    status?: 'active' | 'stale' | 'superseded';
    confidence?: number;
    created_at_epoch_ms?: number;
    session_id?: string;
    project?: string;
    data?: object;
  } = {},
): string {
  const id = createHash('sha256')
    .update(`retention-v17:${Math.random()}:${Date.now()}`)
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
    opts.created_at_epoch_ms ?? Date.now(),
    opts.created_at_epoch_ms ?? Date.now(),
    opts.session_id ?? 'angel',
    opts.project ?? 'test-project',
    JSON.stringify(opts.data ?? {}),
  );
  return id;
}

describe('Retention Sweep — V17 path (14-07b)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    resetSweepRateLimit();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  // ── pruneArtifacts against V17 ──────────────────────────────────────────────

  describe('pruneArtifacts V17 semantics', () => {
    it('deletes V17 artifacts with status=superseded older than grace period', () => {
      const oldId = insertV17Artifact(db, {
        status: 'superseded',
        confidence: 0.6,
        created_at_epoch_ms: daysAgoMs(config.artifactSupersededDeleteDays + 5),
      });

      const deleted = pruneArtifacts(db, config);

      expect(deleted).toBeGreaterThanOrEqual(1);
      const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(oldId);
      expect(row).toBeUndefined();
    });

    it('keeps V17 superseded artifacts within grace period', () => {
      const recentId = insertV17Artifact(db, {
        status: 'superseded',
        confidence: 0.6,
        created_at_epoch_ms: daysAgoMs(5), // within grace period
      });

      pruneArtifacts(db, config);

      const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(recentId);
      expect(row).toBeDefined();
    });

    it('deletes V17 stale artifacts with confidence < 0.6 (importance < 3 equivalent)', () => {
      const coldId = insertV17Artifact(db, {
        status: 'stale',
        confidence: 0.4, // < 0.6 threshold → importance ~2 equivalent
        created_at_epoch_ms: daysAgoMs(config.artifactColdDeleteDays + 5),
      });

      pruneArtifacts(db, config);

      const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(coldId);
      expect(row).toBeUndefined();
    });

    it('preserves V17 stale artifacts with recent retrieval events', () => {
      const activeId = insertV17Artifact(db, {
        status: 'stale',
        confidence: 0.4,
        created_at_epoch_ms: daysAgoMs(config.artifactColdDeleteDays + 5),
      });

      // Insert a retrieval event to simulate recent access
      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch_ms)
         VALUES (?, 'sess-1', 1, ?)`
      ).run(activeId, Date.now() - 1000); // very recent retrieval

      pruneArtifacts(db, config);

      const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(activeId);
      expect(row).toBeDefined();
    });

    it('never deletes V17 artifacts with confidence = 1.0 (importance=5 equivalent)', () => {
      const immuneId = insertV17Artifact(db, {
        status: 'superseded',
        confidence: 1.0,
        created_at_epoch_ms: daysAgoMs(config.artifactSupersededDeleteDays + 30),
      });

      pruneArtifacts(db, config);

      const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(immuneId);
      expect(row).toBeDefined();
    });

    it('deletes ancient stale V17 artifacts with confidence < 0.8', () => {
      const ancientId = insertV17Artifact(db, {
        status: 'stale',
        confidence: 0.6, // < 0.8 threshold
        created_at_epoch_ms: daysAgoMs(95), // older than 90 days
      });

      pruneArtifacts(db, config);

      const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(ancientId);
      expect(row).toBeUndefined();
    });

    it('preserves ancient stale V17 artifacts with confidence >= 0.8', () => {
      const importantId = insertV17Artifact(db, {
        status: 'stale',
        confidence: 0.8, // >= 0.8 threshold — preserved
        created_at_epoch_ms: daysAgoMs(95),
      });

      pruneArtifacts(db, config);

      const row = db.prepare('SELECT id FROM artifact WHERE id = ?').get(importantId);
      expect(row).toBeDefined();
    });

    it('is non-throwing on empty V17 artifact table', () => {
      // No artifacts in V17 — should return 0 without errors
      const deleted = pruneArtifacts(db, config);
      expect(deleted).toBe(0);
    });
  });

  // ── pruneArtifactLinks via artifact_id_map ─────────────────────────────────

  describe('pruneArtifactLinks V17 path', () => {
    it('removes artifact_links whose source_id has no mapping in artifact_id_map', () => {
      ensureSession(db, 'sess-1');

      // Insert two legacy artifacts (to satisfy FK constraints on artifact_links)
      const a1 = db.prepare(
        `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, importance)
         VALUES ('sess-1', 'test-project', 'observation', 'Obs 1', 'fresh', 3)`
      ).run().lastInsertRowid as number;
      const a2 = db.prepare(
        `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, importance)
         VALUES ('sess-1', 'test-project', 'observation', 'Obs 2', 'fresh', 3)`
      ).run().lastInsertRowid as number;

      // Insert link between them
      db.prepare(
        `INSERT INTO artifact_links (source_id, target_id, link_type, strength)
         VALUES (?, ?, 'related', 0.5)`
      ).run(a1, a2);

      // Only add a2 to artifact_id_map — a1 has no mapping (orphan source)
      const v17Id = insertV17Artifact(db, { data: { migrated_from_legacy_id: a2 } });
      db.prepare(
        `INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
         VALUES (?, ?, ?, 'test-project')`
      ).run(a2, v17Id, Date.now());

      // pruneArtifactLinks should remove the link because source_id (a1) is not in artifact_id_map
      const deleted = pruneArtifactLinks(db, config);
      expect(deleted).toBeGreaterThanOrEqual(1);

      const linkRow = db.prepare(
        'SELECT source_id FROM artifact_links WHERE source_id = ? AND target_id = ?'
      ).get(a1, a2);
      expect(linkRow).toBeUndefined();
    });

    it('preserves artifact_links where both endpoints exist in artifact_id_map', () => {
      ensureSession(db, 'sess-1');

      const a1 = db.prepare(
        `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, importance)
         VALUES ('sess-1', 'test-project', 'observation', 'Obs 1', 'fresh', 3)`
      ).run().lastInsertRowid as number;
      const a2 = db.prepare(
        `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, importance)
         VALUES ('sess-1', 'test-project', 'observation', 'Obs 2', 'fresh', 3)`
      ).run().lastInsertRowid as number;

      db.prepare(
        `INSERT INTO artifact_links (source_id, target_id, link_type, strength)
         VALUES (?, ?, 'related', 0.9)`
      ).run(a1, a2);

      // Both endpoints in artifact_id_map
      const v17Id1 = insertV17Artifact(db, { data: { migrated_from_legacy_id: a1 } });
      const v17Id2 = insertV17Artifact(db, { data: { migrated_from_legacy_id: a2 } });
      db.prepare(
        `INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
         VALUES (?, ?, ?, 'test-project')`
      ).run(a1, v17Id1, Date.now());
      db.prepare(
        `INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
         VALUES (?, ?, ?, 'test-project')`
      ).run(a2, v17Id2, Date.now());

      const deleted = pruneArtifactLinks(db, config);
      // The strong link (0.9) should not be deleted by weak-stale filter; orphan check passes
      expect(deleted).toBe(0);

      const linkRow = db.prepare(
        'SELECT source_id FROM artifact_links WHERE source_id = ? AND target_id = ?'
      ).get(a1, a2);
      expect(linkRow).toBeDefined();
    });
  });

  // ── pruneObservations via V17 artifact retrieval guard ────────────────────

  describe('pruneObservations V17 retrieval guard', () => {
    it('deletes low-importance observations with no V17 retrieval record', () => {
      ensureSession(db, 'sess-1');

      const obsId = insertObservation(db, {
        session_id: 'sess-1',
        project: 'test-project',
        tool_name: 'tool',
        category: 'code' as any,
        title: 'Low importance obs',
        content: 'Low importance content',
        importance: 1,
        files_modified: [],
      });

      // Manually set timestamp to old enough
      db.prepare(
        `UPDATE observations SET timestamp_epoch_ms = ? WHERE id = ?`
      ).run(daysAgoMs(35), obsId); // older than 30-day low threshold

      const result = pruneObservations(db, config);
      expect(result.deleted).toBeGreaterThanOrEqual(1);

      const row = db.prepare('SELECT id FROM observations WHERE id = ?').get(obsId);
      expect(row).toBeUndefined();
    });

    it('preserves observations referenced by V17 artifact with retrieval events', () => {
      ensureSession(db, 'sess-1');

      const obsId = insertObservation(db, {
        session_id: 'sess-1',
        project: 'test-project',
        tool_name: 'tool',
        category: 'code' as any,
        title: 'Active obs',
        content: 'Retrieved observation',
        importance: 1,
        files_modified: [],
      });

      db.prepare(
        `UPDATE observations SET timestamp_epoch_ms = ? WHERE id = ?`
      ).run(daysAgoMs(35), obsId);

      // Create V17 artifact pointing to this observation
      const v17ArtId = insertV17Artifact(db, {
        kind: 'observation',
        data: { artifact_ref: String(obsId) },
      });

      // Add retrieval event for this V17 artifact
      db.prepare(
        `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch_ms)
         VALUES (?, 'sess-1', 1, ?)`
      ).run(v17ArtId, Date.now() - 1000);

      const result = pruneObservations(db, config);
      // The observation should be preserved due to V17 retrieval event
      const row = db.prepare('SELECT id FROM observations WHERE id = ?').get(obsId);
      expect(row).toBeDefined();
    });

    it('is non-throwing on empty observations table', () => {
      const result = pruneObservations(db, config);
      expect(result.deleted).toBe(0);
      expect(result.superseded).toBe(0);
    });
  });
});
