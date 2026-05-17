/**
 * Phase 14-09 — session_termination deterministic record.
 *
 * 1. V42 fresh-DB table + indexes present
 * 2. V41 → V42 idempotent
 * 3. recordSessionTermination INSERTs valid row
 * 4. recordSessionTermination INSERT OR REPLACE (last-write-wins on session_id)
 * 5. Long fields truncated to bounded length
 * 6. End reason CHECK constraint rejects invalid values
 * 7. inferCrashedSessions marks stale active sessions as 'crash'
 * 8. inferCrashedSessions excludes current session
 * 9. inferCrashedSessions skips sessions already in termination table
 * 10. getRecentTerminations returns ordered DESC by ended_at
 * 11. getRecentTerminations filters by project
 * 12. readLastTurnTexts reads latest user/assistant turn
 * 13. readLastTurnTexts handles zero-turn session
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../core/migrations.js';
import { migrateV41toV42, migrateV42toV41 } from '../../core/migration-steps.js';
import {
  recordSessionTermination,
  inferCrashedSessions,
  getRecentTerminations,
  readLastTurnTexts,
} from '../../core/session-termination.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function seedSession(
  db: Database.Database,
  sessionId: string,
  project: string,
  opts: { status?: string; lastHeartbeat?: number; createdAt?: number } = {},
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (session_id, scope, project, cwd, source, status,
        observation_count, created_at_epoch_ms, last_heartbeat_ts)
     VALUES (?, 'main', ?, '/tmp', 'test', ?, 0, ?, ?)`,
  ).run(
    sessionId,
    project,
    opts.status ?? 'active',
    opts.createdAt ?? now,
    opts.lastHeartbeat ?? now,
  );
}

describe('Phase 14-09: session_termination', () => {
  it('1. V42 fresh-DB: session_termination table + indexes exist', () => {
    const db = freshDb();
    expect(TARGET_USER_VERSION).toBeGreaterThanOrEqual(42);
    const cols = (db.pragma('table_info(session_termination)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'session_id', 'project', 'ended_at_epoch_ms', 'end_reason',
        'last_user_directive', 'last_assistant_text', 'observation_count', 'recorded_at_epoch_ms',
      ]),
    );
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_termination'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain('idx_session_termination_recent');
    expect(idx).toContain('idx_session_termination_project_recent');
    db.close();
  });

  it('2. V41 → V42 migration is idempotent', () => {
    const db = freshDb();
    migrateV41toV42(db); // re-run
    migrateV41toV42(db); // re-run
    const cols = (db.pragma('table_info(session_termination)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('session_id');
    db.close();
  });

  it('migrateV42toV41 drops the table', () => {
    const db = freshDb();
    migrateV42toV41(db);
    const exists = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='session_termination'").get() as { n: number }).n;
    expect(exists).toBe(0);
    db.close();
  });

  it('3. recordSessionTermination INSERTs a valid row', () => {
    const db = freshDb();
    seedSession(db, 'sess-1', 'p1');
    const ok = recordSessionTermination(db, {
      session_id: 'sess-1',
      project: 'p1',
      end_reason: 'endsession',
      last_user_directive: 'do the thing',
      last_assistant_text: 'doing the thing',
    });
    expect(ok).toBe(true);
    const row = db.prepare("SELECT * FROM session_termination WHERE session_id='sess-1'").get() as { end_reason: string; last_user_directive: string };
    expect(row.end_reason).toBe('endsession');
    expect(row.last_user_directive).toBe('do the thing');
    db.close();
  });

  it('4. INSERT OR REPLACE — last write wins on session_id', () => {
    const db = freshDb();
    seedSession(db, 'sess-2', 'p1');

    recordSessionTermination(db, {
      session_id: 'sess-2',
      project: 'p1',
      end_reason: 'crash',
      last_user_directive: 'first',
    });
    recordSessionTermination(db, {
      session_id: 'sess-2',
      project: 'p1',
      end_reason: 'endsession',
      last_user_directive: 'second',
    });

    const rows = db.prepare("SELECT * FROM session_termination WHERE session_id='sess-2'").all() as Array<{ end_reason: string; last_user_directive: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].end_reason).toBe('endsession');
    expect(rows[0].last_user_directive).toBe('second');
    db.close();
  });

  it('5. Long fields truncated to 4000 chars', () => {
    const db = freshDb();
    seedSession(db, 'sess-3', 'p1');
    const huge = 'x'.repeat(10000);
    recordSessionTermination(db, {
      session_id: 'sess-3',
      project: 'p1',
      end_reason: 'endsession',
      last_user_directive: huge,
    });
    const row = db.prepare("SELECT last_user_directive FROM session_termination WHERE session_id='sess-3'").get() as { last_user_directive: string };
    expect(row.last_user_directive.length).toBe(4000);
    db.close();
  });

  it('6. End reason CHECK constraint rejects unknown value', () => {
    const db = freshDb();
    seedSession(db, 'sess-4', 'p1');
    // Direct SQL bypassing the wrapper to verify the CHECK constraint exists.
    expect(() => {
      db.prepare(
        `INSERT INTO session_termination
           (session_id, project, end_reason)
         VALUES ('sess-4', 'p1', 'bogus_reason')`,
      ).run();
    }).toThrow();
    db.close();
  });

  it('7. inferCrashedSessions marks stale active sessions as crash', () => {
    const db = freshDb();
    const oldMs = Date.now() - 60 * 60 * 1000; // 1h ago
    seedSession(db, 'stale-sess', 'p1', { status: 'active', lastHeartbeat: oldMs, createdAt: oldMs });

    const n = inferCrashedSessions(db, { excludeSessionId: 'current-sess' });
    expect(n).toBe(1);

    const row = db.prepare("SELECT end_reason, ended_at_epoch_ms FROM session_termination WHERE session_id='stale-sess'").get() as { end_reason: string; ended_at_epoch_ms: number };
    expect(row.end_reason).toBe('crash');
    expect(row.ended_at_epoch_ms).toBe(oldMs);
    db.close();
  });

  it('8. inferCrashedSessions excludes the current session', () => {
    const db = freshDb();
    const oldMs = Date.now() - 60 * 60 * 1000;
    seedSession(db, 'current-sess', 'p1', { status: 'active', lastHeartbeat: oldMs });

    const n = inferCrashedSessions(db, { excludeSessionId: 'current-sess' });
    expect(n).toBe(0);
    db.close();
  });

  it('9. inferCrashedSessions skips sessions already in termination', () => {
    const db = freshDb();
    const oldMs = Date.now() - 60 * 60 * 1000;
    seedSession(db, 'already-recorded', 'p1', { status: 'active', lastHeartbeat: oldMs });
    recordSessionTermination(db, {
      session_id: 'already-recorded',
      project: 'p1',
      end_reason: 'endsession',
    });

    const n = inferCrashedSessions(db, { excludeSessionId: 'current-sess' });
    expect(n).toBe(0);
    const row = db.prepare("SELECT end_reason FROM session_termination WHERE session_id='already-recorded'").get() as { end_reason: string };
    expect(row.end_reason).toBe('endsession');
    db.close();
  });

  it('10. getRecentTerminations returns rows ordered DESC by ended_at_epoch_ms', () => {
    const db = freshDb();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      seedSession(db, 'sess-' + i, 'p1');
      recordSessionTermination(db, {
        session_id: 'sess-' + i,
        project: 'p1',
        end_reason: 'endsession',
        ended_at_epoch_ms: now - i * 60_000,
      });
    }
    const rows = getRecentTerminations(db, { limit: 3 });
    expect(rows.length).toBe(3);
    expect(rows[0].session_id).toBe('sess-0');
    expect(rows[1].session_id).toBe('sess-1');
    expect(rows[2].session_id).toBe('sess-2');
    db.close();
  });

  it('11. getRecentTerminations filters by project', () => {
    const db = freshDb();
    seedSession(db, 's-a', 'p1');
    seedSession(db, 's-b', 'p2');
    recordSessionTermination(db, { session_id: 's-a', project: 'p1', end_reason: 'endsession' });
    recordSessionTermination(db, { session_id: 's-b', project: 'p2', end_reason: 'endsession' });

    const p1Only = getRecentTerminations(db, { project: 'p1' });
    expect(p1Only.length).toBe(1);
    expect(p1Only[0].project).toBe('p1');

    const p2Only = getRecentTerminations(db, { project: 'p2' });
    expect(p2Only.length).toBe(1);
    expect(p2Only[0].project).toBe('p2');
    db.close();
  });

  it('12. readLastTurnTexts reads latest user/assistant turn', () => {
    const db = freshDb();
    // Discover the timestamp column shape — varies between in-memory fresh
    // and live DBs (V35 epoch rename history). Use whatever exists.
    const cols = (db.pragma('table_info(conversation_turns)') as Array<{ name: string }>).map((c) => c.name);
    const tsCol = cols.find((c) => c.startsWith('timestamp')) ?? 'turn_number';
    db.prepare(`INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, ${tsCol}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('sess-x', 'p1', 1, 'first user', 'first agent', Date.now() - 1000);
    db.prepare(`INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, ${tsCol}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('sess-x', 'p1', 2, 'second user', 'second agent', Date.now());

    const r = readLastTurnTexts(db, 'sess-x');
    expect(r.last_user_directive).toBe('second user');
    expect(r.last_assistant_text).toBe('second agent');
    db.close();
  });

  it('13. readLastTurnTexts returns nulls for zero-turn session', () => {
    const db = freshDb();
    const r = readLastTurnTexts(db, 'no-turns-sess');
    expect(r.last_user_directive).toBeNull();
    expect(r.last_assistant_text).toBeNull();
    db.close();
  });
});
