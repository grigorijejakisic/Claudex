import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSignal, clearSignal, clearSessionSignals, getActiveSignals, sweepExpiredSignals, formatSignalsForInjection } from '../../core/session-signals.js';

describe('session-signals', () => {
  let db: TestDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates a signal and retrieves it', () => {
    const id = createSignal(db, 'sess-1', 'proj-1', 'wip', 'src/foo.ts', 'editing');
    expect(id).toBeGreaterThan(0);

    const signals = getActiveSignals(db, 'proj-1');
    expect(signals.length).toBe(1);
    expect(signals[0].signal_type).toBe('wip');
    expect(signals[0].target).toBe('src/foo.ts');
    expect(signals[0].detail).toBe('editing');
  });

  it('clears a specific signal by ID', () => {
    const id = createSignal(db, 'sess-1', 'proj-1', 'danger', 'schema.ts');
    clearSignal(db, id);

    const signals = getActiveSignals(db, 'proj-1');
    expect(signals.length).toBe(0);
  });

  it('clears all signals for a session', () => {
    createSignal(db, 'sess-1', 'proj-1', 'wip', 'a.ts');
    createSignal(db, 'sess-1', 'proj-1', 'claim', 'task-1');
    createSignal(db, 'sess-2', 'proj-1', 'wip', 'b.ts');

    clearSessionSignals(db, 'sess-1');

    const signals = getActiveSignals(db, 'proj-1');
    expect(signals.length).toBe(1);
    expect(signals[0].session_id).toBe('sess-2');
  });

  it('clears signals by type for a session', () => {
    createSignal(db, 'sess-1', 'proj-1', 'wip', 'a.ts');
    createSignal(db, 'sess-1', 'proj-1', 'danger', 'b.ts');

    clearSessionSignals(db, 'sess-1', 'wip');

    const signals = getActiveSignals(db, 'proj-1');
    expect(signals.length).toBe(1);
    expect(signals[0].signal_type).toBe('danger');
  });

  it('excludes signals from the requesting session', () => {
    createSignal(db, 'sess-1', 'proj-1', 'wip', 'a.ts');
    createSignal(db, 'sess-2', 'proj-1', 'wip', 'b.ts');

    const signals = getActiveSignals(db, 'proj-1', 'sess-1');
    expect(signals.length).toBe(1);
    expect(signals[0].session_id).toBe('sess-2');
  });

  it('sweeps expired signals', () => {
    // Create a signal with past expiration
    db.prepare(
      `INSERT INTO session_signals (session_id, project, signal_type, target, expires_at_epoch_ms)
       VALUES ('s1', 'p1', 'wip', 'x.ts', ?)`
    ).run(Date.now() - 100000);

    createSignal(db, 's2', 'p1', 'danger', 'y.ts'); // no expiry

    const swept = sweepExpiredSignals(db);
    expect(swept).toBe(1);

    const signals = getActiveSignals(db, 'p1');
    expect(signals.length).toBe(1);
    expect(signals[0].signal_type).toBe('danger');
  });

  it('formats signals for injection', () => {
    createSignal(db, 's1', 'p1', 'wip', 'src/foo.ts', 'editing');
    createSignal(db, 's2', 'p1', 'failure', 'auth approach', 'threw 401');

    const signals = getActiveSignals(db, 'p1');
    const formatted = formatSignalsForInjection(signals);

    expect(formatted).toContain('## Active Signals');
    expect(formatted).toContain('[wip]');
    expect(formatted).toContain('[failure]');
    expect(formatted).toContain('src/foo.ts');
  });

  it('returns empty string for no signals', () => {
    expect(formatSignalsForInjection([])).toBe('');
  });
});
