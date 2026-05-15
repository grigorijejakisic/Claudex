/**
 * Telemetry subsystem — emit, query, and prune structured observability events.
 * Plain functions with `db: Database` as first param.
 */

import type { Database } from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../shared/constants.js';
import type { EventKind, EventKindDetailMap, SessionEndActionDetail } from './types.js';

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

 */
export function pruneTelemetry(
  db: Database,
  opts?: { retentionDays?: number; retainErrorCount?: number }
): number {
  try {
    const retentionDays =
      opts?.retentionDays ?? DEFAULT_CONFIG.observability.retention_days;
    const retainErrorCount =
      opts?.retainErrorCount ?? DEFAULT_CONFIG.observability.retain_error_count;

    const cutoffMs = Date.now() - retentionDays * 86400000;
    let totalPruned = 0;

    // 1. Delete non-error rows older than retention period
    const ageResult = db
      .prepare(
        `DELETE FROM telemetry
         WHERE timestamp_epoch_ms < ? AND event_kind != 'error'`
      )
      .run(cutoffMs);
    totalPruned += ageResult.changes;

    // 2. Delete error events beyond retain count (keep most recent N)
    const errorResult = db
      .prepare(
        `DELETE FROM telemetry
         WHERE event_kind = 'error'
           AND id NOT IN (
             SELECT id FROM telemetry
             WHERE event_kind = 'error'
             ORDER BY timestamp_epoch_ms DESC
             LIMIT ?
           )`
      )
      .run(retainErrorCount);
    totalPruned += errorResult.changes;

    return totalPruned;
  } catch {
    // Non-throwing — consistent with all other functions in this module
    return 0;
  }
}

/**
 * Sanitize error messages before persisting to telemetry.
 * Truncates to 200 chars and redacts file paths to prevent sensitive content leakage.
 */
export function sanitizeErrorForTelemetry(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .slice(0, 500)
    // Redact Windows absolute paths (C:\Users\..., D:\...)
    .replace(/[A-Za-z]:\\[^\s"',;)}\]]+/g, '[path]')
    // Redact Unix absolute paths (/home/..., /tmp/...)
    .replace(/\/(?:home|tmp|usr|var|etc)\/[^\s"',;)}\]]+/g, '[path]');
}

/**
 * Records a single session_end_action telemetry row.
 *
 * Non-throwing — entire function wrapped in try/catch.
 * Pre-V36 DBs silently swallow the INSERT (CHECK constraint mismatch caught).
 * This matches the additive pattern used by handoff_parse_failed (Plan 14-01)
 * and frame_extraction_fallback (Plan 13 P3).
 */
export function recordSessionEndAction(
  db: Database,
  params: SessionEndActionDetail & { adapter?: string },
): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, 'session_end_action', ?, ?)`
    ).run(
      params.session_id,
      JSON.stringify({
        action: params.action,
        outcome: params.outcome,
        duration_ms: params.duration_ms,
        reason: params.reason ?? null,
        error_message: params.error_message ?? null,
        skip_reason: params.skip_reason ?? null,
      }),
      params.adapter ?? 'angel-boundary',
    );
  } catch {
    // Intentionally swallowed — pre-V36 DBs will reject the CHECK constraint.
    // Non-throwing per spec.
  }
}

/** Tool cost estimate entry. */
export interface ToolCostEstimate {
  tool: string;
  avgTokens: number;
}
