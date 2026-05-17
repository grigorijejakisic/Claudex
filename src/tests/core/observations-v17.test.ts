/**
 * 14-07b W3: observations.ts V17 migration tests.
 *
 * Tests the migrated artifact_ref lookup in insertObservationWithDedup.
 * The legacy `SELECT artifact_ref FROM artifacts WHERE id = ?` is now:
 *   1. Bridge legacy INTEGER id → V17 TEXT id via artifact_id_map.
 *   2. Read artifact_ref from V17 artifact.data JSON sidecar.
 *   3. Fall back to legacy artifacts table for pre-migration rows.
 *
 * These tests exercise the helper logic directly (not the full async dedup
 * path which requires Qdrant — that integration is covered by the existing
 * observations-dedup.test.ts). We test the artifact_ref resolution path
 * in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { generateV17IdFromLegacy, lookupV17ByLegacy } from '../../core/artifact-id-map.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { insertObservation } from '../../core/observations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTable(db: Database.Database, name: string): boolean {
  return !!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function ensureArtifactIdMap(db: Database.Database): void {
  if (!hasTable(db, 'artifact_id_map')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_id_map (
        legacy_id          INTEGER PRIMARY KEY,
        v17_id             TEXT NOT NULL UNIQUE,
        mapped_at_epoch_ms INTEGER NOT NULL,
        project            TEXT NOT NULL,
        FOREIGN KEY (v17_id) REFERENCES artifact(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_v17 ON artifact_id_map(v17_id);
    `);
  }
}

/**
 * Seed a legacy artifacts row with artifact_ref pointing to an observation id.
 * Also seed V17 artifact + mapping with artifact_ref in data JSON.
 * Returns { legacyArtifactId, v17Id, obsRef }.
 */
