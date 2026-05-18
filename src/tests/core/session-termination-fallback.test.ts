/**
 * Regression: `getRecentTerminations` must derive from the `sessions` table
 * when `session_termination` is empty.
 *
 * Found 2026-05-18 fresh-session gate test (claudex-v3): the new
 * `claudex_recent_sessions` MCP tool returned `[]` because Phase 13.1's
 * heartbeat hang means session_termination never gets written, despite
 * `sessions.ended_at_epoch_ms` having plenty of signal. The prior session
 * shipped the tool with 3 tests but none covered "what if the table is
 * empty in production" — which is the actual production state today.
 *
 * Fix: when `getRecentTerminations` returns N < limit rows from
 * session_termination, top up from `sessions` with derived synthetic rows
 * enriched by the last user_framing event as `last_user_directive`.
 */

import { describe, it, expect } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import {
  getRecentTerminations,
  getDerivedTerminations,
  recordSessionTermination,
} from '../../core/session-termination.js';

function seedSession(
  db: TestDatabase,
  opts: {
    sessionId: string;
    project: string;
    status?: 'completed' | 'active' | 'expired';
    createdAtMs: number;
    endedAtMs?: number | null;
    observationCount?: number;
    sessionSummary?: string | null;
  },
): void {
  createSession(db, {
    session_id: opts.sessionId,
    project: opts.project,
    cwd: 'C:/test',
    source: 'test',
  });
  db.prepare(
    `UPDATE sessions
       SET status = ?, created_at_epoch_ms = ?, ended_at_epoch_ms = ?,
           observation_count = ?, session_summary = ?
     WHERE session_id = ?`,
  ).run(
    opts.status ?? 'completed',
    opts.createdAtMs,
    opts.endedAtMs ?? null,
    opts.observationCount ?? 0,
    opts.sessionSummary ?? null,
    opts.sessionId,
  );
}

