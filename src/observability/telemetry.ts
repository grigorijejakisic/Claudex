/**
 * Telemetry subsystem — emit, query, and prune structured observability events.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 10c (Telemetry table, event detail schemas, retention rules)
 */

import type { Database } from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import type { EventKind, EventKindDetailMap, TelemetryDetail } from './types.js';

/** Row shape returned from telemetry queries. */
export interface TelemetryRow {
  id: number;
  session_id: string;
  event_kind: EventKind;
  detail: TelemetryDetail;
  latency_ms: number | null;
  adapter: string;
  timestamp_epoch: number;
}

/** Raw row from SQLite (detail is still a JSON string). */
interface TelemetryRawRow {
  id: number;
  session_id: string;
  event_kind: string;
  detail: string;
  latency_ms: number | null;
  adapter: string;
  timestamp_epoch: number;
}

/**
 * Emits a telemetry event. Non-throwing — entire function wrapped in try/catch.
 * Fast INSERT in WAL mode.
 * Generic constraint ensures the detail type matches the event kind
 * via EventKindDetailMap.
 */
export function emitTelemetry<K extends EventKind>(
  db: Database,
  sessionId: string,
  eventKind: K,
  detail: EventKindDetailMap[K],
  latencyMs?: number,
  adapter?: string
): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
       VALUES (?, ?, ?, ?, ?)`
    ).run(sessionId, eventKind, JSON.stringify(detail), latencyMs ?? null, adapter ?? 'unknown');
  } catch {
    // Intentionally swallowed — non-throwing per spec
  }
}

/**
 * Queries telemetry events with optional filters.
 * Returns results ordered by timestamp_epoch DESC.
 * Parses detail JSON back to typed objects.
 * If adapter is provided, scopes to that adapter; if omitted, returns all.
 * Non-throwing — returns empty array on error. Per-row JSON.parse failures
 * are silently skipped.
 */
export function queryTelemetry(
  db: Database,
  opts: { sessionId?: string; eventKind?: EventKind; adapter?: string; limit?: number }
): TelemetryRow[] {
  try {
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
    if (opts.adapter) {
      conditions.push('adapter = ?');
      params.push(opts.adapter);
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

    const results: TelemetryRow[] = [];
    for (const row of rows) {
      try {
        results.push({
          ...row,
          event_kind: row.event_kind as EventKind,
          detail: JSON.parse(row.detail) as TelemetryDetail,
        });
      } catch {
        // Skip rows with unparseable detail JSON
      }
    }
    return results;
  } catch {
    return [];
  }
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

/** Tool cost estimate entry. */
export interface ToolCostEstimate {
  tool: string;
  avgTokens: number;
}
