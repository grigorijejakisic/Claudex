/**
 * Phase 13 Plan 03: session_highlights reader/writer tests (WIR-01 coverage).
 *
 * Runs against an in-memory SQLite DB carrying the V33 schema. Verifies:
 *  - upsertHighlights inserts then replaces on (session_id, project)
 *  - getLatestHighlights returns rows DESC by created_at_epoch_ms
 *  - getHighlightsBySessionId returns the row or null
 *  - Degraded flag, reason, model are round-tripped
 *  - re_extracted_at_epoch_ms is preserved when Opus upgrades a degraded artifact
 *  - getSessionsPendingHighlights joins sessions↔highlights and filters by status
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  upsertHighlights,
  getLatestHighlights,
  getHighlightsBySessionId,
  getSessionsPendingHighlights,
} from '../../intelligence/session-highlights.js';

// V33 + minimal sessions table (the join target for pending-highlights queries).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  mental_model TEXT,
  open_questions TEXT,
  reframes TEXT,
  tools_introduced TEXT,
  decisions_not_made TEXT,
  posture_context TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  degraded_reason TEXT,
  degraded_model TEXT,
  created_at_epoch_ms INTEGER NOT NULL,
  re_extracted_at_epoch_ms INTEGER,
  UNIQUE(session_id, project)
);
CREATE INDEX IF NOT EXISTS idx_session_highlights_project_created
  ON session_highlights (project, created_at_epoch_ms DESC);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT,
  status TEXT DEFAULT 'active',
  created_at_epoch INTEGER DEFAULT 0
);
`;

function makeDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

/**
 * Seed a sessions row. Required after Phase 13.1 Fix #4 (2026-05-15): the
 * upsertHighlights integrity check validates that session_highlights.project
 * matches sessions.project for the same session_id, and getLatestHighlights
 * JOINs to sessions to read project from the source-of-truth column. Without
 * a sessions row, getLatestHighlights returns nothing (correct production
 * behavior: a highlight without an owning session is orphaned).
 */
