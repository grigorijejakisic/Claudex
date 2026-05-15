import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { importSyntheticTranscripts } from '../../ingestion/synthetic-corpus-import.js';

let tmpDir: string;
let dataDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-synth-'));
  dataDir = path.join(tmpDir, 'synthetic-transcripts');
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE transcript_chunk_v6 (
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      sub_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      provenance TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at_epoch_ms INTEGER NOT NULL,
      wrapper_redacted INTEGER NOT NULL,
      UNIQUE(session_id, turn_index, role, sub_index)
    );
  `);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filename: string, turns: Array<{ type: string; content: string }>) {
  const lines = turns.map((t) =>
    JSON.stringify({
      type: t.type,
      message: { role: t.type, content: t.content },
    }),
  ).join('\n');
  fs.writeFileSync(path.join(dataDir, filename), lines);
}

describe('importSyntheticTranscripts', () => {
  it('ingests 2 JSONL files and writes chunks to transcript_chunk_v6', async () => {
    writeJsonl('fixture-a.jsonl', [
      { type: 'user', content: 'first turn' },
      { type: 'assistant', content: 'second turn reply' },
      { type: 'user', content: 'third turn followup' },
    ]);
    writeJsonl('fixture-b.jsonl', [
      { type: 'user', content: 'b first' },
      { type: 'assistant', content: 'b second' },
    ]);
    const report = await importSyntheticTranscripts(db, dataDir);
    expect(report.files_seen).toBe(2);
    expect(report.errors).toEqual([]);
    expect(report.chunks_inserted).toBeGreaterThanOrEqual(5);

    const sessionIds = db.prepare(`SELECT DISTINCT session_id FROM transcript_chunk_v6`).all() as Array<{ session_id: string }>;
    const ids = sessionIds.map((r) => r.session_id).sort();
    expect(ids).toEqual(['synthetic-fixture-a', 'synthetic-fixture-b']);
  });

  it('is idempotent (second run on same dir does not duplicate via UNIQUE constraint)', async () => {
    writeJsonl('fixture-a.jsonl', [
      { type: 'user', content: 'first turn' },
      { type: 'assistant', content: 'second turn reply' },
    ]);
    await importSyntheticTranscripts(db, dataDir);
    const beforeCount = (db.prepare(`SELECT COUNT(*) as n FROM transcript_chunk_v6`).get() as { n: number }).n;
    await importSyntheticTranscripts(db, dataDir);
    const afterCount = (db.prepare(`SELECT COUNT(*) as n FROM transcript_chunk_v6`).get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
  });

  it('captures malformed JSONL in errors but continues other files', async () => {
    writeJsonl('good.jsonl', [{ type: 'user', content: 'ok' }]);
    fs.writeFileSync(path.join(dataDir, 'bad.jsonl'), 'NOT_VALID_JSON\n');
    const report = await importSyntheticTranscripts(db, dataDir);
    expect(report.files_seen).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].file).toBe('bad.jsonl');
    // The good file still ingested.
    const goodRows = db.prepare(`SELECT COUNT(*) as n FROM transcript_chunk_v6 WHERE session_id = ?`).get('synthetic-good') as { n: number };
    expect(goodRows.n).toBeGreaterThan(0);
  });

  it('returns empty report when dir does not exist', async () => {
    const report = await importSyntheticTranscripts(db, path.join(tmpDir, 'does-not-exist'));
    expect(report.files_seen).toBe(0);
    expect(report.chunks_inserted).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('all rows have provenance = environmental', async () => {
    writeJsonl('p.jsonl', [{ type: 'user', content: 'q' }]);
    await importSyntheticTranscripts(db, dataDir);
    const provenances = db.prepare(`SELECT DISTINCT provenance FROM transcript_chunk_v6`).all() as Array<{ provenance: string }>;
    expect(provenances).toEqual([{ provenance: 'environmental' }]);
  });
});
