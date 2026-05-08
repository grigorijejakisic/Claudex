/**
 * Tests for ingestSession + enqueueSessionIngestion (Phase 8 entry points).
 *
 * Uses tmp JSONL files + a mock EmbeddingProvider to exercise the full
 * read-JSONL → chunk → embed → upsert path against an in-memory V32 DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initializeSchema } from '../../core/migrations.js';
import {
  enqueueSessionIngestion,
  ingestSession,
} from '../../ingestion/ingest-session.js';
import { EmbeddingProvider } from '../../embeddings/embedding-provider.js';

class MockEmbeddingProvider extends EmbeddingProvider {
  public callCount = 0;
  constructor(public returnNull = false) {
    super();
  }
  async isAvailable(): Promise<boolean> { return true; }
  async embed(_text: string): Promise<number[] | null> {
    this.callCount += 1;
    if (this.returnNull) return null;
    // Return a fixed 1024-dim vector — small floats so encodeVector is happy.
    return Array.from({ length: 1024 }, (_, i) => (i % 7) * 0.001);
  }
}

function writeFakeJsonl(turns: Array<{ type: string; body: string }>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-ingest-'));
  const file = path.join(tmpDir, 'session.jsonl');
  const lines = turns.map((t, i) => JSON.stringify({
    type: t.type,
    message: { content: t.body },
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('enqueueSessionIngestion', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });
  afterEach(() => { db.close(); });

  it('writes a single transcript_ingestion_pending event row', () => {
    enqueueSessionIngestion(db, 'sess-1', 'proj-1', '/tmp/sess-1.jsonl');
    const rows = db.prepare(
      `SELECT event_type, entity, action, detail FROM session_events
        WHERE session_id = ? AND event_type = ?`
    ).all('sess-1', 'transcript_ingestion_pending') as Array<{
      event_type: string; entity: string; action: string; detail: string
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe('transcript_ingestion_pending');
    expect(rows[0].entity).toBe('angel');
    expect(rows[0].action).toBe('enqueue');
    const detail = JSON.parse(rows[0].detail);
    expect(detail.session_id).toBe('sess-1');
    expect(detail.project).toBe('proj-1');
    expect(detail.jsonl_path).toBe('/tmp/sess-1.jsonl');
  });

  it('jsonl_path is null when not provided', () => {
    enqueueSessionIngestion(db, 'sess-2', 'proj-2');
    const row = db.prepare(
      `SELECT detail FROM session_events WHERE session_id = ?`
    ).get('sess-2') as { detail: string };
    expect(JSON.parse(row.detail).jsonl_path).toBeNull();
  });

  it('multiple enqueues for the same session each create a row', () => {
    enqueueSessionIngestion(db, 'sess-dup', 'proj');
    enqueueSessionIngestion(db, 'sess-dup', 'proj');
    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?`
    ).get('sess-dup') as { cnt: number }).cnt;
    expect(count).toBe(2);
  });
});

describe('ingestSession', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });
  afterEach(() => { db.close(); });

  it('empty JSONL → 0 chunks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-empty-'));
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const r = await ingestSession(db, 'sess-empty', 'proj', file, new MockEmbeddingProvider());
    expect(r.chunksWritten).toBe(0);
    expect(r.embeddingsWritten).toBe(0);
  });

  it('5-turn JSONL ingests 5 chunks', async () => {
    const file = writeFakeJsonl([
      { type: 'user', body: 'Question one.' },
      { type: 'assistant', body: 'Answer one.' },
      { type: 'user', body: 'Question two.' },
      { type: 'assistant', body: 'Answer two.' },
      { type: 'user', body: 'Question three.' },
    ]);
    const r = await ingestSession(db, 'sess-5', 'proj', file, new MockEmbeddingProvider());
    expect(r.chunksWritten).toBe(5);
    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-5') as { cnt: number }).cnt;
    expect(count).toBe(5);
  });

  it('embedding provider returns null → metadata rows still land, errors counter increments', async () => {
    const file = writeFakeJsonl([
      { type: 'user', body: 'Body A.' },
      { type: 'assistant', body: 'Body B.' },
    ]);
    const provider = new MockEmbeddingProvider(true);
    const r = await ingestSession(db, 'sess-noembed', 'proj', file, provider);
    expect(r.chunksWritten).toBe(2);
    expect(r.errors).toBeGreaterThanOrEqual(2);
    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-noembed') as { cnt: number }).cnt;
    expect(count).toBe(2);
  });

  it('re-running ingestSession on the same session is idempotent', async () => {
    const file = writeFakeJsonl([
      { type: 'user', body: 'one.' },
      { type: 'assistant', body: 'two.' },
    ]);
    await ingestSession(db, 'sess-idemp', 'proj', file, new MockEmbeddingProvider());
    const before = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-idemp') as { cnt: number }).cnt;
    await ingestSession(db, 'sess-idemp', 'proj', file, new MockEmbeddingProvider());
    const after = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-idemp') as { cnt: number }).cnt;
    expect(after).toBe(before);
    expect(after).toBe(2);
  });

  it('malformed JSONL line is skipped; valid lines still ingested', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-malformed-'));
    const file = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: 'first' } }),
      'NOT VALID JSON',
      JSON.stringify({ type: 'assistant', message: { content: 'third' } }),
    ].join('\n'));
    const r = await ingestSession(db, 'sess-bad', 'proj', file, new MockEmbeddingProvider());
    expect(r.chunksWritten).toBe(2);
    expect(r.errors).toBeGreaterThanOrEqual(1);
  });

  it('non-existent JSONL path → 0 chunks', async () => {
    const r = await ingestSession(db, 'sess-missing', 'proj', '/nonexistent/path.jsonl', new MockEmbeddingProvider());
    expect(r.chunksWritten).toBe(0);
    expect(r.embeddingsWritten).toBe(0);
  });

  it('persists wrapper_redacted=true when JSONL contains wrapper-tagged spans', async () => {
    const file = writeFakeJsonl([
      { type: 'user', body: 'Pre. <system-reminder>nope</system-reminder> Post.' },
    ]);
    await ingestSession(db, 'sess-wrap', 'proj', file, new MockEmbeddingProvider());
    const row = db.prepare(
      `SELECT body, wrapper_redacted FROM transcript_chunk_v6 WHERE session_id = ?`
    ).get('sess-wrap') as { body: string; wrapper_redacted: number };
    expect(row.wrapper_redacted).toBe(1);
    expect(row.body).not.toContain('<system-reminder>');
    expect(row.body).not.toContain('nope');
  });
});
