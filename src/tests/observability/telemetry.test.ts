import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import {
  emitTelemetry,
  pruneTelemetry,
} from '../../observability/telemetry.js';
import type { HookInvocationDetail, ErrorDetail } from '../../observability/types.js';

describe('telemetry subsystem', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('emitTelemetry inserts event into telemetry table', () => {
    emitTelemetry(db, 'session-1', 'hook_invocation', {
      hook: 'PreToolUse',
      duration_ms: 42,
      result: 'inject',
    } as HookInvocationDetail);

    const rows = db
      .prepare('SELECT * FROM telemetry')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('session-1');
    expect(rows[0].event_kind).toBe('hook_invocation');
  });

  it('emitTelemetry stores JSON detail correctly', () => {
    const detail: HookInvocationDetail = {
      hook: 'PostToolUse',
      duration_ms: 100,
      result: 'skip',
    };
    emitTelemetry(db, 'session-1', 'hook_invocation', detail);

    const row = db
      .prepare('SELECT detail FROM telemetry')
      .get() as { detail: string };
    const parsed = JSON.parse(row.detail);
    expect(parsed.hook).toBe('PostToolUse');
    expect(parsed.duration_ms).toBe(100);
    expect(parsed.result).toBe('skip');
  });

  it('emitTelemetry records latency_ms', () => {
    emitTelemetry(
      db,
      'session-1',
      'hook_invocation',
      { hook: 'PreToolUse', duration_ms: 10, result: 'inject' } as HookInvocationDetail,
      55.5
    );

    const row = db
      .prepare('SELECT latency_ms FROM telemetry')
      .get() as { latency_ms: number };
    expect(row.latency_ms).toBeCloseTo(55.5);
  });

  it('emitTelemetry is non-throwing on error', () => {
    db.close();
    // Should not throw even though the db is closed
    expect(() => {
      emitTelemetry(db, 'session-1', 'hook_invocation', {
        hook: 'PreToolUse',
        duration_ms: 10,
        result: 'inject',
      } as HookInvocationDetail);
    }).not.toThrow();
  });

  it('pruneTelemetry removes rows older than retention period', () => {
    emitTelemetry(db, 'sess-1', 'hook_invocation', {
      hook: 'old',
      duration_ms: 10,
      result: 'inject',
    } as HookInvocationDetail);

    // Make the row 30 days old
    const oldEpoch = Math.floor(Date.now() / 1000) - 30 * 86400;
    db.prepare('UPDATE telemetry SET timestamp_epoch = ?').run(oldEpoch);

    // Insert a recent row
    emitTelemetry(db, 'sess-1', 'hook_invocation', {
      hook: 'recent',
      duration_ms: 20,
      result: 'skip',
    } as HookInvocationDetail);

    const pruned = pruneTelemetry(db);
    expect(pruned).toBe(1);

    const remaining = db
      .prepare('SELECT COUNT(*) as cnt FROM telemetry')
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it('pruneTelemetry preserves recent error events', () => {
    // Insert an old error event
    emitTelemetry(db, 'sess-1', 'error', {
      subsystem: 'injection',
      error: 'old error',
    } as ErrorDetail);

    const oldEpoch = Math.floor(Date.now() / 1000) - 30 * 86400;
    db.prepare('UPDATE telemetry SET timestamp_epoch = ? WHERE id = 1').run(oldEpoch);

    // Insert a recent non-error event
    emitTelemetry(db, 'sess-1', 'hook_invocation', {
      hook: 'recent',
      duration_ms: 10,
      result: 'inject',
    } as HookInvocationDetail);

    // Error events should not be pruned by the age-based rule
    // (only pruned when exceeding retain_error_count)
    const pruned = pruneTelemetry(db);
    expect(pruned).toBe(0);

    const remaining = db
      .prepare('SELECT COUNT(*) as cnt FROM telemetry')
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(2);
  });

  it('pruneTelemetry removes old errors beyond retain count', () => {
    // Insert 5 error events with old timestamps
    for (let i = 0; i < 5; i++) {
      emitTelemetry(db, 'sess-1', 'error', {
        subsystem: 'test',
        error: `error-${i}`,
      } as ErrorDetail);
    }

    // Set all to old timestamps (distinct for ordering)
    for (let i = 1; i <= 5; i++) {
      const ts = Math.floor(Date.now() / 1000) - (30 - i) * 86400;
      db.prepare('UPDATE telemetry SET timestamp_epoch = ? WHERE id = ?').run(ts, i);
    }

    // Prune with retain count of 3
    const pruned = pruneTelemetry(db, { retainErrorCount: 3 });
    expect(pruned).toBe(2);

    const remaining = db
      .prepare('SELECT COUNT(*) as cnt FROM telemetry WHERE event_kind = ?')
      .get('error') as { cnt: number };
    expect(remaining.cnt).toBe(3);
  });

  it('pruneTelemetry returns count of pruned rows', () => {
    // Insert 3 old non-error events
    for (let i = 0; i < 3; i++) {
      emitTelemetry(db, 'sess-1', 'hook_invocation', {
        hook: `hook-${i}`,
        duration_ms: i,
        result: 'inject',
      } as HookInvocationDetail);
    }

    const oldEpoch = Math.floor(Date.now() / 1000) - 30 * 86400;
    db.prepare('UPDATE telemetry SET timestamp_epoch = ?').run(oldEpoch);

    const pruned = pruneTelemetry(db);
    expect(pruned).toBe(3);
  });
});
