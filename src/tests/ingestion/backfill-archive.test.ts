/**
 * Tests for backfill-archive enumeration + runBackfill.
 *
 * Builds a tmp ~/.claude/projects mock layout, asserts enumeration finds
 * the expected SessionRefs, and verifies runBackfill enqueues queue rows
 * + skips already-ingested sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initializeSchema } from '../../core/migrations.js';
import {
  enumerateArchiveSessions,
  runBackfill,
} from '../../ingestion/backfill-archive.js';
import { parseArgs } from '../../cli/backfill-transcripts.js';

let tmpRoot: string;
let db: Database.Database;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-backfill-'));
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkSessionFile(project: string, sessionId: string, content = '{"type":"user","message":{"content":"x"}}\n'): string {
  const dir = path.join(tmpRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

describe('enumerateArchiveSessions', () => {
  it('returns empty array when root does not exist', () => {
    expect(enumerateArchiveSessions(path.join(tmpRoot, 'nope'))).toEqual([]);
  });

  it('enumerates 6 refs from 3 projects × 2 sessions', () => {
    mkSessionFile('p1', 's-1a');
    mkSessionFile('p1', 's-1b');
    mkSessionFile('p2', 's-2a');
    mkSessionFile('p2', 's-2b');
    mkSessionFile('p3', 's-3a');
    mkSessionFile('p3', 's-3b');
    const refs = enumerateArchiveSessions(tmpRoot);
    expect(refs.length).toBe(6);
    const projects = [...new Set(refs.map(r => r.project))].sort();
    expect(projects).toEqual(['p1', 'p2', 'p3']);
    const sessions = refs.map(r => r.session_id).sort();
    expect(sessions).toEqual(['s-1a', 's-1b', 's-2a', 's-2b', 's-3a', 's-3b']);
  });

  it('skips non-jsonl files and non-directory entries', () => {
    mkSessionFile('p1', 's-1');
    fs.writeFileSync(path.join(tmpRoot, 'p1', 'README.md'), '# notes');
    fs.writeFileSync(path.join(tmpRoot, 'top-level-loose.txt'), 'noise');
    const refs = enumerateArchiveSessions(tmpRoot);
    expect(refs.length).toBe(1);
    expect(refs[0].session_id).toBe('s-1');
  });

  it('refs are sorted by mtime ascending', () => {
    const a = mkSessionFile('p1', 's-old');
    fs.utimesSync(a, new Date(2020, 0, 1), new Date(2020, 0, 1));
    mkSessionFile('p1', 's-new');
    const refs = enumerateArchiveSessions(tmpRoot);
    expect(refs.length).toBe(2);
    expect(refs[0].session_id).toBe('s-old');
    expect(refs[1].session_id).toBe('s-new');
  });
});

describe('runBackfill', () => {
  it('enqueues a session_events row per ref', () => {
    mkSessionFile('p1', 's-1');
    mkSessionFile('p2', 's-2');
    const refs = enumerateArchiveSessions(tmpRoot);
    const progress = runBackfill(db, refs);
    expect(progress.enqueued).toBe(2);
    expect(progress.skipped).toBe(0);
    const count = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM session_events WHERE event_type = 'transcript_ingestion_pending'`
    ).get() as { cnt: number }).cnt;
    expect(count).toBe(2);
  });

  it('skips sessions that already have at least one transcript_chunk_v6 row', () => {
    mkSessionFile('p1', 's-already');
    mkSessionFile('p1', 's-fresh');

    // Pre-seed transcript_chunk_v6 for s-already.
    db.prepare(
      `INSERT INTO transcript_chunk_v6 (session_id, project, turn_index, role, provenance, body, created_at_epoch_ms)
       VALUES ('s-already', 'p1', 0, 'user', 'organic', 'old chunk', 1700000000000)`,
    ).run();

    const refs = enumerateArchiveSessions(tmpRoot);
    const progress = runBackfill(db, refs);
    expect(progress.skipped).toBe(1);
    expect(progress.enqueued).toBe(1);

    const enqueuedRow = db.prepare(
      `SELECT session_id FROM session_events
        WHERE event_type = 'transcript_ingestion_pending'`,
    ).get() as { session_id: string };
    expect(enqueuedRow.session_id).toBe('s-fresh');
  });

  it('emits onProgress callbacks at progressEvery boundary + final', () => {
    for (let i = 0; i < 5; i++) mkSessionFile('p1', `s-${i}`);
    const refs = enumerateArchiveSessions(tmpRoot);
    const seen: number[] = [];
    runBackfill(db, refs, {
      progressEvery: 2,
      onProgress: (p) => { seen.push(p.enqueued + p.skipped + p.errors); },
    });
    // Mid-progress callbacks at 2, 4 + final at 5 → at least 3 entries.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[seen.length - 1]).toBe(5);
  });
});

describe('backfill-transcripts CLI argument parsing', () => {
  it('defaults to dryRun=false', () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
  });

  it('parses --dry-run flag', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['-n']).dryRun).toBe(true);
  });

  it('parses --root <path>', () => {
    expect(parseArgs(['--root', '/tmp/mock']).rootDir).toBe('/tmp/mock');
  });
});