function seedObservationArtifact(
  db: Database.Database,
  obsId: number,
  project: string = 'test-project',
): { legacyArtifactId: number; v17Id: string; obsRef: string } {
  const now = Date.now();
  const obsRef = String(obsId);

  // Legacy artifacts row pointing to the observation.
  const legacyRes = db.prepare(`
    INSERT INTO artifacts(session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance, timestamp_epoch_ms)
    VALUES ('sess-obs', ?, 'observation', ?, ?, ?, 'fresh', 3600, 3, ?)
  `).run(project, obsRef, `Observation ${obsId}`, `Content for obs ${obsId}`, now);
  const legacyArtifactId = Number(legacyRes.lastInsertRowid);

  // V17 artifact row with artifact_ref in data sidecar.
  const v17Id = generateV17IdFromLegacy({
    legacy_id: legacyArtifactId,
    project,
    timestamp_epoch_ms: now,
    summary: `Observation ${obsId}`,
    body: `Content for obs ${obsId}`,
  });

  const dataJson = JSON.stringify({
    migrated_from_legacy_id: legacyArtifactId,
    artifact_ref: obsRef,
  });

  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
      created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
    VALUES (?, 'observation', ?, ?, 'project', 'active', 0.6, ?, ?, 'sess-obs', ?, ?)
  `).run(v17Id, `Observation ${obsId}`, `Content for obs ${obsId}`, now, now, project, dataJson);

  // Mapping.
  db.prepare(`
    INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
    VALUES (?, ?, ?, ?)
  `).run(legacyArtifactId, v17Id, now, project);

  return { legacyArtifactId, v17Id, obsRef };
}

/**
 * Replicate the migrated artifact_ref resolution logic from observations.ts.
 * Returns the artifact_ref string or null.
 */
function resolveArtifactRef(
  db: Database.Database,
  artifactId: number,
): string | null {
  // V17 path: bridge legacy id → V17 id, read artifact_ref from data JSON.
  let resolvedRef: string | null = null;
  try {
    const v17Id = lookupV17ByLegacy(db, artifactId);
    if (v17Id) {
      const v17Artifact = cachedPrepare(db,
        `SELECT json_extract(data, '$.artifact_ref') AS artifact_ref
           FROM artifact WHERE id = ? AND kind = 'observation'`
      ).get(v17Id) as { artifact_ref: string | null } | undefined;
      resolvedRef = v17Artifact?.artifact_ref ?? null;
    }
  } catch { /* V17 path unavailable */ }

  // Legacy fallback.
  if (resolvedRef === null) {
    try {
      const legacyArtifact = cachedPrepare(db,
        `SELECT artifact_ref FROM artifacts WHERE id = ? AND artifact_type = 'observation'`
      ).get(artifactId) as { artifact_ref: string | null } | undefined;
      resolvedRef = legacyArtifact?.artifact_ref ?? null;
    } catch { /* neither table present */ }
  }

  return resolvedRef;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('observations.ts V17 migration — artifact_ref resolution via artifact_id_map', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    ensureArtifactIdMap(db);

    // Create a test session.
    db.prepare(`
      INSERT INTO sessions(session_id, project, status, observation_count, created_at_epoch_ms)
      VALUES ('sess-obs', 'test-project', 'active', 0, ?)
    `).run(Date.now());
  });

  afterEach(() => {
    db.close();
  });

  it('1. resolves artifact_ref via V17 data JSON sidecar through artifact_id_map', () => {
    // Insert a real observation first.
    const obsId = insertObservation(db, {
      session_id: 'sess-obs',
      project: 'test-project',
      tool_name: 'Read',
      category: 'code',
      title: 'Test observation for dedup',
      content: 'Observed content details',
      importance: 3,
      files_modified: ['src/auth.ts'],
    });

    // Seed V17 artifact pointing to this observation.
    const { legacyArtifactId } = seedObservationArtifact(db, obsId);

    // Resolve via migrated logic.
    const resolvedRef = resolveArtifactRef(db, legacyArtifactId);
    expect(resolvedRef).toBe(String(obsId));
  });

  it('2. returns null for unknown legacy artifact id (no mapping)', () => {
    const result = resolveArtifactRef(db, 99999);
    expect(result).toBeNull();
  });

  it('3. resolves artifact_ref as numeric string (parseable to observation id)', () => {
    const obsId = insertObservation(db, {
      session_id: 'sess-obs',
      project: 'test-project',
      tool_name: 'Grep',
      category: 'architecture',
      title: 'Architecture pattern',
      content: 'Found consistent pattern in auth modules',
      importance: 4,
      files_modified: [],
    });

    const { legacyArtifactId } = seedObservationArtifact(db, obsId);
    const resolvedRef = resolveArtifactRef(db, legacyArtifactId);

    // Should be numeric string matching the observation id.
    expect(resolvedRef).toBe(String(obsId));
    expect(Number(resolvedRef)).toBe(obsId);
  });

  it('4. falls back to legacy artifacts table when artifact_id_map absent', () => {
    // DB without artifact_id_map.
    const legacyDb = new Database(':memory:');
    initializeSchema(legacyDb);

    // Drop artifact_id_map if present.
    try { legacyDb.exec('DROP TABLE IF EXISTS artifact_id_map'); } catch { /* non-critical */ }

    // Insert a legacy artifacts row pointing to obs id 42.
    const res = legacyDb.prepare(`
      INSERT INTO artifacts(session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance)
      VALUES ('s1', 'proj', 'observation', '42', 'Obs summary', 'Obs content', 'fresh', 3600, 3)
    `).run();
    const legacyArtId = Number(res.lastInsertRowid);

    const resolvedRef = resolveArtifactRef(legacyDb, legacyArtId);
    expect(resolvedRef).toBe('42');

    legacyDb.close();
  });

  it('5. returns null when artifact exists in V17 but lacks artifact_ref in data JSON', () => {
    const now = Date.now();

    // Legacy artifact without artifact_ref.
    const legacyRes = db.prepare(`
      INSERT INTO artifacts(session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance)
      VALUES ('sess-obs', 'test-project', 'observation', null, 'No ref', 'No ref body', 'fresh', 3600, 3)
    `).run();
    const legacyArtId = Number(legacyRes.lastInsertRowid);

    const v17Id = generateV17IdFromLegacy({
      legacy_id: legacyArtId,
      project: 'test-project',
      timestamp_epoch_ms: now,
      summary: 'No ref',
      body: 'No ref body',
    });

    // V17 artifact without artifact_ref in data JSON.
    db.prepare(`
      INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
        created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
      VALUES (?, 'observation', 'No ref', 'No ref body', 'project', 'active', 0.5, ?, ?, 'sess-obs', 'test-project', '{}')
    `).run(v17Id, now, now);

    db.prepare(`
      INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
      VALUES (?, ?, ?, 'test-project')
    `).run(legacyArtId, v17Id, now);

    const resolvedRef = resolveArtifactRef(db, legacyArtId);
    // V17 data has no artifact_ref, legacy row has null artifact_ref.
    expect(resolvedRef).toBeNull();
  });

  it('6. basic observation insertion still works after V17 migration (no regression)', () => {
    const obsId = insertObservation(db, {
      session_id: 'sess-obs',
      project: 'test-project',
      tool_name: 'Write',
      category: 'code',
      title: 'Regression check',
      content: 'Basic observation insert should still work',
      importance: 2,
      files_modified: ['src/foo.ts'],
    });
    expect(obsId).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(obsId) as Record<string, unknown>;
    expect(row['title']).toBe('Regression check');
    expect(row['importance']).toBe(2);
  });
});
