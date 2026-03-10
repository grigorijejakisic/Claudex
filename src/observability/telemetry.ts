/**
 * Telemetry subsystem — emit, query, and prune structured observability events.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 10c (Telemetry table, event detail schemas, retention rules)
 */

import type { Database } from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import type { EventKind, TelemetryDetail } from './types.js';

/** Row shape returned from telemetry queries. */
export interface TelemetryRow {
  id: number;
  session_id: string;
  event_kind: EventKind;
  detail: TelemetryDetail;
  latency_ms: number | null;
  timestamp_epoch: number;
}

/** Raw row from SQLite (detail is still a JSON string). */
interface TelemetryRawRow {
  id: number;
  session_id: string;
  event_kind: string;
  detail: string;
  latency_ms: number | null;
  timestamp_epoch: number;
}

/**
 * Emits a telemetry event. Non-throwing — entire function wrapped in try/catch.
 * Fast INSERT in WAL mode.
 */
export function emitTelemetry(
  db: Database,
  sessionId: string,
  eventKind: EventKind,
  detail: TelemetryDetail,
  latencyMs?: number
): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms)
       VALUES (?, ?, ?, ?)`
    ).run(sessionId, eventKind, JSON.stringify(detail), latencyMs ?? null);
  } catch {
    // Intentionally swallowed — non-throwing per spec
  }
}

/**
 * Queries telemetry events with optional filters.
 * Returns results ordered by timestamp_epoch DESC.
 * Parses detail JSON back to typed objects.
 */
export function queryTelemetry(
  db: Database,
  opts: { sessionId?: string; eventKind?: EventKind; limit?: number }
): TelemetryRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.sessionId) {
    conditions.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.eventKind) {
    conditions.push('event_kind = ?');
    params.push(opts.eventKind);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 1000;

  const rows = db
    .prepare(
      `SELECT * FROM telemetry ${whereClause}
       ORDER BY timestamp_epoch DESC
       LIMIT ?`
    )
    .all(...params, limit) as TelemetryRawRow[];

  return rows.map((row) => ({
    ...row,
    event_kind: row.event_kind as EventKind,
    detail: JSON.parse(row.detail) as TelemetryDetail,
  }));
}

/**
 * Prunes telemetry events per retention policy.
 * 1. Deletes non-error rows older than retentionDays (default 7).
 * 2. Deletes error rows beyond retainErrorCount (default 1000).
 * Returns total number of rows pruned.
 *
 * @see Architecture Section 10c retention rules
 */
export function pruneTelemetry(
  db: Database,
  opts?: { retentionDays?: number; retainErrorCount?: number }
): number {
  const retentionDays =
    opts?.retentionDays ?? DEFAULT_CONFIG.observability.retention_days;
  const retainErrorCount =
    opts?.retainErrorCount ?? DEFAULT_CONFIG.observability.retain_error_count;

  const cutoffEpoch = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  let totalPruned = 0;

  // 1. Delete non-error rows older than retention period
  const ageResult = db
    .prepare(
      `DELETE FROM telemetry
       WHERE timestamp_epoch < ? AND event_kind != 'error'`
    )
    .run(cutoffEpoch);
  totalPruned += ageResult.changes;

  // 2. Delete error events beyond retain count (keep most recent N)
  const errorResult = db
    .prepare(
      `DELETE FROM telemetry
       WHERE event_kind = 'error'
         AND id NOT IN (
           SELECT id FROM telemetry
           WHERE event_kind = 'error'
           ORDER BY timestamp_epoch DESC
           LIMIT ?
         )`
    )
    .run(retainErrorCount);
  totalPruned += errorResult.changes;

  return totalPruned;
}