function seedSession(db: DatabaseType, session_id: string, project: string, status: string = 'completed'): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, created_at_epoch) VALUES (?, ?, ?, 0)`,
  ).run(session_id, project, status);
}

describe('upsertHighlights + getLatestHighlights — WIR-01', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('inserts a highlights row and retrieves it via getLatestHighlights', () => {
    seedSession(db, 'session-1', 'my-project');
    upsertHighlights(db, {
      session_id: 'session-1',
      project: 'my-project',
      mental_model: 'The system uses sqlite-vec for vector storage',
      open_questions: [{ question: 'Is V33 needed?', context: 'Schema evolution discussion' }],
      reframes: [],
      tools_introduced: [{ path: 'src/angel/sessions-indexer.ts', purpose: 'Indexes Sessions/ markdown' }],
      decisions_not_made: [],
      posture_context: 'Operator was energized, moving fast',
      degraded: false,
      created_at_epoch_ms: 1000,
    });

    const rows = getLatestHighlights(db, 'my-project', 3);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('session-1');
    expect(rows[0].mental_model).toBe('The system uses sqlite-vec for vector storage');
    expect(rows[0].open_questions).toEqual([{ question: 'Is V33 needed?', context: 'Schema evolution discussion' }]);
    expect(rows[0].tools_introduced?.[0].path).toBe('src/angel/sessions-indexer.ts');
    expect(rows[0].degraded).toBe(false);
  });

  it('upsert replaces existing row for same session_id + project (UNIQUE constraint)', () => {
    seedSession(db, 's1', 'p1');
    upsertHighlights(db, { session_id: 's1', project: 'p1', mental_model: 'v1', created_at_epoch_ms: 1000 });
    upsertHighlights(db, { session_id: 's1', project: 'p1', mental_model: 'v2', created_at_epoch_ms: 1001 });
    const rows = getLatestHighlights(db, 'p1', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].mental_model).toBe('v2');
  });

  it('getLatestHighlights returns latest N by created_at_epoch_ms DESC', () => {
    for (let i = 1; i <= 5; i++) {
      seedSession(db, `s${i}`, 'p1');
      upsertHighlights(db, { session_id: `s${i}`, project: 'p1', mental_model: `model-${i}`, created_at_epoch_ms: i * 1000 });
    }
    const rows = getLatestHighlights(db, 'p1', 3);
    expect(rows).toHaveLength(3);
    expect(rows[0].session_id).toBe('s5');
    expect(rows[1].session_id).toBe('s4');
    expect(rows[2].session_id).toBe('s3');
  });

  it('getHighlightsBySessionId returns correct row or null', () => {
    seedSession(db, 'find-me', 'p1');
    upsertHighlights(db, { session_id: 'find-me', project: 'p1', mental_model: 'x', created_at_epoch_ms: 1000 });
    const found = getHighlightsBySessionId(db, 'find-me', 'p1');
    expect(found).not.toBeNull();
    expect(found?.mental_model).toBe('x');
    const notFound = getHighlightsBySessionId(db, 'missing', 'p1');
    expect(notFound).toBeNull();
  });

  it('stores degraded=true artifacts with reason + model', () => {
    seedSession(db, 'degraded-session', 'p1');
    upsertHighlights(db, {
      session_id: 'degraded-session',
      project: 'p1',
      degraded: true,
      degraded_reason: 'opus_timeout',
      degraded_model: 'glm-5.1:cloud',
      created_at_epoch_ms: 9999,
    });
    const row = getHighlightsBySessionId(db, 'degraded-session', 'p1');
    expect(row?.degraded).toBe(true);
    expect(row?.degraded_reason).toBe('opus_timeout');
    expect(row?.degraded_model).toBe('glm-5.1:cloud');
  });

  it('re_extracted_at_epoch_ms is preserved when Opus upgrades a degraded artifact', () => {
    seedSession(db, 'retry-session', 'p1');
    upsertHighlights(db, {
      session_id: 'retry-session', project: 'p1',
      degraded: true, degraded_reason: 'opus_timeout',
      created_at_epoch_ms: 1000,
    });
    upsertHighlights(db, {
      session_id: 'retry-session', project: 'p1',
      mental_model: 'Recovered',
      degraded: false,
      created_at_epoch_ms: 1000,
      re_extracted_at_epoch_ms: 2000,
    });
    const row = getHighlightsBySessionId(db, 'retry-session', 'p1');
    expect(row?.degraded).toBe(false);
    expect(row?.re_extracted_at_epoch_ms).toBe(2000);
    expect(row?.mental_model).toBe('Recovered');
  });

  it('isolates rows by project (DESC ordering is per-project)', () => {
    seedSession(db, 'sA', 'pA');
    seedSession(db, 'sB', 'pB');
    upsertHighlights(db, { session_id: 'sA', project: 'pA', mental_model: 'A1', created_at_epoch_ms: 1000 });
    upsertHighlights(db, { session_id: 'sB', project: 'pB', mental_model: 'B1', created_at_epoch_ms: 2000 });
    const a = getLatestHighlights(db, 'pA', 5);
    const b = getLatestHighlights(db, 'pB', 5);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].mental_model).toBe('A1');
    expect(b[0].mental_model).toBe('B1');
  });

  it('returns [] safely when the project has no highlights', () => {
    const rows = getLatestHighlights(db, 'empty-project', 3);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 13.1 Fix #4 (2026-05-15): project-truth filter via sessions JOIN
// ---------------------------------------------------------------------------
describe('Phase 13.1 Fix #4 — project integrity', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('upsertHighlights rejects project mismatch vs sessions.project', () => {
    seedSession(db, 'cross-project-s', 'big-mozzy-v2');
    expect(() =>
      upsertHighlights(db, {
        session_id: 'cross-project-s',
        project: 'claudex-v3',
        mental_model: 'oops',
        created_at_epoch_ms: 1000,
      }),
    ).toThrow(/project mismatch/i);
  });

  it('upsertHighlights tolerates orphan session_id (no sessions row yet)', () => {
    // Some test/seed callers may upsert before the sessions row lands.
    // The integrity check is best-effort: when the row is absent, the
    // check skips rather than blocks the write.
    expect(() =>
      upsertHighlights(db, {
        session_id: 'orphan-s',
        project: 'p1',
        mental_model: 'first write',
        created_at_epoch_ms: 1000,
      }),
    ).not.toThrow();
  });

  it('getLatestHighlights JOIN filters on sessions.project, not session_highlights.project', () => {
    // Simulate a legacy cross-attribution row: session belongs to project A
    // but a stale highlight row in the DB still claims project B. The JOIN
    // means it surfaces under A (the source of truth), not B.
    seedSession(db, 'legacy-mismatch', 'project-A');
    db.prepare(
      `INSERT INTO session_highlights (session_id, project, mental_model, created_at_epoch_ms, degraded)
       VALUES ('legacy-mismatch', 'project-B', 'leaked', 1000, 0)`,
    ).run();
    const a = getLatestHighlights(db, 'project-A', 5);
    const b = getLatestHighlights(db, 'project-B', 5);
    expect(a).toHaveLength(1);
    expect(a[0].mental_model).toBe('leaked');
    expect(b).toEqual([]);
  });

  it('getLatestHighlights returns nothing for a project with no sessions of its own', () => {
    seedSession(db, 'belongs-to-other', 'project-X');
    upsertHighlights(db, {
      session_id: 'belongs-to-other',
      project: 'project-X',
      mental_model: 'X content',
      created_at_epoch_ms: 1000,
    });
    // A different project queries — no JOIN matches, expect [].
    const rows = getLatestHighlights(db, 'project-Y', 5);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 13.1 Fix #6 (2026-05-15): ACTIVE.md created_at_epoch_ms freshness floor
// ---------------------------------------------------------------------------
describe('Phase 13.1 Fix #6 — getLatestHighlights minEpochMs floor', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('drops rows older than minEpochMs', () => {
    seedSession(db, 'old-s', 'p1');
    seedSession(db, 'new-s', 'p1');
    upsertHighlights(db, { session_id: 'old-s', project: 'p1', mental_model: 'pre-pivot', created_at_epoch_ms: 1000 });
    upsertHighlights(db, { session_id: 'new-s', project: 'p1', mental_model: 'post-pivot', created_at_epoch_ms: 5000 });
    const rows = getLatestHighlights(db, 'p1', 10, 3000);
    expect(rows).toHaveLength(1);
    expect(rows[0].mental_model).toBe('post-pivot');
  });

  it('keeps rows at-or-after minEpochMs (>= boundary)', () => {
    seedSession(db, 'boundary-s', 'p1');
    upsertHighlights(db, { session_id: 'boundary-s', project: 'p1', mental_model: 'on-boundary', created_at_epoch_ms: 5000 });
    const rows = getLatestHighlights(db, 'p1', 10, 5000);
    expect(rows).toHaveLength(1);
  });

  it('falls back to unfiltered query when minEpochMs is undefined', () => {
    seedSession(db, 'old-s', 'p1');
    upsertHighlights(db, { session_id: 'old-s', project: 'p1', mental_model: 'old', created_at_epoch_ms: 1000 });
    expect(getLatestHighlights(db, 'p1', 10).length).toBe(1);
    expect(getLatestHighlights(db, 'p1', 10, undefined).length).toBe(1);
  });

  it('still respects the JOIN — orphan highlights stay invisible even with floor unset', () => {
    db.prepare(
      `INSERT INTO session_highlights (session_id, project, mental_model, created_at_epoch_ms, degraded)
       VALUES ('orphan', 'p1', 'no session row', 9999, 0)`,
    ).run();
    expect(getLatestHighlights(db, 'p1', 10).length).toBe(0);
    expect(getLatestHighlights(db, 'p1', 10, 0).length).toBe(0);
  });
});

describe('getSessionsPendingHighlights', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('returns session IDs for completed sessions without highlights', () => {
    db.exec(`INSERT INTO sessions (session_id, project, status) VALUES ('pending-s1', 'p1', 'completed')`);
    db.exec(`INSERT INTO sessions (session_id, project, status) VALUES ('pending-s2', 'p1', 'completed')`);
    db.exec(`INSERT INTO sessions (session_id, project, status) VALUES ('active-s3', 'p1', 'active')`);

    const pending = getSessionsPendingHighlights(db, 'p1', 10);
    expect(pending).toContain('pending-s1');
    expect(pending).toContain('pending-s2');
    expect(pending).not.toContain('active-s3');
  });

  it('excludes sessions that already have non-degraded highlights', () => {
    db.exec(`INSERT INTO sessions (session_id, project, status) VALUES ('has-highlights', 'p1', 'completed')`);
    upsertHighlights(db, { session_id: 'has-highlights', project: 'p1', degraded: false, created_at_epoch_ms: 1000 });
    const pending = getSessionsPendingHighlights(db, 'p1', 10);
    expect(pending).not.toContain('has-highlights');
  });

  it('includes sessions with degraded highlights (for retry)', () => {
    db.exec(`INSERT INTO sessions (session_id, project, status) VALUES ('degraded-s', 'p1', 'completed')`);
    upsertHighlights(db, {
      session_id: 'degraded-s', project: 'p1',
      degraded: true, degraded_reason: 'opus_timeout',
      created_at_epoch_ms: 1000,
    });
    const pending = getSessionsPendingHighlights(db, 'p1', 10);
    expect(pending).toContain('degraded-s');
  });

  it('isolates by project', () => {
    db.exec(`INSERT INTO sessions (session_id, project, status) VALUES ('only-pA', 'pA', 'completed')`);
    db.exec(`INSERT INTO sessions (session_id, project, status) VALUES ('only-pB', 'pB', 'completed')`);
    const pendingA = getSessionsPendingHighlights(db, 'pA', 10);
    const pendingB = getSessionsPendingHighlights(db, 'pB', 10);
    expect(pendingA).toEqual(['only-pA']);
    expect(pendingB).toEqual(['only-pB']);
  });
});
