/**
 * CHR async queue — Phase 14-08.
 *
 * 1. enqueueChrClassification: writes a pending row
 * 2. CLAUDEX_CHR_DISABLED=1 skips enqueue
 * 3. drainChrQueue: processes up to DRAIN_BATCH_SIZE oldest rows
 * 4. drainChrQueue: marks each row processed regardless of outcome
 * 5. sweepChrQueue: removes processed rows older than retention
 * 6. V41 fresh-DB schema present
 * 7. V41 → V40 reverse drops the table
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { migrateV40toV41, migrateV41toV40 } from '../../core/migration-steps.js';
import {
  enqueueChrClassification,
  drainChrQueue,
  sweepChrQueue,
} from '../../angel/chr-async.js';
import * as handoffWatcher from '../../angel/handoff-decision-watcher.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

beforeEach(() => {
  delete process.env['CLAUDEX_CHR_DISABLED'];
});

afterEach(() => {
  delete process.env['CLAUDEX_CHR_DISABLED'];
  vi.restoreAllMocks();
});

describe('CHR async queue (V41 + chr-async.ts)', () => {
  it('6. V41 fresh-DB: chr_pending_classifications table exists with required columns', () => {
    const db = freshDb();
    const cols = (db.pragma('table_info(chr_pending_classifications)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('session_id');
    expect(cols).toContain('project');
    expect(cols).toContain('user_text');
    expect(cols).toContain('assistant_text');
    expect(cols).toContain('source_turn_uuid');
    expect(cols).toContain('enqueued_at_epoch_ms');
    expect(cols).toContain('processed_at_epoch_ms');
    expect(cols).toContain('attempt_count');
    expect(cols).toContain('last_error');
    db.close();
  });

  it('7. V41 → V40 reverse drops the table', () => {
    const db = freshDb();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='chr_pending_classifications'").get() as { n: number }).n,
    ).toBe(1);
    migrateV41toV40(db);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='chr_pending_classifications'").get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it('1. enqueueChrClassification writes a row with processed=NULL', () => {
    const db = freshDb();
    const r = enqueueChrClassification({
      db,
      session_id: 'sess-1',
      project: 'p',
      user_text: 'let us pivot to B',
      assistant_text: 'pivoting',
      source_turn_uuid: 'uuid-1',
    });
    expect(r.enqueued).toBe(true);
    expect(r.row_id).toBeGreaterThan(0);

    const row = db.prepare("SELECT * FROM chr_pending_classifications WHERE id=?").get(r.row_id) as { processed_at_epoch_ms: number | null; user_text: string };
    expect(row.processed_at_epoch_ms).toBeNull();
    expect(row.user_text).toBe('let us pivot to B');
    db.close();
  });

  it('2. CLAUDEX_CHR_DISABLED=1 skips enqueue', () => {
    process.env['CLAUDEX_CHR_DISABLED'] = '1';
    const db = freshDb();
    const r = enqueueChrClassification({
      db,
      session_id: 'sess-x',
      project: 'p',
      user_text: 'x',
      assistant_text: 'y',
      source_turn_uuid: 'uuid-x',
    });
    expect(r.enqueued).toBe(false);
    expect(r.row_id).toBe(0);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM chr_pending_classifications").get() as { n: number }).n;
    expect(count).toBe(0);
    db.close();
  });

  it('3. drainChrQueue processes oldest first, up to batch size', async () => {
    const db = freshDb();
    // Enqueue 12 rows; batch size is 10 — second drain should pick up the rest.
    for (let i = 0; i < 12; i++) {
      enqueueChrClassification({
        db,
        session_id: 'sess-' + i,
        project: 'p',
        user_text: 'u' + i,
        assistant_text: 'a' + i,
        source_turn_uuid: 'uuid-' + i,
      });
    }

    // Mock classifyTurnAsDecisionBoundary to return no-boundary (avoid real LLM call).
    vi.spyOn(handoffWatcher, 'classifyTurnAsDecisionBoundary').mockResolvedValue({
      refreshed: false,
      throttled: false,
      boundary_type: null,
    });

    const first = await drainChrQueue(db);
    expect(first.drained).toBe(10);
    expect(first.no_boundary).toBe(10);

    const second = await drainChrQueue(db);
    expect(second.drained).toBe(2);

    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM chr_pending_classifications WHERE processed_at_epoch_ms IS NULL").get() as { n: number }).n;
    expect(remaining).toBe(0);
    db.close();
  });

  it('4. drainChrQueue marks rows processed even when LLM throws', async () => {
    const db = freshDb();
    enqueueChrClassification({
      db,
      session_id: 'sess-err',
      project: 'p',
      user_text: 'x',
      assistant_text: 'y',
      source_turn_uuid: 'uuid-err',
    });

    vi.spyOn(handoffWatcher, 'classifyTurnAsDecisionBoundary').mockRejectedValue(new Error('LLM exploded'));

    const result = await drainChrQueue(db);
    expect(result.drained).toBe(1);
    expect(result.errors).toBe(1);

    const row = db.prepare("SELECT processed_at_epoch_ms, attempt_count, last_error FROM chr_pending_classifications WHERE session_id='sess-err'").get() as { processed_at_epoch_ms: number; attempt_count: number; last_error: string };
    expect(row.processed_at_epoch_ms).toBeGreaterThan(0);
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toContain('LLM exploded');
    db.close();
  });

  it('5. sweepChrQueue removes processed rows older than 7 days', () => {
    const db = freshDb();

    // Insert a row processed 10 days ago.
    const tenDaysAgoMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO chr_pending_classifications
         (session_id, project, user_text, assistant_text, source_turn_uuid, enqueued_at_epoch_ms, processed_at_epoch_ms, attempt_count)
       VALUES ('old', 'p', null, 'a', 'u-old', ?, ?, 1)`,
    ).run(tenDaysAgoMs, tenDaysAgoMs);

    // Insert a row processed 1 hour ago.
    const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO chr_pending_classifications
         (session_id, project, user_text, assistant_text, source_turn_uuid, enqueued_at_epoch_ms, processed_at_epoch_ms, attempt_count)
       VALUES ('recent', 'p', null, 'a', 'u-recent', ?, ?, 1)`,
    ).run(oneHourAgoMs, oneHourAgoMs);

    // Insert an unprocessed row.
    enqueueChrClassification({
      db,
      session_id: 'pending',
      project: 'p',
      user_text: null,
      assistant_text: 'a',
      source_turn_uuid: 'u-pending',
    });

    const deleted = sweepChrQueue(db);
    expect(deleted).toBe(1);

    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM chr_pending_classifications").get() as { n: number }).n;
    expect(remaining).toBe(2);

    const oldRow = db.prepare("SELECT 1 FROM chr_pending_classifications WHERE session_id='old'").get();
    expect(oldRow).toBeUndefined();
    db.close();
  });

  it('idempotency: enqueueChrClassification can be called many times without contention', () => {
    const db = freshDb();
    for (let i = 0; i < 50; i++) {
      const r = enqueueChrClassification({
        db,
        session_id: 'sess-' + i,
        project: 'p',
        user_text: null,
        assistant_text: 'a',
        source_turn_uuid: 'u-' + i,
      });
      expect(r.enqueued).toBe(true);
    }
    const count = (db.prepare("SELECT COUNT(*) AS n FROM chr_pending_classifications").get() as { n: number }).n;
    expect(count).toBe(50);
    db.close();
  });

  it('migrateV40toV41 is idempotent', () => {
    const db = freshDb();
    // Re-run migration — should be no-op.
    migrateV40toV41(db);
    const cols = (db.pragma('table_info(chr_pending_classifications)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('id');
    db.close();
  });
});
