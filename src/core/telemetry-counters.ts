/**
 * Telemetry counter helpers (Phase 6 P5 — RETR-08).
 *
 * The `telemetry` table is the audit trail for runtime behavior that is not
 * visible in artifact / session state — including degraded-mode events like
 * cross-encoder→bi-encoder reranker fallbacks.
 *
 * Every counter helper is non-throwing. A telemetry write failing must
 * never break a hot retrieval path; the cost of a missed event is much
 * lower than the cost of a hook failure.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

/**
 * Reasons the cross-encoder reranker (BGE-v2-m3 on port 7439) can fail,
 * forcing a fallback to the bi-encoder (snowflake-arctic-embed2 cosine
 * via Ollama on port 11434).
 *
 * - `unreachable`     — fetch threw before getting a response (ECONNREFUSED, DNS, etc.).
 * - `non_2xx`         — service responded with HTTP 4xx/5xx.
 * - `timeout`         — request exceeded the 3s budget.
 * - `empty_response`  — service returned 2xx but with empty/invalid scores.
 */
export type RerankerFallbackReason =
  | 'unreachable'
  | 'non_2xx'
  | 'timeout'
  | 'empty_response';

/**
 * Record a single reranker-fallback event in the `telemetry` table.
 *
 * Writes one row with `event_kind='reranker_fallback'` and a JSON `detail`
 * carrying the fallback reason. Non-throwing — DB errors are swallowed so
 * a telemetry write failure never breaks the hot retrieval path.
 *
 * Phase 6 P5 (V20 migration) added 'reranker_fallback' to the telemetry
 * event_kind CHECK enum. Calling this on a pre-V20 DB will silently fail
 * (the swallowed CHECK violation), which is the correct behavior — older
 * DBs simply don't record this signal.
 */
export function incrementRerankerFallbackCounter(
  db: Database,
  sessionId: string,
  reason: RerankerFallbackReason,
): void {
  try {
    cachedPrepare(
      db,
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, 'reranker_fallback', ?, 'hybrid-retrieval')`,
    ).run(sessionId, JSON.stringify({ reason }));
  } catch {
    // Non-throwing: telemetry must never break a retrieval path.
  }
}

/**
 * Read the count of `reranker_fallback` events in the recent past.
 *
 * Default window is 24h (86400s), tuned for the session-start observational
 * line "fell back N times in the last 24h". Non-throwing — returns 0 on any
 * DB error so the assembler section can degrade silently.
 */
export function readRerankerFallbackCount(
  db: Database,
  windowSeconds: number = 86400,
): number {
  try {
    const row = cachedPrepare(
      db,
      `SELECT COUNT(*) AS n FROM telemetry
       WHERE event_kind = 'reranker_fallback'
         AND timestamp_epoch_ms >= (unixepoch() - ?) * 1000`,
    ).get(windowSeconds) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
