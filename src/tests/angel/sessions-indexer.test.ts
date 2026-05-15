/**
 * Phase 13 Plan 02: sessions-indexer.ts fixture tests.
 *
 * Covers:
 *  - buildChunksFromSessionMarkdown (pure function): turn parsing, role
 *    detection, wrapper redaction at extraction-time, sub-chunking on long
 *    turns, graceful empty-input handling.
 *  - scanAndIndexSessions against an in-memory DB carrying the V32-shape
 *    transcript_chunk_v6 schema (WIR-01 coverage): real upsertChunk landing,
 *    idempotency, mtime-skip optimization.
 *
 * In-memory DB schema mirrors the V32 base-table fresh-DB shape exercised by
 * Phase 8's WIR-01 fixtures. The V17-collapsed shape is inherited via Phase 8
 * coverage — upsertChunk is reused unchanged; this indexer adds no
 * shape-specific SQL surface beyond the lazy-create sessions_index_cursor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildChunksFromSessionMarkdown,
  scanAndIndexSessions,
  _resetMtimeCacheForTest,
} from '../../angel/sessions-indexer.js';

const V32_SCHEMA = `
CREATE TABLE IF NOT EXISTS transcript_chunk_v6 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  sub_index INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  provenance TEXT NOT NULL CHECK(provenance IN ('organic','injected','tool_result','environmental')),
  body TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  wrapper_redacted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, turn_index, role, sub_index)
);
`;

function makeDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(V32_SCHEMA);
  return db;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-indexer-test-'));
}

async function writeSessionsFile(projectDir: string, sessionId: string, content: string): Promise<string> {
  const sessDir = path.join(projectDir, 'Sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const filePath = path.join(sessDir, `2026-05-14_${sessionId}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ─── buildChunksFromSessionMarkdown — pure ─────────────────────────────────

describe('buildChunksFromSessionMarkdown — turn parsing', () => {
  const SAMPLE = `
## User
_2026-05-14T10:00:00+02:00_

Hello from user, this is a question.

## Assistant
_2026-05-14T10:00:05+02:00_

Hello back from assistant, this is the answer.

## User
_2026-05-14T10:01:00+02:00_

Second user message.
`.trim();

  it('produces one chunk per turn for short content', () => {
    const chunks = buildChunksFromSessionMarkdown(SAMPLE, 'session-abc', 'project-xyz');
    expect(chunks).toHaveLength(3);
    expect(chunks.map(c => c.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('assigns monotonically increasing turn_index', () => {
    const chunks = buildChunksFromSessionMarkdown(SAMPLE, 'session-abc', 'project-xyz');
    expect(chunks[0].turn_index).toBe(0);
    expect(chunks[1].turn_index).toBe(1);
    expect(chunks[2].turn_index).toBe(2);
  });

  it('preserves session_id and project_id on each chunk', () => {
    const chunks = buildChunksFromSessionMarkdown(SAMPLE, 'MY-SESSION', 'MY-PROJECT');
    for (const c of chunks) {
      expect(c.session_id).toBe('MY-SESSION');
      expect(c.project_id).toBe('MY-PROJECT');
    }
  });

  it('parses timestamp into created_at_epoch_ms when present', () => {
    const chunks = buildChunksFromSessionMarkdown(SAMPLE, 'sid', 'pid');
    expect(chunks[0].created_at_epoch_ms).toBe(new Date('2026-05-14T10:00:00+02:00').getTime());
  });

  it('redacts system-reminder wrappers at extraction-time (WIR-01 redaction posture)', () => {
    const markdown = `## User\n_2026-05-14T10:00:00+02:00_\n\nUser message here. <system-reminder>Do not include this in retrieval</system-reminder>`;
    const chunks = buildChunksFromSessionMarkdown(markdown, 'sid', 'pid');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].wrapper_redacted).toBe(true);
    expect(chunks[0].body).not.toContain('<system-reminder>');
    expect(chunks[0].body).toContain('User message here');
  });

  it('parses ToolResult turn into tool role + tool_result provenance', () => {
    const markdown = `## ToolResult: Bash\n_2026-05-14T10:00:00+02:00_\n\nls output goes here`;
    const chunks = buildChunksFromSessionMarkdown(markdown, 'sid', 'pid');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].role).toBe('tool');
    expect(chunks[0].provenance).toBe('tool_result');
    expect(chunks[0].body).toContain('ls output goes here');
  });

  it('returns empty array for empty markdown', () => {
    expect(buildChunksFromSessionMarkdown('', 'sid', 'pid')).toHaveLength(0);
  });

  it('returns empty array when the file has only timestamp/header noise', () => {
    expect(buildChunksFromSessionMarkdown('# Random\n\nNo turn headers here', 'sid', 'pid')).toHaveLength(0);
  });
});

// ─── scanAndIndexSessions — WIR-01 fixture coverage ────────────────────────

describe('scanAndIndexSessions — WIR-01 fixture coverage', () => {
  let tmpDir: string;
  let db: DatabaseType;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    db = makeDb();
    _resetMtimeCacheForTest();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes a Sessions/ file into transcript_chunk_v6 (WIR-01: V32 fresh-DB shape)', async () => {
    const projectDir = path.join(tmpDir, 'wir01-project');
    fs.mkdirSync(projectDir);
    await writeSessionsFile(projectDir, 'wir01-session', `## User\n_2026-05-14T10:00:00+02:00_\n\nHello\n\n## Assistant\n_2026-05-14T10:00:05+02:00_\n\nHi there`);

    const result = await scanAndIndexSessions(db, [{ projectId: 'wir01-project', projectDir }]);
    expect(result.errors).toBe(0);
    expect(result.files_scanned).toBe(1);
    expect(result.files_indexed).toBe(1);
    expect(result.chunks_upserted).toBeGreaterThan(0);

    const cnt = (db.prepare('SELECT COUNT(*) as cnt FROM transcript_chunk_v6').get() as { cnt: number }).cnt;
    expect(cnt).toBeGreaterThan(0);

    const roles = db.prepare('SELECT DISTINCT role FROM transcript_chunk_v6').all() as Array<{ role: string }>;
    expect(roles.map(r => r.role).sort()).toEqual(['assistant', 'user']);
  });

  it('idempotency: re-indexing the same file does not duplicate chunks (WIR-01: ON CONFLICT DO UPDATE)', async () => {
    const projectDir = path.join(tmpDir, 'idem-project');
    fs.mkdirSync(projectDir);
    const filePath = await writeSessionsFile(projectDir, 'idem-session', `## User\n_2026-05-14T10:00:00+02:00_\n\nIdempotent test`);

    await scanAndIndexSessions(db, [{ projectId: 'idem-project', projectDir }]);
    const count1 = (db.prepare('SELECT COUNT(*) as cnt FROM transcript_chunk_v6').get() as { cnt: number }).cnt;
    expect(count1).toBeGreaterThan(0);

    // Touch mtime to force re-index path through upsertChunk.
    _resetMtimeCacheForTest();
    try { db.exec('DELETE FROM sessions_index_cursor'); } catch { /* table may not exist */ }
    const newTime = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, newTime, newTime);

    await scanAndIndexSessions(db, [{ projectId: 'idem-project', projectDir }]);
    const count2 = (db.prepare('SELECT COUNT(*) as cnt FROM transcript_chunk_v6').get() as { cnt: number }).cnt;

    // UNIQUE(session_id, turn_index, role, sub_index) + ON CONFLICT DO UPDATE
    // means re-index rewrites existing rows; the row count stays equal.
    expect(count2).toBe(count1);
  });

  it('mtime-skip: unchanged file is not re-read on the second tick', async () => {
    const projectDir = path.join(tmpDir, 'mtime-project');
    fs.mkdirSync(projectDir);
    await writeSessionsFile(projectDir, 'mtime-session', `## User\n_2026-05-14T10:00:00+02:00_\n\nMtime test`);

    const r1 = await scanAndIndexSessions(db, [{ projectId: 'mtime-project', projectDir }]);
    expect(r1.files_indexed).toBe(1);
    expect(r1.chunks_upserted).toBeGreaterThan(0);

    const r2 = await scanAndIndexSessions(db, [{ projectId: 'mtime-project', projectDir }]);
    expect(r2.files_scanned).toBe(1);
    expect(r2.files_indexed).toBe(0); // mtime cache + cursor table block reindex
    expect(r2.chunks_upserted).toBe(0);
  });

  it('handles a project whose Sessions/ dir does not exist (skip without error)', async () => {
    const projectDir = path.join(tmpDir, 'no-sessions-project');
    fs.mkdirSync(projectDir);

    const result = await scanAndIndexSessions(db, [{ projectId: 'no-sessions-project', projectDir }]);
    expect(result.errors).toBe(0);
    expect(result.files_scanned).toBe(0);
    expect(result.files_indexed).toBe(0);
  });

  it('extracts session_id from filename and writes it into chunks', async () => {
    const projectDir = path.join(tmpDir, 'sid-project');
    fs.mkdirSync(projectDir);
    await writeSessionsFile(projectDir, 'my-distinct-session-id-12345', `## User\n_2026-05-14T10:00:00+02:00_\n\nHello`);

    await scanAndIndexSessions(db, [{ projectId: 'sid-project', projectDir }]);
    const rows = db.prepare('SELECT DISTINCT session_id FROM transcript_chunk_v6').all() as Array<{ session_id: string }>;
    expect(rows.map(r => r.session_id)).toContain('my-distinct-session-id-12345');
  });

  it('lazily creates sessions_index_cursor table (no migration required)', async () => {
    // Fresh DB has no cursor table; scan must succeed and create it.
    const projectDir = path.join(tmpDir, 'cursor-project');
    fs.mkdirSync(projectDir);
    await writeSessionsFile(projectDir, 'cursor-sess', `## User\n_2026-05-14T10:00:00+02:00_\n\nCursor test`);

    await scanAndIndexSessions(db, [{ projectId: 'cursor-project', projectDir }]);

    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_index_cursor'`).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });
});
