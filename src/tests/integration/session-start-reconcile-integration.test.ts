/**
 * Integration test: session-start hook actually calls
 * reconcileTerminationClassifications when it fires.
 *
 * Prevents the silent regression where the function still passes unit tests
 * but the wire-up to session-start has been removed by an unrelated edit.
 * The reconciliation mechanism is only valuable if it runs continuously;
 * this test asserts the continuity.
 */

import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import {
  recordSessionTermination,
  reconcileTerminationClassifications,
} from '../../core/session-termination.js';
import fs from 'node:fs';
import path from 'node:path';

describe('session-start integration: reconcileTerminationClassifications wired in', () => {
  it('the session-start hook source imports and calls reconcileTerminationClassifications', () => {
    // Source-level assertion: prevents accidental removal of the call site.
    // If a refactor decouples the function from session-start, the unit
    // tests still pass but production stops reconciling. This test catches
    // that exact regression.
    const sessionStartSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'adapters', 'cc-hooks', 'session-start.ts'),
      'utf-8',
    );
    expect(sessionStartSrc).toMatch(/import\s*{[^}]*reconcileTerminationClassifications[^}]*}\s*from/);
    expect(sessionStartSrc).toMatch(/reconcileTerminationClassifications\s*\(/);
  });

  it('end-to-end: seeded unknown + recovery framing gets promoted by the function the hook calls', () => {
    const db = createTestDb();
    const project = 'claudex-v3';
    const nowMs = Date.now();

    // Seed a "crashed" session with no termination row, then a "recovery"
    // session whose first user_framing matches the crash regex.
    createSession(db, {
      session_id: 'integ-crashed',
      project,
      cwd: 'C:/test',
      source: 'test',
    });
    db.prepare(
      `UPDATE sessions SET status = 'completed', ended_at_epoch_ms = ? WHERE session_id = ?`,
    ).run(nowMs - 3600_000, 'integ-crashed');

    createSession(db, {
      session_id: 'integ-recovery',
      project,
      cwd: 'C:/test',
      source: 'test',
    });
    db.prepare(
      `UPDATE sessions SET status = 'completed', created_at_epoch_ms = ? WHERE session_id = ?`,
    ).run(nowMs - 1800_000, 'integ-recovery');

    const cols = db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>;
    const hasMs = cols.some(c => c.name === 'timestamp_epoch_ms');
    const tsCol = hasMs ? 'timestamp_epoch_ms' : 'timestamp_epoch';
    const tsVal = hasMs ? (nowMs - 1800_000) : Math.floor((nowMs - 1800_000) / 1000);
    db.prepare(
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, ${tsCol})
       VALUES ('integ-recovery', ?, 'user_framing', 'prompt', 'framed', ?, ?)`,
    ).run(project, 'PC crashed last night, please recover', tsVal);

    recordSessionTermination(db, {
      session_id: 'integ-crashed',
      project,
      end_reason: 'unknown',
      ended_at_epoch_ms: nowMs - 3600_000,
    });

    // This is the call the session-start hook makes.
    const result = reconcileTerminationClassifications(db);
    expect(result.promoted).toBe(1);
    expect(result.by_classifier['crash-from-recovery-framing']).toBe(1);

    const row = db.prepare(
      `SELECT end_reason FROM session_termination WHERE session_id = 'integ-crashed'`,
    ).get() as { end_reason: string };
    expect(row.end_reason).toBe('crash');

    db.close();
  });
});
