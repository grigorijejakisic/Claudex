/**
 * Telemetry subsystem — emit, query, and prune structured observability events.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 10c (Telemetry table, event detail schemas, retention rules)
 */

import type { Database } from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import type { EventKind, EventKindDetailMap } from './types.js';

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
