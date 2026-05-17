/**
 * batch-reflection-v17.test.ts — V17 migration path tests for batch reflection.
 *
 * 14-07b (W4): verifies that runBatchReflection deduplicates against the V17
 * `artifact` table using the `title` column (was `summary` in legacy `artifacts`).
 *
 * Migrated site:
 *   - runBatchReflection dedup: `SELECT id FROM artifact WHERE project = ? AND title = ? LIMIT 1`
 *     (was: SELECT id FROM artifacts WHERE project = ? AND summary = ? LIMIT 1)
 *
 * V17 field mapping:
 *   - summary → title
 *   - content → body (artifacts still written via createArtifact → legacy, dedup reads V17)
 *
 * Anti-scope: createArtifact() write path is W5 territory. Tests here verify only
 * the dedup SELECT and surrounding pure functions (extractKeywords, clusterLearnings,
 * shouldRunReflection).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  extractKeywords,
  clusterLearnings,
  shouldRunReflection,
} from '../../intelligence/batch-reflection.js';
import type { LearningRow } from '../../core/learnings.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

function ensureSession(
  db: Database.Database,
  sessionId: string,
  project: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status, observation_count, created_at_epoch_ms)
     VALUES (?, ?, 'completed', 0, ?)`
  ).run(sessionId, project, Date.now());
}

/**
 * Insert a V17 artifact row with title for dedup testing.
 * 14-07b: artifact.title replaces legacy artifacts.summary for dedup.
 */
