/**
 * reconcileTerminationClassifications — continuous mechanism that promotes
 * `end_reason='unknown'` rows to `'crash'` when the next session's first
 * user_framing event contains explicit crash markers.
 *
 * Replaces the 2026-05-18 one-shot promote-crash-terminations.cjs with a
 * function that runs from session-start, so future crashes get attributed
 * as soon as the operator's recovery session writes its first user_framing.
 *
 * Operator-stated principle (2026-05-18): "this should be a mechanism that
 * always works no matter the search" — classification can't be frozen at
 * write time when the deterministic signal only emerges later.
 */

import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import {
  recordSessionTermination,
  reconcileTerminationClassifications,
} from '../../core/session-termination.js';

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

describe('reconcileTerminationClassifications', () => {
  let db: TestDatabase;
  const project = 'claudex-v3';
  const nowMs = Date.now();

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => { db.close(); });

  function seedSession(opts: { sessionId: string; createdAtMs: number; endedAtMs: number; status?: string }): void {
    createSession(db, {
      session_id: opts.sessionId,
      project,
      cwd: 'C:/test',
      source: 'test',
    });
    db.prepare(
      `UPDATE sessions SET status = ?, created_at_epoch_ms = ?, ended_at_epoch_ms = ? WHERE session_id = ?`,
    ).run(opts.status ?? 'completed', opts.createdAtMs, opts.endedAtMs, opts.sessionId);
  }

  it('promotes unknown → crash when next session framing says "PC crashed"', () => {
    seedSession({ sessionId: 'crashed-sess', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'recovery-sess', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'crashed-sess',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    seedUserFraming(
      db,
      'recovery-sess',
      project,
      'PC crashed last night, please recover the prior session',
      Math.floor((nowMs - 1800_000) / 1000),
    );

    const promoted = reconcileTerminationClassifications(db);
    expect(promoted).toBe(1);

    const row = db.prepare(`SELECT end_reason FROM session_termination WHERE session_id = 'crashed-sess'`).get() as { end_reason: string };
    expect(row.end_reason).toBe('crash');
  });

  it('does NOT promote when next framing is a normal conceptual prompt', () => {
    seedSession({ sessionId: 'idle-sess', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'next-sess', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'idle-sess',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    seedUserFraming(
      db,
      'next-sess',
      project,
      'lets continue work on the v8 deployment strategy',
      Math.floor((nowMs - 1800_000) / 1000),
    );

    const promoted = reconcileTerminationClassifications(db);
    expect(promoted).toBe(0);

    const row = db.prepare(`SELECT end_reason FROM session_termination WHERE session_id = 'idle-sess'`).get() as { end_reason: string };
    expect(row.end_reason).toBe('unknown');
  });

  it('does NOT touch sessions that already have non-unknown reasons', () => {
    seedSession({ sessionId: 'real-end', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'next-sess', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'real-end',
      project,
      end_reason: 'endsession',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    // Even if the next framing contains crash markers, an endsession row stays endsession.
    seedUserFraming(
      db,
      'next-sess',
      project,
      'PC crashed last night',
      Math.floor((nowMs - 1800_000) / 1000),
    );

    reconcileTerminationClassifications(db);
    const row = db.prepare(`SELECT end_reason FROM session_termination WHERE session_id = 'real-end'`).get() as { end_reason: string };
    expect(row.end_reason).toBe('endsession');
  });

  it('matches multiple recovery framings: died, got cut off, killed our, abrubptly died', () => {
    const fixtures: Array<{ sid: string; framing: string }> = [
      { sid: 'c1', framing: 'session died last night, please recover' },
      { sid: 'c2', framing: 'we got cut off mid-deploy, can you continue' },
      { sid: 'c3', framing: 'PC crahsed and killed our auto-orchestrate' }, // typo intentional
      { sid: 'c4', framing: 'previous session died, retrieve the context' },
      { sid: 'c5', framing: 'our worst fear happened, PC died over night' },
    ];
    for (let i = 0; i < fixtures.length; i++) {
      const baseMs = nowMs - (10000 - i * 500) * 1000;
      const crashedSid = fixtures[i].sid;
      const recoverySid = `${crashedSid}-recovery`;
      seedSession({ sessionId: crashedSid, createdAtMs: baseMs - 1000_000, endedAtMs: baseMs - 500_000 });
      seedSession({ sessionId: recoverySid, createdAtMs: baseMs - 300_000, endedAtMs: baseMs - 100_000 });
      recordSessionTermination(db, {
        session_id: crashedSid,
        project,
        end_reason: 'unknown',
        ended_at_epoch_ms: baseMs - 500_000,
      });
      seedUserFraming(db, recoverySid, project, fixtures[i].framing, Math.floor((baseMs - 300_000) / 1000));
    }

    const promoted = reconcileTerminationClassifications(db);
    expect(promoted).toBe(5);
  });

  it('is project-scoped — next session in a different project does not promote', () => {
    seedSession({ sessionId: 'sess-a', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    recordSessionTermination(db, {
      session_id: 'sess-a',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    // Cross-project recovery — different project, should NOT match.
    createSession(db, {
      session_id: 'sess-b-other-project',
      project: 'other-project',
      cwd: 'C:/test',
      source: 'test',
    });
    db.prepare(`UPDATE sessions SET created_at_epoch_ms = ? WHERE session_id = ?`)
      .run(nowMs - 1800_000, 'sess-b-other-project');
    seedUserFraming(
      db,
      'sess-b-other-project',
      'other-project',
      'PC crashed',
      Math.floor((nowMs - 1800_000) / 1000),
    );

    const promoted = reconcileTerminationClassifications(db);
    expect(promoted).toBe(0);
  });

  it('is idempotent — running twice on the same data yields zero on the second call', () => {
    seedSession({ sessionId: 'crashed-once', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'recovery-once', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'crashed-once',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    seedUserFraming(db, 'recovery-once', project, 'PC crashed', Math.floor((nowMs - 1800_000) / 1000));

    expect(reconcileTerminationClassifications(db)).toBe(1);
    expect(reconcileTerminationClassifications(db)).toBe(0);
  });
});
