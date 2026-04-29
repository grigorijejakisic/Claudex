/**
 * Tests for src/angel/pointer-recall.ts (Phase 5.5).
 *
 * Covers ensurePointerId / recordPointerRecall / markPointersHelpful /
 * listSessionPointers — the helper API the rest of Phase 5.5 builds on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  ensurePointerId,
  recordPointerRecall,
  markPointersHelpful,
  listSessionPointers,
} from '../../angel/pointer-recall.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe('ensurePointerId', () => {
  it('returns the same id on repeated calls with identical args', () => {
    const a = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    const b = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    expect(a).toBe(b);

    const count = (db.prepare(
      `SELECT COUNT(*) AS c FROM lesson_pointer WHERE project = 'proj-a' AND filename = 'feedback_x.md'`
    ).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('returns distinct ids for different filename', () => {
    const a = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    const b = ensurePointerId(db, 'proj-a', 'feedback_y.md', 'lesson');
    expect(a).not.toBe(b);
  });

  it('returns distinct ids for different source even when filename matches', () => {
    const a = ensurePointerId(db, 'proj-a', 'shared.md', 'lesson');
    const b = ensurePointerId(db, 'proj-a', 'shared.md', 'user_note');
    expect(a).not.toBe(b);
  });

  it('returns distinct ids for different project', () => {
    const a = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    const b = ensurePointerId(db, 'proj-b', 'feedback_x.md', 'lesson');
    expect(a).not.toBe(b);
  });
});

describe('recordPointerRecall', () => {
  it('writes a row with correct shape and helpful_yn IS NULL', () => {
    const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    recordPointerRecall(db, pid, 'sess-1', 'find auth bug');

    const row = db.prepare(
      `SELECT pointer_id, session_id, helpful_yn, query, retrieved_at_epoch_ms FROM pointer_recall_log`
    ).get() as {
      pointer_id: number;
      session_id: string;
      helpful_yn: number | null;
      query: string | null;
      retrieved_at_epoch_ms: number;
    };

    expect(row.pointer_id).toBe(pid);
    expect(row.session_id).toBe('sess-1');
    expect(row.helpful_yn).toBeNull();
    expect(row.query).toBe('find auth bug');
    expect(row.retrieved_at_epoch_ms).toBeGreaterThan(0);
  });

  it('stores null query when called with null', () => {
    const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    recordPointerRecall(db, pid, 'sess-1', null);

    const row = db.prepare(`SELECT query FROM pointer_recall_log`).get() as { query: string | null };
    expect(row.query).toBeNull();
  });
});

describe('markPointersHelpful', () => {
  it('flips all 3 NULL rows for a single pointer in one session', () => {
    const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    recordPointerRecall(db, pid, 'sess-1', null);
    recordPointerRecall(db, pid, 'sess-1', null);
    recordPointerRecall(db, pid, 'sess-1', null);

    const updated = markPointersHelpful(db, 'sess-1', [pid]);
    expect(updated).toBe(3);

    const helpfulCount = (db.prepare(
      `SELECT COUNT(*) AS c FROM pointer_recall_log WHERE pointer_id = ? AND helpful_yn = 1`
    ).get(pid) as { c: number }).c;
    expect(helpfulCount).toBe(3);
  });

  it('does not overwrite a prior mark — second call returns 0', () => {
    const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    recordPointerRecall(db, pid, 'sess-1', null);

    const first = markPointersHelpful(db, 'sess-1', [pid]);
    expect(first).toBe(1);
    const second = markPointersHelpful(db, 'sess-1', [pid]);
    expect(second).toBe(0);
  });

  it('returns 0 on empty pointerIds list and runs no SQL', () => {
    const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    recordPointerRecall(db, pid, 'sess-1', null);
    const updated = markPointersHelpful(db, 'sess-1', []);
    expect(updated).toBe(0);

    const row = db.prepare(`SELECT helpful_yn FROM pointer_recall_log`).get() as { helpful_yn: number | null };
    expect(row.helpful_yn).toBeNull();
  });

  it('only matches given session_id — other sessions stay null', () => {
    const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    recordPointerRecall(db, pid, 'sess-A', null);
    recordPointerRecall(db, pid, 'sess-B', null);

    const updated = markPointersHelpful(db, 'sess-A', [pid]);
    expect(updated).toBe(1);

    const aRow = db.prepare(
      `SELECT helpful_yn FROM pointer_recall_log WHERE session_id = 'sess-A'`
    ).get() as { helpful_yn: number | null };
    const bRow = db.prepare(
      `SELECT helpful_yn FROM pointer_recall_log WHERE session_id = 'sess-B'`
    ).get() as { helpful_yn: number | null };
    expect(aRow.helpful_yn).toBe(1);
    expect(bRow.helpful_yn).toBeNull();
  });
});

describe('listSessionPointers', () => {
  it('returns rows sorted by first_retrieved ASC with correct counts', () => {
    const pidA = ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
    const pidB = ensurePointerId(db, 'proj-a', 'feedback_b.md', 'lesson');

    // Insert directly so we can control retrieved_at_epoch_ms timestamps.
    const insert = db.prepare(
      `INSERT INTO pointer_recall_log (pointer_id, session_id, retrieved_at_epoch_ms, query)
       VALUES (?, ?, ?, ?)`
    );
    insert.run(pidA, 'sess-1', 1000, null);
    insert.run(pidB, 'sess-1', 500, null);
    insert.run(pidA, 'sess-1', 2000, null);

    const rows = listSessionPointers(db, 'sess-1');
    expect(rows.length).toBe(2);

    expect(rows[0].pointer_id).toBe(pidB);
    expect(rows[0].first_retrieved_at_epoch_ms).toBe(500);
    expect(rows[0].recall_count).toBe(1);

    expect(rows[1].pointer_id).toBe(pidA);
    expect(rows[1].first_retrieved_at_epoch_ms).toBe(1000);
    expect(rows[1].recall_count).toBe(2);
    expect(rows[1].helpful_yn).toBeNull();
  });

  it('returns helpful_yn=1 when session has any helpful row for pointer', () => {
    const pid = ensurePointerId(db, 'proj-a', 'feedback_x.md', 'lesson');
    recordPointerRecall(db, pid, 'sess-1', null);
    markPointersHelpful(db, 'sess-1', [pid]);

    const rows = listSessionPointers(db, 'sess-1');
    expect(rows.length).toBe(1);
    expect(rows[0].helpful_yn).toBe(1);
  });

  it('returns empty array for an unknown session', () => {
    const rows = listSessionPointers(db, 'no-such-session');
    expect(rows).toEqual([]);
  });
});
