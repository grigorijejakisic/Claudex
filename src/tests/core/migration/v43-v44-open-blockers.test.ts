/**
 * V43 → V44: add `open_blockers` to session_termination.
 *
 * Closes the confessed punt from session d2237451 (2026-05-17 turn 213):
 * "open_blockers field NOT included — I punted that as a v1 design choice
 * without telling you." Captures unresolved wip/danger/failure signals at
 * close time so a fresh agent reading "why did the last session stop?"
 * also gets "what was unfinished."
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, TARGET_USER_VERSION } from '../../../core/migrations.js';
import {
  migrateV43toV44,
  migrateV44toV43,
} from '../../../core/migration-steps.js';
import {
  recordSessionTermination,
  getRecentTerminations,
  deriveOpenBlockers,
  type OpenBlocker,
} from '../../../core/session-termination.js';
import { createSession } from '../../../core/sessions.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

describe('V43 → V44 migration', () => {
  it('adds open_blockers column to session_termination', () => {
    const db = freshDb();

    const cols = db.prepare('PRAGMA table_info(session_termination)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'open_blockers')).toBe(true);

    db.close();
  });

  it('bumps user_version to 44', () => {
    const db = freshDb();
    const v = db.pragma('user_version', { simple: true });
    expect(v).toBeGreaterThanOrEqual(44);
    expect(TARGET_USER_VERSION).toBeGreaterThanOrEqual(44);
    db.close();
  });

  it('is idempotent — re-running V44 on a V44 DB is a no-op', () => {
    const db = freshDb();
    expect(() => migrateV43toV44(db)).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(session_termination)').all() as Array<{ name: string }>;
    expect(cols.filter(c => c.name === 'open_blockers').length).toBe(1);
    db.close();
  });

  it('reverse V44 → V43 drops the open_blockers column', () => {
    const db = freshDb();
    migrateV44toV43(db);
    const cols = db.prepare('PRAGMA table_info(session_termination)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'open_blockers')).toBe(false);
    const v = db.pragma('user_version', { simple: true });
    expect(v).toBe(43);
    db.close();
  });
});

describe('open_blockers — write + derivation', () => {
  let db: Database.Database;
  const project = 'claudex-v3';
  const sessionId = 'sess-with-blockers';

  beforeEach(() => {
    db = freshDb();
    createSession(db, {
      session_id: sessionId,
      project,
      cwd: 'C:/test',
      source: 'test',
    });
  });

  afterEach(() => { db.close(); });

  function insertSignal(opts: {
    signal_type: 'wip' | 'failure' | 'danger' | 'claim' | 'discovery';
    target: string;
    detail?: string | null;
    cleared?: boolean;
    expired?: boolean;
  }): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO session_signals (session_id, project, signal_type, target, detail,
                                     created_at_epoch_ms, expires_at_epoch_ms, cleared_at_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      project,
      opts.signal_type,
      opts.target,
      opts.detail ?? null,
      now,
      opts.expired ? now - 1000 : null,
      opts.cleared ? now : null,
    );
  }

  it('deriveOpenBlockers returns only active wip/danger/failure signals', () => {
    insertSignal({ signal_type: 'wip', target: 'src/foo.ts', detail: 'refactoring' });
    insertSignal({ signal_type: 'danger', target: 'src/bar.ts', detail: 'race condition' });
    insertSignal({ signal_type: 'failure', target: 'src/baz.ts', detail: 'test broke' });
    insertSignal({ signal_type: 'claim', target: 'src/skip.ts' }); // wrong type
    insertSignal({ signal_type: 'discovery', target: 'src/skip2.ts' }); // wrong type
    insertSignal({ signal_type: 'wip', target: 'src/cleared.ts', cleared: true }); // cleared
    insertSignal({ signal_type: 'failure', target: 'src/expired.ts', expired: true }); // expired

    const blockers = deriveOpenBlockers(db, sessionId);
    expect(blockers.length).toBe(3);
    expect(blockers.map(b => b.target).sort()).toEqual(['src/bar.ts', 'src/baz.ts', 'src/foo.ts']);
  });

  it('recordSessionTermination auto-populates open_blockers from active signals', () => {
    insertSignal({ signal_type: 'wip', target: 'src/foo.ts', detail: 'mid-refactor' });
    insertSignal({ signal_type: 'failure', target: 'src/bar.ts', detail: null });

    const ok = recordSessionTermination(db, {
      session_id: sessionId,
      project,
      end_reason: 'compact',
    });
    expect(ok).toBe(true);

    const row = db.prepare(
      `SELECT open_blockers FROM session_termination WHERE session_id = ?`,
    ).get(sessionId) as { open_blockers: string | null };
    expect(row.open_blockers).not.toBeNull();
    const parsed = JSON.parse(row.open_blockers!) as OpenBlocker[];
    expect(parsed.length).toBe(2);
    const wip = parsed.find(b => b.target === 'src/foo.ts');
    expect(wip).toEqual({ signal_type: 'wip', target: 'src/foo.ts', detail: 'mid-refactor' });
  });

  it('recordSessionTermination stores null when no active signals', () => {
    recordSessionTermination(db, {
      session_id: sessionId,
      project,
      end_reason: 'endsession',
    });
    const row = db.prepare(
      `SELECT open_blockers FROM session_termination WHERE session_id = ?`,
    ).get(sessionId) as { open_blockers: string | null };
    expect(row.open_blockers).toBeNull();
  });

  it('caller can override with explicit open_blockers array', () => {
    insertSignal({ signal_type: 'wip', target: 'src/auto.ts' });

    recordSessionTermination(db, {
      session_id: sessionId,
      project,
      end_reason: 'endsession',
      open_blockers: [
        { signal_type: 'danger', target: 'src/manual.ts', detail: 'operator-set' },
      ],
    });
    const row = db.prepare(
      `SELECT open_blockers FROM session_termination WHERE session_id = ?`,
    ).get(sessionId) as { open_blockers: string | null };
    const parsed = JSON.parse(row.open_blockers!) as OpenBlocker[];
    expect(parsed).toEqual([{ signal_type: 'danger', target: 'src/manual.ts', detail: 'operator-set' }]);
  });

  it('caller can suppress auto-derivation by passing null', () => {
    insertSignal({ signal_type: 'wip', target: 'src/auto.ts' });

    recordSessionTermination(db, {
      session_id: sessionId,
      project,
      end_reason: 'endsession',
      open_blockers: null,
    });
    const row = db.prepare(
      `SELECT open_blockers FROM session_termination WHERE session_id = ?`,
    ).get(sessionId) as { open_blockers: string | null };
    expect(row.open_blockers).toBeNull();
  });

  it('getRecentTerminations surfaces open_blockers on derived rows too', () => {
    // No session_termination row, but session has ended and has an active signal
    insertSignal({ signal_type: 'wip', target: 'src/forgot.ts', detail: 'unfinished' });
    db.prepare(
      `UPDATE sessions SET status = 'completed', ended_at_epoch_ms = ? WHERE session_id = ?`,
    ).run(Date.now() - 1000, sessionId);

    const rows = getRecentTerminations(db, { limit: 5, project });
    expect(rows.length).toBe(1);
    expect(rows[0].open_blockers).not.toBeNull();
    const parsed = JSON.parse(rows[0].open_blockers!) as OpenBlocker[];
    expect(parsed).toEqual([
      { signal_type: 'wip', target: 'src/forgot.ts', detail: 'unfinished' },
    ]);
  });
});
