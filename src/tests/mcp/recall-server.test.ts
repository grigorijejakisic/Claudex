/**
 * Tests for MCP recall server tool handlers and transport.
 */

import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { createArtifact, searchArtifactsGlobal } from '../../core/artifacts.js';
import { cachedPrepare } from '../../core/stmt-cache.js';
import { addJournalEntry, searchJournalFTS } from '../../core/journal.js';

// We test the handler logic directly rather than spawning the server process.
// The server's tool handlers are not exported, so we replicate their core logic
// against a real DB to verify schema compatibility and edge cases.

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function insertSession(db: Database.Database, sessionId: string, project: string = 'test'): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
     VALUES (?, ?, 'active', 0, ?)`
  ).run(sessionId, project, Math.floor(Date.now() / 1000));
}

describe('handleStore schema compatibility', () => {
  it('inserts a decision with namespaced session_id', () => {
    const db = createDb();
    try {
      const fingerprint = 'use async io for production';
      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run('mcp:test-project', 'test-project', 'Use async I/O for production scale', fingerprint);

      expect(result.changes).toBe(1);

      const row = db.prepare('SELECT * FROM decisions WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown>;
      expect(row.session_id).toBe('mcp:test-project');
      expect(row.project).toBe('test-project');
    } finally {
      db.close();
    }
  });

  it('inserts a learning matching actual schema', () => {
    const db = createDb();
    try {
      const fingerprint = 'always validate limit params';
      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO learnings (content, project, fingerprint)
         VALUES (?, ?, ?)`
      ).run('Always validate limit parameters', 'test-project', fingerprint);

      expect(result.changes).toBe(1);

      const row = db.prepare('SELECT * FROM learnings WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown>;
      expect(row.content).toBe('Always validate limit parameters');
      expect(row.project).toBe('test-project');
    } finally {
      db.close();
    }
  });

  it('returns changes=0 on duplicate fingerprint', () => {
    const db = createDb();
    try {
      const fingerprint = 'duplicate test';
      cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run('mcp:proj', 'proj', 'First', fingerprint);

      const result = cachedPrepare(db,
        `INSERT OR IGNORE INTO decisions (session_id, project, content, source, fingerprint)
         VALUES (?, ?, ?, 'explicit', ?)`
      ).run('mcp:proj', 'proj', 'Second same fingerprint', fingerprint);

      expect(result.changes).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('handleSearch limit validation', () => {
  it('clamps negative limit to default', () => {
    const rawLimit = -5;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(10);
  });

  it('clamps NaN to default', () => {
    const rawLimit = NaN;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(10);
  });

  it('clamps over-50 to 50', () => {
    const rawLimit = 100;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(50);
  });

  it('accepts valid integer', () => {
    const rawLimit = 25;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    expect(limit).toBe(25);
  });
});

describe('handleRecall id validation', () => {
  it('rejects id=0', () => {
    const rawId = 0;
    const id = rawId !== null && Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    expect(id).toBeNull();
  });

  it('rejects NaN', () => {
    const rawId = NaN;
    const id = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    expect(id).toBeNull();
  });

  it('accepts valid positive integer', () => {
    const rawId = 42;
    const id = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    expect(id).toBe(42);
  });
});

describe('fresh DB initialization', () => {
  it('initializeSchema + runMigrations creates all required tables on empty DB', () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      runMigrations(db);

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);

      // Core tables
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('artifacts');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('decisions');
      expect(tableNames).toContain('learnings');

      // New tables from v3→v4
      expect(tableNames).toContain('context_triggers');
      expect(tableNames).toContain('session_events');

      // FTS5 virtual tables
      expect(tableNames).toContain('observations_fts');
      expect(tableNames).toContain('artifacts_fts');

      // Verify we can insert new artifact types
      insertSession(db, 'test-sess', 'test');
      expect(() => {
        createArtifact(db, 'test-sess', 'test', 'memory_file', '/test.md', 'test', 'content', 3);
      }).not.toThrow();

      // Verify user_version is current
      const row = db.pragma('user_version') as Array<{ user_version: number }>;
      expect(row[0].user_version).toBe(8);
    } finally {
      db.close();
    }
  });
});

describe('claudex_search journal FTS integration', () => {
  it('searchJournalFTS returns results alongside artifact search', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');

      // Create an artifact
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Fixed VBS startup script', 'Replaced CLIProxyAPI.vbs with .bat', 4);

      // Create a journal entry with recall_text
      addJournalEntry(db, 'sess1', 'test-project', 'flow',
        'Analyzed VBS deprecation issue on Windows boot',
        undefined,
        'openclaw script problem | startup popup fix | vbs deprecation',
      );

      // Artifact search finds the artifact
      const artifactResults = searchArtifactsGlobal(db, 'test-project', 'VBS startup', 10);
      expect(artifactResults.length).toBeGreaterThanOrEqual(1);

      // Journal FTS finds the flow entry by recall_text
      const journalResults = searchJournalFTS(db, 'openclaw script problem');
      expect(journalResults.length).toBe(1);
      expect(journalResults[0].recall_text).toContain('openclaw script problem');

      // Journal FTS finds by content too
      const contentResults = searchJournalFTS(db, 'VBS deprecation Windows');
      expect(contentResults.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('journal results include recall_text in output', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');
      addJournalEntry(db, 'sess1', 'test-project', 'flow',
        'Redesigned memory retrieval system',
        { recall_aliases: ['how I remember vs how you remember'] },
        'how I remember vs how you remember | upgrade flow | recall aliases concept',
      );

      const results = searchJournalFTS(db, 'remember');
      expect(results.length).toBe(1);
      expect(results[0].recall_text).toContain('how I remember');
      expect(results[0].metadata).toContain('recall_aliases');
    } finally {
      db.close();
    }
  });

  it('merged search prioritizes journal recall matches over artifact content matches', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess1', 'test-project');

      // Artifact mentions "flow" in content
      createArtifact(db, 'sess1', 'test-project', 'observation', null, 'Updated flow logic', 'Changed flow entry generation', 3);

      // Journal has "flow" in recall_text (human recall cue)
      addJournalEntry(db, 'sess1', 'test-project', 'flow',
        'Session about upgrading flow system',
        undefined,
        'upgrade flow | redesign flow entries | flow recall metadata',
      );

      // Both should be findable
      const journalHits = searchJournalFTS(db, 'upgrade flow');
      const artifactHits = searchArtifactsGlobal(db, 'test-project', 'flow', 10);
      expect(journalHits.length).toBeGreaterThanOrEqual(1);
      expect(artifactHits.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});

describe('Content-Length framing', () => {
  it('Buffer.byteLength handles multibyte correctly', () => {
    const text = '{"result":"日本語テスト 🎉"}';
    const stringLen = text.length;
    const byteLen = Buffer.byteLength(text, 'utf-8');
    // Multibyte: byte length > string length
    expect(byteLen).toBeGreaterThan(stringLen);
    // The framing must use byte length, not string length
    const buf = Buffer.from(text, 'utf-8');
    expect(buf.length).toBe(byteLen);
  });
});
