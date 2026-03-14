/**
 * Tests for multi-adapter isolation — adapter column on sessions and telemetry.
 */

import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  createSession,
} from '../../core/sessions.js';
import {
  emitTelemetry,
} from '../../observability/telemetry.js';
import { initializeSchema } from '../../core/migrations.js';
import type { HookInvocationDetail } from '../../observability/types.js';

describe('adapter isolation — sessions', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('createSession stores adapter field', () => {
    createSession(db, {
      session_id: 's1',
      project: 'proj',
      adapter: 'cc-hooks',
    });

    const row = db
      .prepare('SELECT adapter FROM sessions WHERE session_id = ?')
      .get('s1') as { adapter: string };
    expect(row.adapter).toBe('cc-hooks');
  });

  it('createSession defaults adapter to unknown when not provided', () => {
    createSession(db, {
      session_id: 's2',
      project: 'proj',
    });

    const row = db
      .prepare('SELECT adapter FROM sessions WHERE session_id = ?')
      .get('s2') as { adapter: string };
    expect(row.adapter).toBe('unknown');
  });

  it('session row includes adapter field', () => {
    createSession(db, {
      session_id: 's3',
      project: 'proj',
      adapter: 'openclaw',
    });

    const session = db.prepare('SELECT adapter FROM sessions WHERE session_id = ?').get('s3') as { adapter: string } | undefined;
    expect(session).toBeDefined();
    expect(session!.adapter).toBe('openclaw');
  });
});

describe('adapter isolation — telemetry', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('emitTelemetry stores adapter field', () => {
    emitTelemetry(db, 'sess-1', 'hook_invocation', {
      hook: 'SessionStart',
      duration_ms: 42,
      result: 'inject',
    } as HookInvocationDetail, 42, 'cc-hooks');

    const row = db
      .prepare('SELECT adapter FROM telemetry WHERE session_id = ?')
      .get('sess-1') as { adapter: string };
    expect(row.adapter).toBe('cc-hooks');
  });

  it('emitTelemetry defaults adapter to unknown when not provided', () => {
    emitTelemetry(db, 'sess-2', 'hook_invocation', {
      hook: 'SessionStart',
      duration_ms: 10,
      result: 'skip',
    } as HookInvocationDetail);

    const row = db
      .prepare('SELECT adapter FROM telemetry WHERE session_id = ?')
      .get('sess-2') as { adapter: string };
    expect(row.adapter).toBe('unknown');
  });

  it('telemetry filters by adapter via direct SQL', () => {
    emitTelemetry(db, 'sess-1', 'hook_invocation', {
      hook: 'SessionStart',
      duration_ms: 10,
      result: 'inject',
    } as HookInvocationDetail, 10, 'cc-hooks');

    emitTelemetry(db, 'sess-2', 'hook_invocation', {
      hook: 'onInit',
      duration_ms: 20,
      result: 'inject',
    } as HookInvocationDetail, 20, 'openclaw');

    const ccResults = db.prepare('SELECT * FROM telemetry WHERE adapter = ?').all('cc-hooks') as Array<Record<string, unknown>>;
    expect(ccResults).toHaveLength(1);
    expect(ccResults[0].adapter).toBe('cc-hooks');

    const ocResults = db.prepare('SELECT * FROM telemetry WHERE adapter = ?').all('openclaw') as Array<Record<string, unknown>>;
    expect(ocResults).toHaveLength(1);
    expect(ocResults[0].adapter).toBe('openclaw');

    const allResults = db.prepare('SELECT * FROM telemetry').all() as Array<Record<string, unknown>>;
    expect(allResults).toHaveLength(2);
  });

  it('telemetry combines adapter with other filters via direct SQL', () => {
    emitTelemetry(db, 'sess-1', 'hook_invocation', {
      hook: 'SessionStart',
      duration_ms: 10,
      result: 'inject',
    } as HookInvocationDetail, 10, 'cc-hooks');

    emitTelemetry(db, 'sess-1', 'error', {
      subsystem: 'injection',
      error: 'test error',
    }, undefined, 'cc-hooks');

    emitTelemetry(db, 'sess-2', 'error', {
      subsystem: 'bridge',
      error: 'bridge error',
    }, undefined, 'openclaw');

    const ccErrors = db.prepare('SELECT * FROM telemetry WHERE adapter = ? AND event_kind = ?').all('cc-hooks', 'error') as Array<Record<string, unknown>>;
    expect(ccErrors).toHaveLength(1);
    expect(ccErrors[0].session_id).toBe('sess-1');
  });
});

describe('adapter isolation — schema migration idempotency', () => {
  it('addAdapterColumns is idempotent (initializeSchema can be called twice)', () => {
    const db = createTestDb();

    // Second initializeSchema call should not throw
    expect(() => initializeSchema(db)).not.toThrow();

    // Adapter column should still work
    createSession(db, { session_id: 's1', adapter: 'cc-hooks' });
    const row = db
      .prepare('SELECT adapter FROM sessions WHERE session_id = ?')
      .get('s1') as { adapter: string };
    expect(row.adapter).toBe('cc-hooks');

    db.close();
  });
});
