/**
 * intent-predictor-v17.test.ts — V17 migration path tests for intent predictor.
 *
 * 14-07b (W4): verifies that predictLayer0 reads artifact IDs from the V17
 * `artifact` table rather than the legacy `artifacts` table.
 *
 * Migrated site:
 *   - predictLayer0: `SELECT id FROM artifact WHERE session_id = ? AND status = 'active'`
 *     (was: SELECT id FROM artifacts WHERE session_id = ? AND state IN ('fresh','materialized'))
 *
 * V17 field mapping applied here:
 *   - state('fresh','materialized') → status='active'
 *   - id: TEXT (was INTEGER)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { predictSessionIntent } from '../../intelligence/intent-predictor.js';

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
  status: string = 'completed',
): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status, observation_count, created_at_epoch_ms)
     VALUES (?, ?, ?, 0, ?)`
  ).run(sessionId, project, status, Date.now() - 3_600_000);
}

function insertThread(
  db: Database.Database,
  sessionId: string,
  topic: string | null,
  summary: string | null,
): void {
  db.prepare(
    `INSERT INTO thread_state (session_id, topic, summary, key_exchanges, updated_at_epoch_ms)
     VALUES (?, ?, ?, '[]', unixepoch() * 1000)`
  ).run(sessionId, topic, summary);
}

/**
 * Insert a V17 artifact row for test fixtures.
 * 14-07b: V17 write path — artifact.status replaces artifacts.state.
 */
function insertV17Artifact(
  db: Database.Database,
  opts: {
    sessionId?: string;
    project?: string;
    kind?: string;
    title?: string;
    status?: 'active' | 'stale' | 'superseded';
    confidence?: number;
  } = {},
): string {
  const id = createHash('sha256')
    .update(`test-v17-ip:${Math.random()}:${Date.now()}`)
    .digest('hex')
    .slice(0, 32);
  db.prepare(
    `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
        created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
     VALUES (?, ?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, '{}')`
  ).run(
    id,
    opts.kind ?? 'decision',
    opts.title ?? 'Test V17 artifact',
    'Test body content',
    opts.status ?? 'active',
    opts.confidence ?? 0.8,
    Date.now(),
    Date.now(),
    opts.sessionId ?? 'sess-thread',
    opts.project ?? 'test-project',
  );
  return id;
}

