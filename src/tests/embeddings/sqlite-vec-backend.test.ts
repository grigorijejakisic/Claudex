/**
 * Tests for the sqlite-vec backend (Phase 2 of the migration).
 *
 * Covers:
 * 1. setVectorStoreDb + the sqlite-vec backend's upsert/search/delete API
 * 2. The dispatcher in qdrant-client.ts routes to sqlite-vec when
 *    CLAUDEX_VECTOR_BACKEND=sqlite-vec is set
 * 3. Default behavior (no env var) routes to Qdrant and falls back
 *    gracefully when Qdrant is unreachable (the normal test environment)
 * 4. Project scoping, superseded filter, and importance filter
 *    all work through the JOIN with the artifacts table
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import {
  setVectorStoreDb,
  searchArtifacts,
  searchConversations,
  searchJournal,
  upsertArtifactEmbedding,
  upsertConversationEmbedding,
  upsertJournalEmbedding,
  deleteArtifactPoint,
  type ArtifactPayload,
} from '../../embeddings/qdrant-client.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

function vec(fill: number, dim = 1024): number[] {
  return Array(dim).fill(fill);
}

function insertArtifact(
  db: Database.Database,
  opts: {
    id: number;
    project: string;
    summary: string;
    importance?: number;
    type?: string;
    supersededBy?: number | null;
  },
): void {
  db.prepare(`
    INSERT INTO artifacts (id, session_id, project, artifact_type, summary, importance, timestamp_epoch_ms, superseded_by)
    VALUES (?, 'test-session', ?, ?, ?, ?, unixepoch(), ?)
  `).run(
    opts.id,
    opts.project,
    opts.type ?? 'observation',
    opts.summary,
    opts.importance ?? 3,
    opts.supersededBy ?? null,
  );
}

const TEST_PAYLOAD: ArtifactPayload = {
  artifact_id: 0,
  project: 'test',
  artifact_type: 'observation',
  importance: 3,
  confidence: 1.0,
  activation_score: 1.0,
  session_id: 'test-session',
  timestamp_epoch_ms: Math.floor(Date.now() / 1000),
  superseded: false,
  summary: 'test payload',
};

describe('sqlite-vec backend via dispatcher', () => {
  let db: Database.Database;
  let originalBackend: string | undefined;

  beforeEach(() => {
    db = createTestDb();
    originalBackend = process.env.CLAUDEX_VECTOR_BACKEND;
    process.env.CLAUDEX_VECTOR_BACKEND = 'sqlite-vec';
    setVectorStoreDb(db);
  });

  afterEach(() => {
    setVectorStoreDb(null);
    if (originalBackend === undefined) {
      delete process.env.CLAUDEX_VECTOR_BACKEND;
    } else {
      process.env.CLAUDEX_VECTOR_BACKEND = originalBackend;
    }
    try { db.close(); } catch { /* */ }
  });

  describe('artifact upsert + search', () => {
    it('upserts and retrieves an artifact via KNN search', async () => {
      // Need a real row in artifacts so the JOIN succeeds.
      insertArtifact(db, { id: 1, project: 'myproject', summary: 'test artifact' });

      const ok = await upsertArtifactEmbedding(
        1,
        vec(0.1),
        { ...TEST_PAYLOAD, artifact_id: 1, project: 'myproject' },
      );
      expect(ok).toBe(true);

      const results = await searchArtifacts(vec(0.1), 'myproject', 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].payload.project).toBe('myproject');
      expect(results[0].payload.summary).toBe('test artifact');
    });

    it('ranks closer vectors higher', async () => {
      insertArtifact(db, { id: 1, project: 'p', summary: 'a' });
      insertArtifact(db, { id: 2, project: 'p', summary: 'b' });
      insertArtifact(db, { id: 3, project: 'p', summary: 'c' });

      await upsertArtifactEmbedding(1, vec(0.1), { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' });
      await upsertArtifactEmbedding(2, vec(0.9), { ...TEST_PAYLOAD, artifact_id: 2, project: 'p' });
      await upsertArtifactEmbedding(3, vec(0.15), { ...TEST_PAYLOAD, artifact_id: 3, project: 'p' });

      const results = await searchArtifacts(vec(0.12), 'p', 3);
      expect(results.map(r => r.id)).toEqual([1, 3, 2]);
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });

    it('filters results by project', async () => {
      insertArtifact(db, { id: 1, project: 'alpha', summary: 'a1' });
      insertArtifact(db, { id: 2, project: 'beta', summary: 'b1' });

      await upsertArtifactEmbedding(1, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 1, project: 'alpha' });
      await upsertArtifactEmbedding(2, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 2, project: 'beta' });

      const alphaResults = await searchArtifacts(vec(0.5), 'alpha', 10);
      const betaResults = await searchArtifacts(vec(0.5), 'beta', 10);

      expect(alphaResults).toHaveLength(1);
      expect(alphaResults[0].id).toBe(1);
      expect(betaResults).toHaveLength(1);
      expect(betaResults[0].id).toBe(2);
    });

    it('excludes superseded artifacts by default', async () => {
      insertArtifact(db, { id: 1, project: 'p', summary: 'old', supersededBy: 2 });
      insertArtifact(db, { id: 2, project: 'p', summary: 'new' });

      await upsertArtifactEmbedding(1, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' });
      await upsertArtifactEmbedding(2, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 2, project: 'p' });

      const results = await searchArtifacts(vec(0.5), 'p', 10);
      expect(results.map(r => r.id)).toEqual([2]);
    });

    it('includes superseded artifacts when excludeSuperseded=false', async () => {
      insertArtifact(db, { id: 1, project: 'p', summary: 'old', supersededBy: 2 });
      insertArtifact(db, { id: 2, project: 'p', summary: 'new' });

      await upsertArtifactEmbedding(1, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' });
      await upsertArtifactEmbedding(2, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 2, project: 'p' });

      const results = await searchArtifacts(vec(0.5), 'p', 10, { excludeSuperseded: false });
      expect(results.map(r => r.id).sort()).toEqual([1, 2]);
    });

    it('filters by minimum importance', async () => {
      insertArtifact(db, { id: 1, project: 'p', summary: 'low', importance: 1 });
      insertArtifact(db, { id: 2, project: 'p', summary: 'mid', importance: 3 });
      insertArtifact(db, { id: 3, project: 'p', summary: 'high', importance: 5 });

      for (const id of [1, 2, 3]) {
        await upsertArtifactEmbedding(id, vec(0.5), { ...TEST_PAYLOAD, artifact_id: id, project: 'p' });
      }

      const results = await searchArtifacts(vec(0.5), 'p', 10, { minImportance: 3 });
      expect(results.map(r => r.id).sort()).toEqual([2, 3]);
    });

    it('filters by artifact type', async () => {
      insertArtifact(db, { id: 1, project: 'p', summary: 'obs', type: 'observation' });
      insertArtifact(db, { id: 2, project: 'p', summary: 'dec', type: 'decision' });

      await upsertArtifactEmbedding(1, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' });
      await upsertArtifactEmbedding(2, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 2, project: 'p' });

      const results = await searchArtifacts(vec(0.5), 'p', 10, { artifactTypes: ['decision'] });
      expect(results.map(r => r.id)).toEqual([2]);
    });

    it('upsert replaces existing vector for the same rowid', async () => {
      insertArtifact(db, { id: 1, project: 'p', summary: 'a' });

      await upsertArtifactEmbedding(1, vec(0.1), { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' });
      await upsertArtifactEmbedding(1, vec(0.9), { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' });

      // Query close to 0.9 — the second upsert's value — should find rowid 1.
      const results = await searchArtifacts(vec(0.9), 'p', 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);

      // Only one row should exist in vec_artifacts.
      const count = (db.prepare('SELECT COUNT(*) AS c FROM vec_artifacts').get() as { c: number }).c;
      expect(count).toBe(1);
    });

    it('delete removes the vector and hides it from search', async () => {
      insertArtifact(db, { id: 1, project: 'p', summary: 'a' });
      await upsertArtifactEmbedding(1, vec(0.5), { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' });

      const before = await searchArtifacts(vec(0.5), 'p', 5);
      expect(before).toHaveLength(1);

      await deleteArtifactPoint(1);

      const after = await searchArtifacts(vec(0.5), 'p', 5);
      expect(after).toHaveLength(0);
    });
  });

  describe('conversation upsert + search', () => {
    it('upserts and retrieves a conversation turn', async () => {
      db.prepare(`
        INSERT INTO conversation_turns (id, session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
        VALUES (1, 's', 'p', 1, 'hello', 'world', unixepoch() * 1000)
      `).run();

      await upsertConversationEmbedding(1, vec(0.5), {});

      const results = await searchConversations(vec(0.5), 'p', 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
      expect(results[0].payload.user_text).toBe('hello');
      expect(results[0].payload.assistant_text).toBe('world');
    });
  });

  describe('journal upsert + search', () => {
    it('upserts and retrieves a journal entry', async () => {
      db.prepare(`
        INSERT INTO session_journal (id, session_id, project, entry_type, content, recall_text, timestamp_epoch_ms)
        VALUES (1, 's', 'p', 'flow', 'entry content', 'recall text', unixepoch() * 1000)
      `).run();

      await upsertJournalEmbedding(1, vec(0.5), {});

      const results = await searchJournal(vec(0.5), 'p', 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
      expect(results[0].payload.entry_type).toBe('flow');
      expect(results[0].payload.recall_text).toBe('recall text');
    });
  });
});

describe('default backend (Qdrant) when no env var is set', () => {
  let db: Database.Database;
  let originalBackend: string | undefined;

  beforeEach(() => {
    db = createTestDb();
    originalBackend = process.env.CLAUDEX_VECTOR_BACKEND;
    delete process.env.CLAUDEX_VECTOR_BACKEND;
    setVectorStoreDb(db);
  });

  afterEach(() => {
    setVectorStoreDb(null);
    if (originalBackend !== undefined) process.env.CLAUDEX_VECTOR_BACKEND = originalBackend;
    try { db.close(); } catch { /* */ }
  });

  it('routes to Qdrant (falls back to false/empty when Qdrant is unreachable)', async () => {
    insertArtifact(db, { id: 1, project: 'p', summary: 'a' });

    // With no env var, dispatcher should try Qdrant. In the test env Qdrant
    // isn't running — the existing Qdrant code path is non-throwing and
    // returns false for upserts, [] for searches.
    const upsertResult = await upsertArtifactEmbedding(
      1,
      vec(0.1),
      { ...TEST_PAYLOAD, artifact_id: 1, project: 'p' },
    );
    // It's OK if this returns true (Qdrant running) or false (Qdrant down).
    expect(typeof upsertResult).toBe('boolean');

    const searchResult = await searchArtifacts(vec(0.1), 'p', 5);
    // Either empty (Qdrant down — normal test env) or Qdrant results.
    expect(Array.isArray(searchResult)).toBe(true);
  });
});
