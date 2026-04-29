/**
 * Phase 5.5 Plan 03 — list-session-pointers CLI tests.
 *
 * Strategy: spawn the built dist artifact as a child process with
 * CLAUDEX_DB_PATH pointing at a fresh tmp DB. We seed the DB ahead of
 * the spawn using better-sqlite3 + initializeSchema + the helper API.
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
  markPointersHelpful,
} from '../../angel/pointer-recall.js';

const CLI = path.join(process.cwd(), 'dist', 'cli', 'list-session-pointers.cjs');

let tmpdir: string;
let dbPath: string;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'p55-list-'));
  dbPath = path.join(tmpdir, 'claudex.db');
  const db = new Database(dbPath);
  initializeSchema(db);
  db.close();
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function run(sessionId: string): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync('node', [CLI, sessionId], {
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

describe('list-session-pointers CLI', () => {
  it('exits 0 with empty stdout for an unknown session', () => {
    const r = run('no-such-session');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('prints exactly one indexed line for a single pointer + single recall', () => {
    seed((db) => {
      const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
      recordPointerRecall(db, pid, 'sess-1', null);
    });

    const r = run('sess-1');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('1. [lesson] proj-a/feedback_x.md (1x)\n');
  });

  it('orders by first_retrieved_at ASC and counts recalls correctly', () => {
    seed((db) => {
      const pidA = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
      const pidB = ensurePointerId(db, 'proj-a', 'feedback_b.md', 'lesson');
      const insert = db.prepare(
        `INSERT INTO pointer_recall_log (pointer_id, session_id, retrieved_at_epoch_ms, query)
         VALUES (?, ?, ?, ?)`
      );
      // pidA earliest at t=1000, then pidB at t=2000, second pidA at t=3000
      insert.run(pidA, 'sess-1', 1000, null);
      insert.run(pidA, 'sess-1', 3000, null);
      insert.run(pidB, 'sess-1', 2000, null);
    });

    const r = run('sess-1');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      '1. [lesson] proj-a/feedback_a.md (2x)\n2. [lesson] proj-a/feedback_b.md (1x)\n',
    );
  });

  it('appends ✓ when a pointer was already marked helpful', () => {
    seed((db) => {
      const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
      recordPointerRecall(db, pid, 'sess-1', null);
      markPointersHelpful(db, 'sess-1', [pid]);
    });

    const r = run('sess-1');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('1. [lesson] proj-a/feedback_x.md (1x) ✓\n');
  });

  it('exits 1 when invoked without a session id', () => {
    const r = spawnSync('node', [CLI], {
      env: { ...process.env, CLAUDEX_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage');
  });
});
