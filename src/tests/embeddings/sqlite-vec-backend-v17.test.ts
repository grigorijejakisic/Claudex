/**
 * 14-07b W2: V17-path tests for sqlite-vec-backend.ts.
 *
 * Verifies:
 * - upsertArtifactEmbeddingVecV17() writes to vec_artifact_v17 (not vec_artifacts)
 * - searchArtifactsVecV17() JOINs with V17 artifact table (not legacy artifacts)
 * - searchArtifactsVecV17() returns V17-shaped payloads (kind, confidence, status)
 * - Project filtering, status filtering, and kind filtering work correctly
 * - Upsert replaces existing vector (idempotent via DELETE+INSERT)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  setVectorStoreDb,
  upsertArtifactEmbeddingVecV17,
  searchArtifactsVecV17,
} from '../../embeddings/sqlite-vec-backend.js';
import { loadSqliteVec, sqliteVecLoadStatus } from '../../core/sqlite-vec-loader.js';
import { hasTable } from '../../core/migration-steps.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function vec(fill: number, dim = 1024): number[] {
  return Array(dim).fill(fill);
}

/** Insert a V17 artifact row. Returns the TEXT id and INTEGER rowid. */
function insertV17Artifact(
  db: Database.Database,
  opts: {
    id?: string;
    kind?: string;
    project?: string;
    title?: string;
    body?: string;
    confidence?: number;
    status?: string;
  } = {}
): { id: string; rowid: number } {
  const id = opts.id ?? `test-${Math.random().toString(36).slice(2, 18)}`;
  db.prepare(`
    INSERT INTO artifact (id, kind, title, body, scope, status, confidence, created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
    VALUES (?, ?, ?, ?, 'project', ?, ?, unixepoch() * 1000, unixepoch() * 1000, 'test-session', ?, '{}')
  `).run(
    id,
    opts.kind ?? 'session_log',
    opts.title ?? 'Test Artifact',
    opts.body ?? 'Test artifact body.',
    opts.status ?? 'active',
    opts.confidence ?? 0.6,
    opts.project ?? 'test-project',
  );

  const row = db.prepare(`SELECT rowid FROM artifact WHERE id = ?`).get(id) as { rowid: number } | undefined;
  if (!row) throw new Error(`insertV17Artifact: failed to get rowid for id=${id}`);
  return { id, rowid: row.rowid };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sqlite-vec-backend V17 path (14-07b)', () => {
  let db: Database.Database;
  let vecAvailable: boolean;

  beforeEach(() => {
    db = createDb();
    setVectorStoreDb(db);
    vecAvailable = sqliteVecLoadStatus().succeeded && hasTable(db, 'vec_artifact_v17');
    if (vecAvailable) loadSqliteVec(db);
  });

  afterEach(() => {
    setVectorStoreDb(null);
    try { db.close(); } catch { /* */ }
  });

  describe('upsertArtifactEmbeddingVecV17', () => {
    it('returns false gracefully when db is not set', async () => {
      setVectorStoreDb(null);
      const result = await upsertArtifactEmbeddingVecV17(1, vec(0.5));
      expect(result).toBe(false);
      setVectorStoreDb(db); // restore
    });

    it('writes to vec_artifact_v17 (not vec_artifacts) when vec available', async () => {
      if (!vecAvailable) return;

      const { rowid } = insertV17Artifact(db);

      const legacyCountBefore = (() => {
        try {
          return (db.prepare(`SELECT COUNT(*) AS n FROM vec_artifacts`).get() as { n: number }).n;
        } catch { return 0; }
      })();

      const ok = await upsertArtifactEmbeddingVecV17(rowid, vec(0.3));
      expect(ok).toBe(true);

      // vec_artifact_v17 should have 1 row
      const v17Count = (db.prepare(`SELECT COUNT(*) AS n FROM vec_artifact_v17`).get() as { n: number }).n;
      expect(v17Count).toBe(1);

      // vec_artifacts (legacy) should be unchanged
      const legacyCountAfter = (() => {
        try {
          return (db.prepare(`SELECT COUNT(*) AS n FROM vec_artifacts`).get() as { n: number }).n;
        } catch { return 0; }
      })();
      expect(legacyCountAfter).toBe(legacyCountBefore);
    });

    it('is idempotent (upsert replaces existing vector)', async () => {
      if (!vecAvailable) return;

      const { rowid } = insertV17Artifact(db);

      await upsertArtifactEmbeddingVecV17(rowid, vec(0.1));
      await upsertArtifactEmbeddingVecV17(rowid, vec(0.9));

      // Only one row should exist for this rowid
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM vec_artifact_v17`).get() as { n: number }).n;
      expect(count).toBe(1);
    });
  });

  describe('searchArtifactsVecV17', () => {
    it('returns empty when no artifacts exist', async () => {
      if (!vecAvailable) return;
      const results = await searchArtifactsVecV17(vec(0.5), 'test-project', 5);
      expect(results).toEqual([]);
    });

    it('returns V17-shaped payload (kind, confidence, status) not legacy shape', async () => {
      if (!vecAvailable) return;

      const { rowid } = insertV17Artifact(db, {
        id: 'v17-shape-test',
        kind: 'handoff',
        confidence: 0.8,
        status: 'active',
        project: 'test-project',
        title: 'V17 Shape Test',
      });

      await upsertArtifactEmbeddingVecV17(rowid, vec(0.5));

      const results = await searchArtifactsVecV17(vec(0.5), 'test-project', 5);
      expect(results).toHaveLength(1);

      const payload = results[0].payload;
      // V17-shaped payload — NOT legacy shape
      expect(payload).toHaveProperty('kind', 'handoff');
      expect(payload).toHaveProperty('confidence', 0.8);
      expect(payload).toHaveProperty('status', 'active');
      expect(payload).toHaveProperty('artifact_id', 'v17-shape-test');
      expect(payload).toHaveProperty('title', 'V17 Shape Test');
      // Legacy fields should NOT be present
      expect(payload).not.toHaveProperty('artifact_type');
      expect(payload).not.toHaveProperty('importance');
    });

    it('filters results by project', async () => {
      if (!vecAvailable) return;

      const a1 = insertV17Artifact(db, { id: 'proj-alpha', project: 'alpha', title: 'Alpha Artifact' });
      const a2 = insertV17Artifact(db, { id: 'proj-beta', project: 'beta', title: 'Beta Artifact' });

      await upsertArtifactEmbeddingVecV17(a1.rowid, vec(0.5));
      await upsertArtifactEmbeddingVecV17(a2.rowid, vec(0.5));

      const alphaResults = await searchArtifactsVecV17(vec(0.5), 'alpha', 10);
      const betaResults = await searchArtifactsVecV17(vec(0.5), 'beta', 10);

      expect(alphaResults).toHaveLength(1);
      expect(alphaResults[0].payload.artifact_id).toBe('proj-alpha');

      expect(betaResults).toHaveLength(1);
      expect(betaResults[0].payload.artifact_id).toBe('proj-beta');
    });

    it('filters by kind', async () => {
      if (!vecAvailable) return;

      const a1 = insertV17Artifact(db, { id: 'kind-handoff', kind: 'handoff', project: 'p' });
      const a2 = insertV17Artifact(db, { id: 'kind-learning', kind: 'learning', project: 'p' });

      await upsertArtifactEmbeddingVecV17(a1.rowid, vec(0.5));
      await upsertArtifactEmbeddingVecV17(a2.rowid, vec(0.5));

      const results = await searchArtifactsVecV17(vec(0.5), 'p', 10, { kinds: ['handoff'] });
      expect(results).toHaveLength(1);
      expect(results[0].payload.kind).toBe('handoff');
    });

    it('filters by minimum confidence', async () => {
      if (!vecAvailable) return;

      const a1 = insertV17Artifact(db, { id: 'conf-low', confidence: 0.2, project: 'p', title: 'Low Confidence' });
      const a2 = insertV17Artifact(db, { id: 'conf-high', confidence: 0.8, project: 'p', title: 'High Confidence' });

      await upsertArtifactEmbeddingVecV17(a1.rowid, vec(0.5));
      await upsertArtifactEmbeddingVecV17(a2.rowid, vec(0.5));

      const results = await searchArtifactsVecV17(vec(0.5), 'p', 10, { minConfidence: 0.5 });
      expect(results.map(r => r.payload.artifact_id)).toContain('conf-high');
      expect(results.map(r => r.payload.artifact_id)).not.toContain('conf-low');
    });

    it('ranks closer vectors higher (score ordering)', async () => {
      if (!vecAvailable) return;

      const a1 = insertV17Artifact(db, { id: 'rank-a', project: 'p', title: 'Rank A' });
      const a2 = insertV17Artifact(db, { id: 'rank-b', project: 'p', title: 'Rank B' });
      const a3 = insertV17Artifact(db, { id: 'rank-c', project: 'p', title: 'Rank C' });

      await upsertArtifactEmbeddingVecV17(a1.rowid, vec(0.1));
      await upsertArtifactEmbeddingVecV17(a2.rowid, vec(0.9));
      await upsertArtifactEmbeddingVecV17(a3.rowid, vec(0.15));

      // Query close to 0.12 — a1 (0.1) closest, then a3 (0.15), then a2 (0.9)
      const results = await searchArtifactsVecV17(vec(0.12), 'p', 3);
      expect(results.length).toBe(3);
      expect(results[0].payload.artifact_id).toBe('rank-a');
      expect(results[1].payload.artifact_id).toBe('rank-c');
      expect(results[2].payload.artifact_id).toBe('rank-b');
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });

    it('score is a positive number (distanceToScore returns > 0)', async () => {
      if (!vecAvailable) return;

      const a1 = insertV17Artifact(db, { project: 'p' });
      await upsertArtifactEmbeddingVecV17(a1.rowid, vec(0.5));

      const results = await searchArtifactsVecV17(vec(0.5), 'p', 5);
      expect(results.length).toBe(1);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('does not read from legacy vec_artifacts or artifacts tables', async () => {
      if (!vecAvailable) return;

      // Insert a V17 artifact WITHOUT a legacy artifacts row
      const a1 = insertV17Artifact(db, { id: 'v17-only', project: 'p', title: 'V17 Only' });
      await upsertArtifactEmbeddingVecV17(a1.rowid, vec(0.5));

      // searchArtifactsVecV17 should find it via V17 JOIN, not legacy JOIN
      const results = await searchArtifactsVecV17(vec(0.5), 'p', 5);
      expect(results.length).toBe(1);
      expect(results[0].payload.artifact_id).toBe('v17-only');
      expect(results[0].payload.title).toBe('V17 Only');
    });
  });
});
