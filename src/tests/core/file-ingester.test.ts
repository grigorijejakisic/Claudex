/**
 * Tests for the file-to-artifact ingester (Claudex Recall).
 *
 * 14-07b: Updated test fixtures to query V17 artifact table instead of legacy
 * artifacts table. The ingester now writes to artifact (V17 unified schema).
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initializeSchema } from '../../core/migrations.js';
import { ingestFileArtifacts, pruneStaleFileArtifacts } from '../../core/file-ingester.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

function insertSession(db: Database.Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, status, observation_count, created_at_epoch_ms)
     VALUES (?, 'active', 0, ?)`
  ).run(sessionId, Math.floor(Date.now() / 1000));
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-ingester-test-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('ingestFileArtifacts', () => {
  it('ingests markdown files from context/sessions/', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'session-1.md'), '# Session 1\nDid some work on the project.');

      const result = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(result.ingested).toBe(1);
      expect(result.errors).toBe(0);

      // 14-07b: query V17 artifact table (not legacy artifacts)
      const artifacts = db.prepare(
        `SELECT kind, title, status, json_extract(data, '$.artifact_ref') AS artifact_ref
         FROM artifact WHERE kind = 'session_log'`
      ).all() as Array<{ kind: string; title: string; status: string; artifact_ref: string }>;
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].status).toBe('active'); // V17 status (not legacy state='packed')
      expect(artifacts[0].artifact_ref).toContain('session-1.md');
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('skips unchanged files on re-ingestion (mtime stored accurately)', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'session-1.md'), '# Session 1\nDid some work on the project.');

      const r1 = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(r1.ingested).toBe(1);

      // Artifact timestamp_epoch_ms stores the file's mtime (not Date.now())
      // So re-ingestion with unchanged file should skip it
      const r2 = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(r2.ingested).toBe(0);

      // Still only 1 artifact — 14-07b: query V17 artifact table
      const count = db.prepare(`SELECT COUNT(*) as c FROM artifact WHERE kind = 'session_log'`).get() as { c: number };
      expect(count.c).toBe(1);
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('updates artifact when file content changes (new mtime > stored mtime)', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      const filePath = path.join(sessDir, 'session-1.md');
      fs.writeFileSync(filePath, '# Session 1\nOriginal content.');

      await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);

      // Wait >1 second then modify — mtime comparison has 1-second precision
      // (timestamp_epoch_ms stores floor(mtimeMs/1000))
      await new Promise(r => setTimeout(r, 1100));
      fs.writeFileSync(filePath, '# Session 1\nUpdated content with new info.');
      const r2 = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(r2.ingested).toBe(1);

      // Still only 1 artifact (updated, not duplicated) — 14-07b: query V17 artifact table
      const count = db.prepare(`SELECT COUNT(*) as c FROM artifact WHERE kind = 'session_log'`).get() as { c: number };
      expect(count.c).toBe(1);

      // Verify content was actually updated — 14-07b: title stores the summary
      const artifact = db.prepare(`SELECT title FROM artifact WHERE kind = 'session_log'`).get() as { title: string };
      expect(artifact.title).toContain('Updated');
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('ingests handoff files', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const handoffDir = path.join(tmpDir, 'context', 'handoffs');
      fs.mkdirSync(handoffDir, { recursive: true });
      fs.writeFileSync(path.join(handoffDir, 'ACTIVE.md'), '---\nstatus: active\n---\n# Handoff\nSome unfinished work.');

      const result = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(result.ingested).toBe(1);

      // 14-07b: query V17 artifact table (title = summary, kind = artifact_type)
      const artifacts = db.prepare(
        `SELECT title FROM artifact WHERE kind = 'handoff'`
      ).all() as Array<{ title: string }>;
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].title).toContain('Handoff');
      expect(artifacts[0].title).not.toContain('status: active');
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('skips tiny files (<20 chars)', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'tiny.md'), 'short');

      const result = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(result.ingested).toBe(0);
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('returns zero counts when no files exist', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const result = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(result.ingested).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.errors).toBe(0);
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('skips MEMORY.md index file but ingests other .md files', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'MEMORY.md'), '# Memory Index\nThis is the index file and should be skipped by the ingester.');
      fs.writeFileSync(path.join(sessDir, 'real-session.md'), '# Real Session\nActual content here for testing.');

      const result = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(result.ingested).toBe(1);

      const artifacts = db.prepare(
        `SELECT artifact_ref FROM artifacts WHERE artifact_type = 'session_log'`
      ).all() as Array<{ artifact_ref: string }>;
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].artifact_ref).toContain('real-session.md');
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('skips binary files and non-text extensions', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00]));
      fs.writeFileSync(path.join(sessDir, 'valid.md'), '# Valid Session\nThis is a valid markdown file for testing.');

      const result = await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);
      expect(result.ingested).toBe(1);
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });
});

describe('pruneStaleFileArtifacts', () => {
  it('removes artifacts whose files no longer exist', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      const filePath = path.join(sessDir, 'session-1.md');
      fs.writeFileSync(filePath, '# Session 1\nContent for ingestion testing.');

      await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);

      fs.unlinkSync(filePath);

      const pruned = await pruneStaleFileArtifacts(db, 'test-project');
      expect(pruned).toBe(1);

      const count = db.prepare(`SELECT COUNT(*) as c FROM artifacts WHERE artifact_type = 'session_log'`).get() as { c: number };
      expect(count.c).toBe(0);
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });

  it('does not prune artifacts whose files still exist', async () => {
    const db = createDb();
    const tmpDir = createTempDir();
    try {
      insertSession(db, 'sess-1');
      const sessDir = path.join(tmpDir, 'context', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'session-1.md'), '# Session 1\nContent for ingestion testing.');

      await ingestFileArtifacts(db, 'sess-1', 'test-project', tmpDir);

      const pruned = await pruneStaleFileArtifacts(db, 'test-project');
      expect(pruned).toBe(0);
    } finally {
      db.close();
      cleanup(tmpDir);
    }
  });
});