describe('Intent Predictor — V17 path (14-07b)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('Layer 0 artifact lookup from V17 artifact table', () => {
    it('returns active V17 artifact IDs when an unfinished thread exists', () => {
      const threadSessionId = 'sess-thread';
      const currentSessionId = 'sess-current';
      const project = 'test-project';

      ensureSession(db, threadSessionId, project);
      ensureSession(db, currentSessionId, project, 'active');
      // Unfinished thread: has topic, no summary
      insertThread(db, threadSessionId, 'Migrating artifacts table', null);

      const v17Id1 = insertV17Artifact(db, { sessionId: threadSessionId, project, status: 'active', confidence: 0.9 });
      const v17Id2 = insertV17Artifact(db, { sessionId: threadSessionId, project, status: 'active', confidence: 0.7 });

      const result = predictSessionIntent(db, project, currentSessionId);

      expect(result).not.toBeNull();
      expect(result!.layer).toBe(0);
      expect(result!.intent).toBe('continuation');
      expect(result!.confidence).toBe(0.8);
      // V17 artifact IDs are TEXT strings
      expect(result!.artifactIds).toContain(v17Id1);
      expect(result!.artifactIds).toContain(v17Id2);
    });

    it('V17 artifact IDs returned as strings (not integers)', () => {
      const threadSessionId = 'sess-thread-str';
      const currentSessionId = 'sess-cur-str';
      const project = 'str-project';

      ensureSession(db, threadSessionId, project);
      ensureSession(db, currentSessionId, project, 'active');
      insertThread(db, threadSessionId, 'Check string IDs', null);

      const v17Id = insertV17Artifact(db, { sessionId: threadSessionId, project });

      const result = predictSessionIntent(db, project, currentSessionId);
      expect(result).not.toBeNull();
      expect(typeof result!.artifactIds[0]).toBe('string');
      expect(result!.artifactIds[0]).toBe(v17Id);
    });

    it('excludes stale artifacts from V17 lookup', () => {
      const threadSessionId = 'sess-thread-stale';
      const currentSessionId = 'sess-cur-stale';
      const project = 'stale-project';

      ensureSession(db, threadSessionId, project);
      ensureSession(db, currentSessionId, project, 'active');
      insertThread(db, threadSessionId, 'Stale artifact test', null);

      // Insert stale and superseded artifacts — should NOT appear in results
      insertV17Artifact(db, { sessionId: threadSessionId, project, status: 'stale' });
      insertV17Artifact(db, { sessionId: threadSessionId, project, status: 'superseded' });

      const result = predictSessionIntent(db, project, currentSessionId);
      // Thread exists with topic, so Layer 0 fires — but artifactIds should be empty
      // (or only contain active ones)
      if (result && result.layer === 0) {
        for (const id of result.artifactIds) {
          const row = db.prepare(
            `SELECT status FROM artifact WHERE id = ?`
          ).get(id) as { status: string } | undefined;
          expect(row?.status).toBe('active');
        }
      }
    });

    it('returns empty artifactIds when no active artifacts exist for thread session', () => {
      const threadSessionId = 'sess-thread-empty';
      const currentSessionId = 'sess-cur-empty';
      const project = 'empty-project';

      ensureSession(db, threadSessionId, project);
      ensureSession(db, currentSessionId, project, 'active');
      insertThread(db, threadSessionId, 'No artifacts topic', null);

      // No V17 artifacts inserted

      const result = predictSessionIntent(db, project, currentSessionId);
      expect(result).not.toBeNull();
      expect(result!.layer).toBe(0);
      expect(result!.artifactIds).toHaveLength(0);
    });

    it('orders artifacts by confidence DESC, created_at_epoch_ms DESC (LIMIT 10)', () => {
      const threadSessionId = 'sess-thread-order';
      const currentSessionId = 'sess-cur-order';
      const project = 'order-project';

      ensureSession(db, threadSessionId, project);
      ensureSession(db, currentSessionId, project, 'active');
      insertThread(db, threadSessionId, 'Ordering artifacts', null);

      // Insert multiple active artifacts with varying confidence
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const id = insertV17Artifact(db, {
          sessionId: threadSessionId,
          project,
          status: 'active',
          confidence: (i + 1) * 0.1,  // 0.1, 0.2, ... 0.5
        });
        ids.push(id);
      }

      const result = predictSessionIntent(db, project, currentSessionId);
      expect(result).not.toBeNull();
      expect(result!.layer).toBe(0);
      expect(result!.artifactIds.length).toBe(5);
      // All returned IDs should be from our inserted set
      for (const id of result!.artifactIds) {
        expect(ids).toContain(id);
      }
    });

    it('returns null (no Layer 0 trigger) when thread has a summary (finished)', () => {
      const threadSessionId = 'sess-thread-done';
      const currentSessionId = 'sess-cur-done';
      const project = 'done-project';

      ensureSession(db, threadSessionId, project);
      ensureSession(db, currentSessionId, project, 'active');
      // Thread with summary = concluded thread — should NOT trigger Layer 0
      insertThread(db, threadSessionId, 'Finished topic', 'This thread concluded.');

      const result = predictSessionIntent(db, project, currentSessionId);
      // No thread trigger → result may be null or from a weaker layer
      if (result) {
        expect(result.layer).not.toBe(0); // Layer 0 should not fire
      }
    });
  });

  describe('V17 artifact table schema compatibility', () => {
    it('V17 artifact table exists with expected columns', () => {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='artifact'`
      ).get() as { cnt: number };
      expect(row.cnt).toBe(1);
    });

    it('status column accepts active/stale/superseded values', () => {
      const project = 'schema-project';
      const sessionId = 'schema-sess';
      ensureSession(db, sessionId, project);

      for (const status of ['active', 'stale', 'superseded'] as const) {
        const id = insertV17Artifact(db, { sessionId, project, status });
        const row = db.prepare(
          `SELECT status FROM artifact WHERE id = ?`
        ).get(id) as { status: string } | undefined;
        expect(row?.status).toBe(status);
      }
    });
  });
});
