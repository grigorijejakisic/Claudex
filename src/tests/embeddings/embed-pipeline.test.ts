/**
 * Tests for embed-pipeline.ts — unified embedding pipeline.
 *
 * Tests verify:
 * - Graceful degradation when Ollama is unavailable
 * - Pipeline functions return safe defaults (null/false)
 * - embedText truncation behavior
 * - SQLite BLOB storage path (embedArtifact, embedPattern, embedJournalEntry)
 * - isSemanticPipelineAvailable reports correctly
 * - Reset function clears state
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../core/migrations.js';
import {
  getEmbeddingProvider,
  resetEmbeddingPipeline,
  embedText,
  embedArtifact,
  embedPattern,
  embedJournalEntry,
  embedQuery,
  isSemanticPipelineAvailable,
} from '../../embeddings/embed-pipeline.js';
import { resetQdrantClient } from '../../embeddings/qdrant-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function insertTestSession(db: Database.Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
     VALUES (?, 'test', 'active', 0, ?)`
  ).run(sessionId, Math.floor(Date.now() / 1000));
}

function insertTestArtifact(db: Database.Database, sessionId: string): number {
  const result = db.prepare(
    `INSERT INTO artifacts (session_id, project, artifact_type, summary, content, importance)
     VALUES (?, 'test', 'observation', 'test summary', 'test content', 3)`
  ).run(sessionId);
  return Number(result.lastInsertRowid);
}

function insertTestPattern(db: Database.Database, patternId: string): void {
  db.prepare(
    `INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
     VALUES (?, 'correction', 'test trigger', 'test lesson', 'test', ?)`
  ).run(patternId, Math.floor(Date.now() / 1000));
}

function insertTestJournalEntry(db: Database.Database, sessionId: string): number {
  const result = db.prepare(
    `INSERT INTO session_journal (session_id, project, entry_type, content)
     VALUES (?, 'test', 'flow', 'test journal entry')`
  ).run(sessionId);
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Provider lifecycle (Ollama unavailable)
// ---------------------------------------------------------------------------

describe('embedding provider (Ollama unavailable)', () => {
  beforeEach(() => {
    resetEmbeddingPipeline();
    resetQdrantClient();
  });

  it('getEmbeddingProvider returns null when Ollama is down', async () => {
    const provider = await getEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:19998', // nothing listening
    });
    expect(provider).toBeNull();
  });

  it('caches null result — second call is instant', async () => {
    await getEmbeddingProvider({ baseUrl: 'http://127.0.0.1:19998' });
    const start = Date.now();
    const result = await getEmbeddingProvider({ baseUrl: 'http://127.0.0.1:19998' });
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(50); // cached, no network call
  });

  it('resetEmbeddingPipeline clears cached state', async () => {
    await getEmbeddingProvider({ baseUrl: 'http://127.0.0.1:19998' });
    resetEmbeddingPipeline();
    // After reset, provider is null but not yet checked
    // Next getEmbeddingProvider will re-check
    const provider = await getEmbeddingProvider({ baseUrl: 'http://127.0.0.1:19998' });
    expect(provider).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// embedText (Ollama unavailable)
// ---------------------------------------------------------------------------

describe('embedText (Ollama unavailable)', () => {
  beforeEach(() => {
    resetEmbeddingPipeline();
  });

  it('returns null when Ollama is down', async () => {
    const result = await embedText('test text', { baseUrl: 'http://127.0.0.1:19998' });
    expect(result).toBeNull();
  });

  it('does not throw on empty input', async () => {
    const result = await embedText('', { baseUrl: 'http://127.0.0.1:19998' });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// embedQuery
// ---------------------------------------------------------------------------

describe('embedQuery', () => {
  beforeEach(async () => {
    resetEmbeddingPipeline();
    // Force provider to cache as unavailable by pointing at a dead URL
    await getEmbeddingProvider({ baseUrl: 'http://127.0.0.1:19998' });
  });

  it('returns null when embeddings unavailable', async () => {
    const result = await embedQuery('search query');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pipeline functions with real DB (Ollama unavailable → returns false)
// ---------------------------------------------------------------------------

describe('pipeline functions with DB (Ollama unavailable)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    resetEmbeddingPipeline();
    resetQdrantClient();
    // Force provider to cache as unavailable
    await getEmbeddingProvider({ baseUrl: 'http://127.0.0.1:19998' });
    db = createTestDb();
    insertTestSession(db, 'test-session');
  });

  it('embedArtifact returns false when embeddings unavailable', async () => {
    const artifactId = insertTestArtifact(db, 'test-session');
    const result = await embedArtifact(db, artifactId, 'test content', {
      project: 'test',
      artifact_type: 'observation',
      importance: 3,
      session_id: 'test-session',
      summary: 'test summary',
    });
    expect(result).toBe(false);

    // Verify no embedding was stored
    const row = db.prepare('SELECT embedding FROM artifacts WHERE id = ?').get(artifactId) as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });

  it('embedPattern returns false when embeddings unavailable', async () => {
    insertTestPattern(db, 'pat-001');
    const result = await embedPattern(db, 'pat-001', 'trigger context', 'lesson text', {
      project: 'test',
      pattern_type: 'correction',
      severity: 'important',
      score: 3,
    });
    expect(result).toBe(false);

    const row = db.prepare('SELECT embedding FROM experience_patterns WHERE id = ?').get('pat-001') as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });

  it('embedJournalEntry returns false when embeddings unavailable', async () => {
    const journalId = insertTestJournalEntry(db, 'test-session');
    const result = await embedJournalEntry(db, journalId, 'journal content', 'recall text', {
      project: 'test',
      session_id: 'test-session',
      entry_type: 'flow',
    });
    expect(result).toBe(false);

    const row = db.prepare('SELECT embedding FROM session_journal WHERE id = ?').get(journalId) as { embedding: Buffer | null };
    expect(row.embedding).toBeNull();
  });

  it('DB tables have embedding columns (V9 schema)', () => {
    const artifactCols = db.pragma('table_info(artifacts)') as Array<{ name: string }>;
    expect(artifactCols.some(c => c.name === 'embedding')).toBe(true);
    expect(artifactCols.some(c => c.name === 'activation_score')).toBe(true);
    expect(artifactCols.some(c => c.name === 'confidence')).toBe(true);
    expect(artifactCols.some(c => c.name === 'novelty_score')).toBe(true);

    const patternCols = db.pragma('table_info(experience_patterns)') as Array<{ name: string }>;
    expect(patternCols.some(c => c.name === 'embedding')).toBe(true);
    expect(patternCols.some(c => c.name === 'verified')).toBe(true);
    expect(patternCols.some(c => c.name === 'verification_count')).toBe(true);

    const threadCols = db.pragma('table_info(thread_state)') as Array<{ name: string }>;
    expect(threadCols.some(c => c.name === 'summary_embedding')).toBe(true);

    const journalCols = db.pragma('table_info(session_journal)') as Array<{ name: string }>;
    expect(journalCols.some(c => c.name === 'embedding')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSemanticPipelineAvailable
// ---------------------------------------------------------------------------

describe('isSemanticPipelineAvailable', () => {
  beforeEach(() => {
    resetEmbeddingPipeline();
    resetQdrantClient();
  });

  it('returns false when nothing is running', async () => {
    expect(await isSemanticPipelineAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V9 schema columns — fresh install
// ---------------------------------------------------------------------------

describe('V10 schema on fresh install', () => {
  it('sets user_version to current TARGET_VERSION (21 after Phase 6.5)', () => {
    const db = createTestDb();
    try {
      const row = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(row[0].user_version).toBe(TARGET_USER_VERSION);
    } finally {
      db.close();
    }
  });

  it('artifacts table has all V9 columns with correct defaults', () => {
    const db = createTestDb();
    try {
      insertTestSession(db, 'test-s');
      const result = db.prepare(
        `INSERT INTO artifacts (session_id, project, artifact_type, summary, importance)
         VALUES ('test-s', 'test', 'observation', 'summary', 3)`
      ).run();
      const row = db.prepare('SELECT activation_score, confidence, novelty_score FROM artifacts WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as { activation_score: number; confidence: number; novelty_score: number };
      expect(row.activation_score).toBe(1.0);
      expect(row.confidence).toBe(1.0);
      expect(row.novelty_score).toBe(0.5);
    } finally {
      db.close();
    }
  });

  it('experience_patterns has V9 columns with correct defaults', () => {
    const db = createTestDb();
    try {
      db.prepare(
        `INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch)
         VALUES ('p1', 'correction', 'ctx', 'lesson', 'test', 1000)`
      ).run();
      const row = db.prepare('SELECT verified, verification_count, abstraction_level FROM experience_patterns WHERE id = ?')
        .get('p1') as { verified: number; verification_count: number; abstraction_level: string };
      expect(row.verified).toBe(0);
      expect(row.verification_count).toBe(0);
      expect(row.abstraction_level).toBe('tip');
    } finally {
      db.close();
    }
  });

  it('V9 tables exist on fresh install', () => {
    const db = createTestDb();
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map(t => t.name);
      expect(names).toContain('artifact_links');
      expect(names).toContain('retrieval_events');
      expect(names).toContain('capability_boundaries');
    } finally {
      db.close();
    }
  });
});