function seedUserFraming(
  db: TestDatabase,
  sessionId: string,
  project: string,
  detail: string,
  timestampSec: number,
): void {
  const cols = db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>;
  const hasMs = cols.some(c => c.name === 'timestamp_epoch_ms');
  const tsCol = hasMs ? 'timestamp_epoch_ms' : 'timestamp_epoch';
  const tsVal = hasMs ? timestampSec * 1000 : timestampSec;
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, ${tsCol})
     VALUES (?, ?, 'user_framing', 'prompt', 'framed', ?, ?)`,
  ).run(sessionId, project, detail, tsVal);
}

describe('getRecentTerminations — empty session_termination fallback', () => {
  let db: TestDatabase;
  const project = 'claudex-v3';
  const nowMs = Date.now();

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns derived rows when session_termination has 0 rows', () => {
    seedSession(db, {
      sessionId: 'sess-a',
      project,
      status: 'completed',
      createdAtMs: nowMs - 3600_000,
      endedAtMs: nowMs - 1800_000,
      observationCount: 42,
    });
    seedUserFraming(db, 'sess-a', project, 'why did production stop?', Math.floor((nowMs - 2000_000) / 1000));

    expect(db.prepare('SELECT COUNT(*) AS n FROM session_termination').get())
      .toEqual({ n: 0 });

    const rows = getRecentTerminations(db, { limit: 5, project });
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.session_id).toBe('sess-a');
    expect(r.project).toBe(project);
    // 2026-05-18: derived rows now return 'unknown' (truthful) instead of
    // fabricating 'endsession'. sessions.status='completed' does NOT mean
    // operator ran /endsession — it means "no longer active." The derived
    // flag carries the provenance.
    expect(r.end_reason).toBe('unknown');
    expect(r.derived).toBe(true);
    expect(r.observation_count).toBe(42);
    expect(r.last_user_directive).toBe('why did production stop?');
    expect(r.last_assistant_text).toBeNull();
    expect(r.ended_at_epoch_ms).toBe(nowMs - 1800_000);
  });

  it('maps sessions.status=active → end_reason=crash for orphaned sessions', () => {
    seedSession(db, {
      sessionId: 'sess-crashed',
      project,
      status: 'active',
      createdAtMs: nowMs - 3600_000,
      endedAtMs: nowMs - 1000_000,
    });
    const rows = getRecentTerminations(db, { limit: 5, project });
    expect(rows.length).toBe(1);
    expect(rows[0].end_reason).toBe('crash');
  });

  it('prefers session_termination rows over derived rows when both exist', () => {
    // A: real termination row
    seedSession(db, {
      sessionId: 'sess-a',
      project,
      status: 'completed',
      createdAtMs: nowMs - 7200_000,
      endedAtMs: nowMs - 3600_000,
    });
    recordSessionTermination(db, {
      session_id: 'sess-a',
      project,
      end_reason: 'compact',
      ended_at_epoch_ms: nowMs - 3600_000,
      last_user_directive: 'compact directive',
    });

    // B: derived (no termination row)
    seedSession(db, {
      sessionId: 'sess-b',
      project,
      status: 'completed',
      createdAtMs: nowMs - 3600_000,
      endedAtMs: nowMs - 1800_000,
    });

    const rows = getRecentTerminations(db, { limit: 5, project });
    expect(rows.length).toBe(2);

    // Newest first, sess-b ended later
    expect(rows[0].session_id).toBe('sess-b');
    expect(rows[1].session_id).toBe('sess-a');

    // sess-a is the REAL row with end_reason='compact' (not derived)
    expect(rows[1].end_reason).toBe('compact');
    expect(rows[1].last_user_directive).toBe('compact directive');

    // sess-b is the DERIVED row
    expect(rows[0].end_reason).toBe('endsession');
  });

  it('respects excludeSessionId across both primary and derived', () => {
    seedSession(db, {
      sessionId: 'sess-current',
      project,
      status: 'completed',
      createdAtMs: nowMs - 3600_000,
      endedAtMs: nowMs - 1800_000,
    });
    seedSession(db, {
      sessionId: 'sess-other',
      project,
      status: 'completed',
      createdAtMs: nowMs - 7200_000,
      endedAtMs: nowMs - 3600_000,
    });

    const rows = getRecentTerminations(db, {
      limit: 5,
      project,
      excludeSessionId: 'sess-current',
    });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('sess-other');
  });

  it('respects project filter', () => {
    seedSession(db, {
      sessionId: 'sess-a',
      project: 'project-a',
      status: 'completed',
      createdAtMs: nowMs - 3600_000,
      endedAtMs: nowMs - 1800_000,
    });
    seedSession(db, {
      sessionId: 'sess-b',
      project: 'project-b',
      status: 'completed',
      createdAtMs: nowMs - 3600_000,
      endedAtMs: nowMs - 1800_000,
    });

    const rows = getRecentTerminations(db, { limit: 5, project: 'project-a' });
    expect(rows.length).toBe(1);
    expect(rows[0].project).toBe('project-a');
  });

  it('skips sessions with ended_at_epoch_ms IS NULL', () => {
    seedSession(db, {
      sessionId: 'sess-running',
      project,
      status: 'active',
      createdAtMs: nowMs - 600_000,
      endedAtMs: null,
    });
    const rows = getRecentTerminations(db, { limit: 5, project });
    expect(rows.length).toBe(0);
  });
});

describe('getDerivedTerminations — direct API', () => {
  let db: TestDatabase;
  const project = 'claudex-v3';
  const nowMs = Date.now();

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('respects excludeSessionIds set', () => {
    seedSession(db, {
      sessionId: 'sess-keep',
      project,
      status: 'completed',
      createdAtMs: nowMs - 3600_000,
      endedAtMs: nowMs - 1800_000,
    });
    seedSession(db, {
      sessionId: 'sess-skip',
      project,
      status: 'completed',
      createdAtMs: nowMs - 7200_000,
      endedAtMs: nowMs - 3600_000,
    });

    const rows = getDerivedTerminations(db, {
      limit: 5,
      project,
      excludeSessionIds: new Set(['sess-skip']),
    });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('sess-keep');
  });
});