function insertV17ArtifactByTitle(
  db: Database.Database,
  project: string,
  title: string,
  kind: string = 'learning',
): string {
  const id = createHash('sha256')
    .update(`test-reflection:${title}:${project}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 32);
  db.prepare(
    `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
        created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
     VALUES (?, ?, ?, ?, 'project', 'active', 0.8, ?, ?, 'sess-reflection', ?, '{}')`
  ).run(
    id,
    kind,
    title,
    `Body for: ${title}`,
    Date.now(),
    Date.now(),
    project,
  );
  return id;
}

describe('Batch Reflection — V17 path (14-07b)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('V17 dedup SELECT on artifact.title', () => {
    it('can query artifact table by project and title for dedup check', () => {
      const project = 'dedup-project';
      const title = '[Reflection] database, schema, migration — 3 learnings';

      insertV17ArtifactByTitle(db, project, title);

      // This is the migrated dedup query from runBatchReflection
      const existing = db.prepare(
        `SELECT id FROM artifact WHERE project = ? AND title = ? LIMIT 1`
      ).get(project, title) as { id: string } | undefined;

      expect(existing).toBeDefined();
      expect(typeof existing!.id).toBe('string');
    });

    it('returns undefined when no matching artifact title exists (proceed with creation)', () => {
      const project = 'dedup-project-2';

      const existing = db.prepare(
        `SELECT id FROM artifact WHERE project = ? AND title = ? LIMIT 1`
      ).get(project, '[Reflection] nonexistent, theme — 2 learnings') as { id: string } | undefined;

      expect(existing).toBeUndefined();
    });

    it('dedup is project-scoped: same title in different project does not block', () => {
      const title = '[Reflection] auth, session, token — 4 learnings';
      insertV17ArtifactByTitle(db, 'project-A', title);

      // Querying project-B — should NOT find the project-A artifact
      const existing = db.prepare(
        `SELECT id FROM artifact WHERE project = ? AND title = ? LIMIT 1`
      ).get('project-B', title) as { id: string } | undefined;

      expect(existing).toBeUndefined();
    });

    it('V17 artifact table contains title column (not summary)', () => {
      const cols = db.prepare(
        `PRAGMA table_info(artifact)`
      ).all() as Array<{ name: string }>;

      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('title');
      expect(colNames).toContain('body');
      // V17 does not have a 'summary' column
      expect(colNames).not.toContain('summary');
    });
  });

  describe('shouldRunReflection behavior', () => {
    it('returns false when no sessions exist for the project', () => {
      const result = shouldRunReflection(db, 'empty-project');
      expect(result).toBe(false);
    });

    it('returns false when fewer than 10 sessions exist', () => {
      const project = 'sparse-project';
      for (let i = 0; i < 5; i++) {
        ensureSession(db, `sess-${i}`, project);
      }
      const result = shouldRunReflection(db, project);
      expect(result).toBe(false);
    });

    it('returns true when 10 or more sessions exist without a prior reflection guard', () => {
      const project = 'busy-project';
      for (let i = 0; i < 10; i++) {
        ensureSession(db, `sess-busy-${i}`, project);
      }
      const result = shouldRunReflection(db, project);
      expect(result).toBe(true);
    });

    it('returns false after reflection guard is set (checkpoint_tracking)', () => {
      const project = 'guarded-project';
      for (let i = 0; i < 12; i++) {
        ensureSession(db, `sess-guard-${i}`, project);
      }

      // Simulate setting the reflection guard AFTER sessions were created.
      // Sessions use created_at_epoch_ms = Date.now() (milliseconds).
      // Guard uses unixepoch() (seconds). shouldRunReflection converts guard to ms:
      //   lastReflectionEpochMs = guard.last_checkpoint_epoch * 1000
      // We need the guard epoch (in seconds) to be > all session epochs (in ms / 1000).
      // So set it to now + 2 seconds to ensure it's strictly after the sessions.
      const futureEpochSec = Math.floor(Date.now() / 1000) + 2;
      const guardKey = `__reflection_guard__${project}`;
      db.prepare(
        `INSERT INTO checkpoint_tracking (session_id, last_checkpoint_epoch, updated_at_epoch)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_checkpoint_epoch = excluded.last_checkpoint_epoch,
           updated_at_epoch = excluded.updated_at_epoch`
      ).run(guardKey, futureEpochSec, futureEpochSec);

      // Guard epoch (sec) * 1000 > all session created_at_epoch_ms → count = 0 < 10
      const result = shouldRunReflection(db, project);
      expect(result).toBe(false);
    });
  });

  describe('extractKeywords (pure function — unchanged)', () => {
    it('extracts meaningful keywords from text', () => {
      const kw = extractKeywords('The database migration uses SQLite and artifact tables');
      expect(kw).toContain('database');
      expect(kw).toContain('migration');
      expect(kw).toContain('sqlite');
      expect(kw).toContain('artifact');
      expect(kw).toContain('tables');
      // Stop words should not appear
      expect(kw).not.toContain('the');
      expect(kw).not.toContain('and');
    });

    it('returns unique keywords', () => {
      const kw = extractKeywords('database database database schema');
      const dbCount = kw.filter(w => w === 'database').length;
      expect(dbCount).toBe(1);
    });

    it('filters short tokens and numbers', () => {
      const kw = extractKeywords('run it 42 times in abc');
      expect(kw).not.toContain('it');
      expect(kw).not.toContain('42');
      expect(kw).not.toContain('in');
    });

    it('returns empty array for stop-word-only text', () => {
      const kw = extractKeywords('the a an is are was were');
      expect(kw).toHaveLength(0);
    });
  });

  describe('clusterLearnings (pure function — unchanged)', () => {
    it('returns empty array for empty input', () => {
      expect(clusterLearnings([])).toHaveLength(0);
    });

    it('returns empty array when all learnings have < 2 items (single-item clusters filtered)', () => {
      // Items must have keywords that don't overlap to stay as separate clusters
      const learnings: LearningRow[] = [
        { id: 1, content: 'alpha beta gamma uniqueA', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 3 },
        { id: 2, content: 'delta epsilon zeta uniqueB', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 3 },
      ];
      const clusters = clusterLearnings(learnings);
      // Each item goes to its own cluster → both have 1 item → filtered out
      expect(clusters).toHaveLength(0);
    });

    it('clusters learnings with keyword overlap into the same cluster', () => {
      const learnings: LearningRow[] = [
        { id: 1, content: 'database migration schema artifact tables important', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 4 },
        { id: 2, content: 'database schema migration artifact significant', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 3 },
        { id: 3, content: 'completely different topic about cooking recipes food', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 3 },
        { id: 4, content: 'recipes cooking food kitchen different', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 3 },
      ];
      const clusters = clusterLearnings(learnings);
      // Should produce at most 2 clusters (db-related and cooking-related)
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      // Each cluster must have 2+ items
      for (const cluster of clusters) {
        expect(cluster.items.length).toBeGreaterThanOrEqual(2);
        expect(cluster.keywords.length).toBeGreaterThan(0);
        expect(cluster.theme).toContain('Theme:');
      }
    });

    it('produces themes with top keywords', () => {
      const learnings: LearningRow[] = [
        { id: 1, content: 'artifact schema database migration critical upgrade', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 5 },
        { id: 2, content: 'artifact database schema upgrade important migration', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 4 },
        { id: 3, content: 'migration schema artifact upgrade essential important', project: 'p', session_id: 's', created_at_epoch_ms: Date.now(), importance: 4 },
      ];
      const clusters = clusterLearnings(learnings);
      expect(clusters.length).toBeGreaterThan(0);
      const theme = clusters[0].theme;
      expect(theme).toMatch(/^Theme:/);
      // Should mention count of learnings
      expect(theme).toContain('learnings');
    });
  });
});
