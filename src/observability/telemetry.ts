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
 */
export function emitTelemetry(
  db: Database,
  sessionId: string,
  eventKind: EventKind,
  detail: TelemetryDetail,
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
 * Emits an injection telemetry event with standardized payload.
 * Shared by session-start and user-prompt-submit hooks.
 * Non-throwing.
 */
export function emitInjectionTelemetry(
  db: Database,
  sessionId: string,
  params: {
    trigger: 'session_start' | 'post_compaction' | 'topic_shift' | 'gauge';
    sectionsIncluded: string[];
    totalTokens: number;
    budgetTokens: number;
  }
): void {
  emitTelemetry(db, sessionId, 'injection', {
    trigger: params.trigger,
    sections_included: params.sectionsIncluded,
    sections_skipped: [],
    total_tokens: params.totalTokens,
    budget_remaining: params.budgetTokens - params.totalTokens,
  });
}

/**
 * Queries telemetry events with optional filters.
 * Returns results ordered by timestamp_epoch DESC.
 * Parses detail JSON back to typed objects.
 * If adapter is provided, scopes to that adapter; if omitted, returns all.
 */
export function queryTelemetry(
  db: Database,
  opts: { sessionId?: string; eventKind?: EventKind; adapter?: string; limit?: number }
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

/** Tool cost estimate entry. */
export interface ToolCostEstimate {
  tool: string;
  avgTokens: number;
}

/**
 * Queries recent telemetry for average token cost per tool category.
 * Returns top-N tool categories sorted by average cost descending.
 * Non-throwing — returns empty array on error.
 * @see Upgrade 11
 */
export function getToolCostEstimates(
  db: Database,
  opts?: { limit?: number; sessionId?: string }
): ToolCostEstimate[] {
  try {
    const limit = opts?.limit ?? 5;
    // Query observation_capture events which have tool + stored flag
    // We estimate cost from the detail JSON: tool field gives the tool name
    // We use a 24h window for recency
    const cutoff = Math.floor(Date.now() / 1000) - 86400;

    let query: string;
    const params: unknown[] = [];

    if (opts?.sessionId) {
      query = `
        SELECT
          json_extract(detail, '$.tool') AS tool,
          COUNT(*) AS call_count
        FROM telemetry
        WHERE event_kind = 'observation_capture'
          AND timestamp_epoch > ?
          AND session_id = ?
        GROUP BY tool
        HAVING tool IS NOT NULL
        ORDER BY call_count DESC
        LIMIT ?
      `;
      params.push(cutoff, opts.sessionId, limit);
    } else {
      query = `
        SELECT
          json_extract(detail, '$.tool') AS tool,
          COUNT(*) AS call_count
        FROM telemetry
        WHERE event_kind = 'observation_capture'
          AND timestamp_epoch > ?
        GROUP BY tool
        HAVING tool IS NOT NULL
        ORDER BY call_count DESC
        LIMIT ?
      `;
      params.push(cutoff, limit);
    }

    const rows = db.prepare(query).all(...params) as Array<{ tool: string; call_count: number }>;

    // Estimate average token cost per tool type based on known heuristics
    const toolCostMap: Record<string, number> = {
      Agent: 35000,
      'mcp__claude-teams__spawn_teammate': 35000,
      Read: 2000,
      Bash: 1500,
      Edit: 1000,
      Write: 1500,
      Grep: 800,
      Glob: 500,
      WebFetch: 5000,
      WebSearch: 3000,
      NotebookEdit: 2000,
    };

    return rows.map((r) => ({
      tool: r.tool,
      avgTokens: toolCostMap[r.tool] ?? 1000,
    }));
  } catch {
    return [];
  }
}
