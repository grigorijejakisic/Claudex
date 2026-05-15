/**
 * Phase 8 plan 08-05 WIR-01 — live-wiring ship gate.
 *
 * Calls the EXPORTED production functions (`upsertChunk` from 08-02,
 * `ingestSession` from 08-03) against fixtures matching every DB shape
 * currently in the wild: V17-collapsed (the shape that burned v5.0.0)
 * plus base-table fresh-DB. NEVER mocks — the v5.0.1 silent-fail lesson
 * promoted live-wiring to ship-gate severity.
 *
 * Failing this test BLOCKS SHIP at Vesna severity per WIR-02 phase
 * coupling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import { ingestSession } from '../../ingestion/ingest-session.js';
import type { ChunkV6 } from '../../ingestion/transcript-chunker-v6.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';

class MockEmbeddingProvider extends EmbeddingProvider {
  constructor() { super(); }
  async isAvailable(): Promise<boolean> { return true; }
  async embed(_text: string): Promise<number[] | null> {
    return Array.from({ length: 1024 }, (_, i) => (i % 5) * 0.001);
  }
}

const validChunkFixture: ChunkV6 = {
  session_id: 'fixture-session',
  project_id: 'fixture-project',
  turn_index: 0,
  sub_index: 0,
  role: 'user',
  provenance: 'organic',
  body: 'A live-wiring chunk body that round-trips through the V32 substrate.',
  created_at_epoch_ms: 1700000000000,
  wrapper_redacted: false,
};

/**
 * V17-collapsed fixture extended with the minimum tables runMigrations
 * needs to advance from V31 to V32 cleanly. Mirrors what an existing
 * production install at V31 looks like before V32 lands.
 */
function buildV17V32Fixture(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE artifact (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT,
      scope TEXT,
      status TEXT,
      confidence REAL,
      created_at_epoch_ms INTEGER NOT NULL,
      updated_at_epoch_ms INTEGER NOT NULL,
      session_id TEXT,
      project_id TEXT,
      embedding_ref INTEGER,
      supersedes_id TEXT,
      data TEXT
    );
    CREATE TABLE legacy_id_map (
      legacy_table TEXT NOT NULL,
      legacy_id INTEGER NOT NULL,
      new_uuid TEXT NOT NULL,
      PRIMARY KEY (legacy_table, legacy_id)
    );
    CREATE VIEW learnings AS
    SELECT
      CAST((SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = 'learnings' AND m.new_uuid = artifact.id) AS INTEGER) AS id,
      CAST(artifact.project_id AS TEXT) AS project,
      artifact.body AS content,
      COALESCE(CAST(json_extract(artifact.data, '$.provenance') AS TEXT), 'organic') AS provenance
    FROM artifact
    WHERE kind = 'learning'
    ORDER BY created_at_epoch_ms;
  `);
}

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-wire-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeFakeJsonl(turns: number, project: string, sessionId: string): string {
  const dir = path.join(tmpHome, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    lines.push(JSON.stringify({
      type: role,
      message: { content: `${role} turn ${i}.` },
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('WIR-01 — upsertChunk against base-table fresh-DB', () => {
  it('writes a chunk through V32 fresh schema and round-trips it', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(db.pragma('user_version', { simple: true })).toBe(36);

    const chunk: ChunkV6 = { ...validChunkFixture, session_id: 'sess-base-1' };
    upsertChunk(db, chunk);

    const row = db.prepare(
      `SELECT session_id, project, role, provenance, body, wrapper_redacted
         FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get(chunk.session_id) as ChunkV6 & { wrapper_redacted: number };
    expect(row).toBeDefined();
    expect(row.body).toBe(chunk.body);
    expect(row.role).toBe('user');
    expect(row.provenance).toBe('organic');
    expect(row.wrapper_redacted).toBe(0);
    db.close();
  });
});

describe('WIR-01 — upsertChunk against V17-collapsed DB', () => {
  it('writes a chunk through V32 additive migration on a V17-collapsed DB and round-trips it', () => {
    const db = new Database(':memory:');
    buildV17V32Fixture(db);
    db.pragma('user_version = 31');
    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(36);

    // Confirm the legacy V17 `learnings` view is untouched (still a view).
    const learningsView = db.prepare(
      `SELECT type FROM sqlite_master WHERE name = 'learnings'`,
    ).get() as { type: string } | undefined;
    expect(learningsView?.type).toBe('view');

    const chunk: ChunkV6 = { ...validChunkFixture, session_id: 'sess-v17-1' };
    upsertChunk(db, chunk);

    const row = db.prepare(
      `SELECT body FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get('sess-v17-1') as { body: string };
    expect(row).toBeDefined();
    expect(row.body).toBe(chunk.body);
    db.close();
  });
});

describe('WIR-01 — ingestSession end-to-end on both fixture shapes', () => {
  it('base-table fresh-DB: 5-turn JSONL ingests 5 chunks idempotently', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(db.pragma('user_version', { simple: true })).toBe(36);

    const project = 'p-base';
    const sessionId = 's-base';
    const jsonlPath = writeFakeJsonl(5, project, sessionId);

    const r1 = await ingestSession(db, sessionId, project, jsonlPath, new MockEmbeddingProvider());
    expect(r1.chunksWritten).toBe(5);

    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number }).cnt;
    expect(count).toBe(5);

    // Re-run — idempotent.
    const r2 = await ingestSession(db, sessionId, project, jsonlPath, new MockEmbeddingProvider());
    expect(r2.chunksWritten).toBe(5);
    const countAfter = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number }).cnt;
    expect(countAfter).toBe(5);

    db.close();
  });

  it('V17-collapsed DB: 5-turn JSONL ingests 5 chunks idempotently', async () => {
    const db = new Database(':memory:');
    buildV17V32Fixture(db);
    db.pragma('user_version = 31');
    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(36);

    const project = 'p-v17';
    const sessionId = 's-v17';
    const jsonlPath = writeFakeJsonl(5, project, sessionId);

    const r1 = await ingestSession(db, sessionId, project, jsonlPath, new MockEmbeddingProvider());
    expect(r1.chunksWritten).toBe(5);

    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number }).cnt;
    expect(count).toBe(5);

    const r2 = await ingestSession(db, sessionId, project, jsonlPath, new MockEmbeddingProvider());
    expect(r2.chunksWritten).toBe(5);
    const countAfter = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number }).cnt;
    expect(countAfter).toBe(5);

    db.close();
  });

  it('purity guard — production write surface is never mocked', () => {
    // Read this test file and assert no vi.mock() on the substrate modules.
    const thisFile = fs.readFileSync(__filename, 'utf8');
    expect(thisFile).not.toMatch(/vi\.mock.*ingest-session/);
    expect(thisFile).not.toMatch(/vi\.mock.*upsert-chunk/);
    expect(thisFile).not.toMatch(/vi\.mock.*transcript-chunker-v6/);
  });
});
