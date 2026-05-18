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

    const r = reconcileTerminationClassifications(db);
    expect(r.promoted).toBe(1);
    expect(r.by_classifier['crash-from-recovery-framing']).toBe(1);
    expect(r.by_new_reason['crash']).toBe(1);

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

    const r = reconcileTerminationClassifications(db);
    expect(r.promoted).toBe(0);

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

    const r = reconcileTerminationClassifications(db);
    expect(r.promoted).toBe(5);
    expect(r.by_classifier['crash-from-recovery-framing']).toBe(5);
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

    const r = reconcileTerminationClassifications(db);
    expect(r.promoted).toBe(0);
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

    expect(reconcileTerminationClassifications(db).promoted).toBe(1);
    expect(reconcileTerminationClassifications(db).promoted).toBe(0);
  });

  // 2026-05-18: V45 cursor optimization — rows already examined with no new
  // evidence shouldn't be re-scanned. After a pass examines them, subsequent
  // passes skip via last_reconciliation_attempt_ms unless a NEW session
  // appears in the same project.
  it('cursor: second pass scans 0 rows when no new evidence', () => {
    seedSession({ sessionId: 'idle-cursor', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'next-cursor', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'idle-cursor',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    seedUserFraming(db, 'next-cursor', project, 'unrelated conceptual question', Math.floor((nowMs - 1800_000) / 1000));

    const r1 = reconcileTerminationClassifications(db);
    expect(r1.scanned).toBe(1);
    expect(r1.promoted).toBe(0);

    // No new session created → cursor skips on second pass
    const r2 = reconcileTerminationClassifications(db);
    expect(r2.scanned).toBe(0);
  });

  it('cursor: second pass DOES rescan when a new session is created in the same project', () => {
    seedSession({ sessionId: 'idle-rescan', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'unrelated-mid', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'idle-rescan',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    seedUserFraming(db, 'unrelated-mid', project, 'normal continuation prompt', Math.floor((nowMs - 1800_000) / 1000));

    const r1 = reconcileTerminationClassifications(db);
    expect(r1.scanned).toBe(1);

    // New session appears AFTER reconciliation cursor → must rescan
    seedSession({ sessionId: 'recovery-late', createdAtMs: nowMs + 60_000, endedAtMs: nowMs + 120_000 });
    seedUserFraming(db, 'recovery-late', project, 'PC crashed — recover please', Math.floor((nowMs + 60_000) / 1000));

    const r2 = reconcileTerminationClassifications(db);
    expect(r2.scanned).toBeGreaterThan(0);
    expect(r2.promoted).toBe(1);
  });

  // 2026-05-18: second classifier — endsessionFromSessionEndAction
  it('promotes unknown → endsession when telemetry has session_end_action row', () => {
    seedSession({ sessionId: 'cleanly-closed', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    recordSessionTermination(db, {
      session_id: 'cleanly-closed',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    // Seed the deterministic /endsession evidence — boundary-detector's
    // fireEndOfSessionActions writes session_end_action telemetry rows.
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES ('cleanly-closed', 'session_end_action', '{}', 'test')`,
    ).run();

    const r = reconcileTerminationClassifications(db);
    expect(r.promoted).toBe(1);
    expect(r.by_classifier['endsession-from-session-end-action']).toBe(1);
    expect(r.by_new_reason['endsession']).toBe(1);

    const row = db.prepare(`SELECT end_reason FROM session_termination WHERE session_id = 'cleanly-closed'`).get() as { end_reason: string };
    expect(row.end_reason).toBe('endsession');
  });

  // 2026-05-18: first matching classifier wins — crash detection runs first.
  it('crash classifier wins over endsession when both apply', () => {
    seedSession({ sessionId: 'crash-and-endsession', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'recovery-mixed', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'crash-and-endsession',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    // Both signals present
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES ('crash-and-endsession', 'session_end_action', '{}', 'test')`,
    ).run();
    seedUserFraming(db, 'recovery-mixed', project, 'PC crashed last night', Math.floor((nowMs - 1800_000) / 1000));

    const r = reconcileTerminationClassifications(db);
    expect(r.promoted).toBe(1);
    expect(r.by_classifier['crash-from-recovery-framing']).toBe(1);
    expect(r.by_classifier['endsession-from-session-end-action']).toBeUndefined();
  });

  // 2026-05-18: telemetry write
  it('writes a reconcile_pass telemetry row when promotions occur', () => {
    seedSession({ sessionId: 'tel-crash', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'tel-recovery', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'tel-crash',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    seedUserFraming(db, 'tel-recovery', project, 'PC crashed!', Math.floor((nowMs - 1800_000) / 1000));

    reconcileTerminationClassifications(db);

    const tel = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind = 'reconcile_pass' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail: string } | undefined;
    expect(tel).toBeDefined();
    const parsed = JSON.parse(tel!.detail);
    expect(parsed.promoted).toBe(1);
    expect(parsed.by_classifier['crash-from-recovery-framing']).toBe(1);
    expect(parsed.scanned).toBeGreaterThanOrEqual(1);
  });

  it('does NOT write reconcile_pass telemetry when zero promotions', () => {
    seedSession({ sessionId: 'tel-skip', createdAtMs: nowMs - 7200_000, endedAtMs: nowMs - 3600_000 });
    seedSession({ sessionId: 'tel-skip-next', createdAtMs: nowMs - 1800_000, endedAtMs: nowMs - 600_000 });
    recordSessionTermination(db, {
      session_id: 'tel-skip',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });
    seedUserFraming(db, 'tel-skip-next', project, 'no crash here', Math.floor((nowMs - 1800_000) / 1000));

    const before = db.prepare(`SELECT COUNT(*) AS n FROM telemetry WHERE event_kind = 'reconcile_pass'`).get() as { n: number };
    reconcileTerminationClassifications(db);
    const after = db.prepare(`SELECT COUNT(*) AS n FROM telemetry WHERE event_kind = 'reconcile_pass'`).get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
