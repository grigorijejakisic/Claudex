/**
 * Phase 5.5 Plan 03 — mark-pointers-helpful CLI tests.
 *
 * Spawns the built dist artifact as a child process with CLAUDEX_DB_PATH
 * pointing at a fresh tmp DB. Seeds the DB via the helper API before each
 * spawn, then asserts both stdout/exit-code AND the resulting DB state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  ensurePointerId,
  recordPointerRecall,
} from '../../angel/pointer-recall.js';

const CLI = path.join(process.cwd(), 'dist', 'cli', 'mark-pointers-helpful.cjs');

let tmpdir: string;
let dbPath: string;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'p55-mark-'));
  dbPath = path.join(tmpdir, 'claudex.db');
  const db = new Database(dbPath);
  initializeSchema(db);
  db.close();
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function run(args: string[]): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync('node', [CLI, ...args], {
    env: { ...process.env, CLAUDEX_DB_PATH: dbPath },
    encoding: 'utf8',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

function seed(fn: (db: Database.Database) => void): void {
  const db = new Database(dbPath);
  fn(db);
  db.close();
}

function helpfulCount(): number {
  const db = new Database(dbPath, { readonly: true });
  const c = (db.prepare(`SELECT COUNT(*) AS c FROM pointer_recall_log WHERE helpful_yn = 1`).get() as { c: number }).c;
  db.close();
  return c;
}

function totalRows(): number {
  const db = new Database(dbPath, { readonly: true });
  const c = (db.prepare(`SELECT COUNT(*) AS c FROM pointer_recall_log`).get() as { c: number }).c;
  db.close();
  return c;
}

describe('mark-pointers-helpful CLI', () => {
  it('empty input is a no-op (stdout: "No pointers marked.", exit 0, DB unchanged)', () => {
    seed((db) => {
      const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
      recordPointerRecall(db, pid, 'sess-1', null);
    });
    const r = run(['sess-1', '']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('No pointers marked.');
    expect(helpfulCount()).toBe(0);
  });

  it('"none" input is a no-op', () => {
    const r = run(['sess-1', 'none']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('No pointers marked.');
  });

  it('"all" marks every pointer retrieved this session', () => {
    seed((db) => {
      const a = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
      const b = ensurePointerId(db, 'proj-a', 'feedback_b.md', 'lesson');
      const c = ensurePointerId(db, 'proj-a', 'feedback_c.md', 'lesson');
      recordPointerRecall(db, a, 'sess-1', null);
      recordPointerRecall(db, b, 'sess-1', null);
      recordPointerRecall(db, c, 'sess-1', null);
    });
    const r = run(['sess-1', 'all']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('Marked 3 pointer(s) helpful for session sess-1');
    expect(helpfulCount()).toBe(3);
    expect(totalRows()).toBe(3);
  });

  it('comma-separated indices mark only the specified pointers', () => {
    seed((db) => {
      const insert = db.prepare(
        `INSERT INTO pointer_recall_log (pointer_id, session_id, retrieved_at_epoch_ms, query)
         VALUES (?, ?, ?, ?)`
      );
      const a = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
      const b = ensurePointerId(db, 'proj-a', 'feedback_b.md', 'lesson');
      const c = ensurePointerId(db, 'proj-a', 'feedback_c.md', 'lesson');
      insert.run(a, 'sess-1', 1000, null);
      insert.run(b, 'sess-1', 2000, null);
      insert.run(c, 'sess-1', 3000, null);
    });
    const r = run(['sess-1', '1,3']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('Marked 2 pointer(s) helpful for session sess-1');
    expect(helpfulCount()).toBe(2);
  });

  it('out-of-range index exits 1 with an error message', () => {
    seed((db) => {
      const pid = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
      recordPointerRecall(db, pid, 'sess-1', null);
    });
    const r = run(['sess-1', '5']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid index');
  });

  it('non-numeric token exits 1', () => {
    seed((db) => {
      const pid = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
      recordPointerRecall(db, pid, 'sess-1', null);
    });
    const r = run(['sess-1', 'abc']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid index');
  });

  it('idempotent re-run reports 0 on second pass', () => {
    seed((db) => {
      const pid = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
      recordPointerRecall(db, pid, 'sess-1', null);
    });
    const first = run(['sess-1', 'all']);
    expect(first.stdout.trim()).toBe('Marked 1 pointer(s) helpful for session sess-1');
    const second = run(['sess-1', 'all']);
    expect(second.stdout.trim()).toBe('Marked 0 pointer(s) helpful for session sess-1');
  });

  it('wrong session id reports 0 marks (no rows for that session) and exits 0', () => {
    seed((db) => {
      const pid = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
      recordPointerRecall(db, pid, 'sess-A', null);
    });
    const r = run(['sess-B', 'all']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('Marked 0 pointer(s) helpful for session sess-B');
  });
});
