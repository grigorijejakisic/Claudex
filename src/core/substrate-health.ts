/**
 * Substrate Health — read helpers for session-start's degraded-mode surface.
 *
 * Phase 13.1 Fix #5 (2026-05-15). The substrate has several long-lived
 * write paths whose silent failure can leave session-start's injection
 * stale or empty without operator-visible warning:
 *
 *   - Angel heartbeat tick: drives MEMORY.md regeneration, session_highlights
 *     extraction, sessions/ markdown indexer, pattern extraction, retention
 *     sweep. A hung tick (Phase 13.1 W2 root cause) is the upstream of most
 *     downstream staleness.
 *   - Session highlights extraction: produces the `## Recent Session Frames`
 *     section. When extraction lags, the frames the agent reads describe
 *     work that's no longer the active focus.
 *
 * Each reader returns the most recent epoch-ms timestamp for its signal, or
 * null when no write has happened yet (cold DB / brand-new project). All
 * readers are non-throwing — a substrate-health probe MUST NOT break the
 * hot session-start path. Threshold + formatting decisions live in
 * `src/assembly/sections.ts::formatSubstrateHealthSection`.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

/**
 * Return the epoch-ms of the most recent Angel heartbeat tick, or null if
 * the heartbeat has never written its environmental_event marker.
 *
 * Source: `episodic_events` rows with `source='angel/heartbeat'` and
 * `type='environmental_event'` written by `writeEnvironmentalEvent` at the
 * top of every `heartbeatTick` (heartbeat.ts L168-178). The tick_started
 * epoch-ms is embedded in `metadata_json.tick_started_epoch_ms`; we read
 * MAX of that value rather than `ts_epoch` so a clock skew on the DB host
 * vs Angel host can't ghost-revive a long-dead heartbeat.
 */
export function readLastHeartbeatTickEpochMs(db: Database): number | null {
  try {
    const row = cachedPrepare(
      db,
      `SELECT MAX(CAST(json_extract(metadata_json, '$.tick_started_epoch_ms') AS INTEGER)) AS last_tick
       FROM episodic_events
       WHERE source = 'angel/heartbeat'
         AND type = 'environmental_event'`,
    ).get() as { last_tick: number | null } | undefined;
    const v = row?.last_tick;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Return the epoch-ms of the most recent session_highlights extraction
 * for `project`, or null if none. Filters to non-degraded rows so a long
 * run of fallback-model extractions doesn't ghost-revive the freshness
 * signal — the operator wants to know when Opus-extraction last succeeded.
 */
export function readLastHighlightsEpochMs(db: Database, project: string): number | null {
  try {
    const row = cachedPrepare(
      db,
      `SELECT MAX(created_at_epoch_ms) AS last_ms
       FROM session_highlights
       WHERE project = ?
         AND degraded = 0`,
    ).get(project) as { last_ms: number | null } | undefined;
    const v = row?.last_ms;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    // Table may not exist on pre-V33 DBs.
    return null;
  }
}

export interface Phase2FailureSummary {
  /** Number of phase-2 failures in the window. */
  count: number;
  /** Distinct subsystems that failed (e.g. extract_directives, classify_domains). */
  subsystems: string[];
  /** Most recent failing short session_id (8 chars), or null. */
  latestSessionShort: string | null;
  /** True if at least one failure was a per-await timeout. */
  hadTimeout: boolean;
}

/**
 * Summarize recent Angel-heartbeat Phase 2 failures from the telemetry
 * table. Used by Substrate Health so the localization Phase 13.1 Fix #7
 * persists across sessions: the next operator session sees "phase 2
 * timed out on session ABC123 in extract_directives" instead of having
 * to read Angel logs by hand.
 *
 * Reads `telemetry` rows with `event_kind='error'` AND a `detail.subsystem`
 * matching the `heartbeat/phase2_*` prefix that the heartbeat catch blocks
 * write to. Window defaults to 24h. Non-throwing — telemetry table may
 * not have the row yet on a brand-new DB.
 */
export function readRecentPhase2Failures(
  db: Database,
  windowSeconds: number = 86_400,
): Phase2FailureSummary {
  const empty: Phase2FailureSummary = {
    count: 0,
    subsystems: [],
    latestSessionShort: null,
    hadTimeout: false,
  };
  try {
    const rows = cachedPrepare(
      db,
      `SELECT detail, timestamp_epoch
       FROM telemetry
       WHERE event_kind = 'error'
         AND json_extract(detail, '$.subsystem') LIKE 'heartbeat/phase2_%'
         AND timestamp_epoch >= unixepoch() - ?
       ORDER BY timestamp_epoch DESC`,
    ).all(windowSeconds) as Array<{ detail: string; timestamp_epoch: number }>;
    if (rows.length === 0) return empty;

    const subsystems = new Set<string>();
    let latestSessionShort: string | null = null;
    let hadTimeout = false;
    for (const r of rows) {
      try {
        const d = JSON.parse(r.detail) as {
          subsystem?: string;
          session_id_short?: string;
          reason?: string;
        };
        if (d.subsystem) {
          const tag = d.subsystem.replace(/^heartbeat\/phase2_/, '').replace(/_failed$/, '');
          subsystems.add(tag);
        }
        if (latestSessionShort === null && d.session_id_short) {
          latestSessionShort = d.session_id_short;
        }
        if (d.reason === 'timeout') hadTimeout = true;
      } catch { /* skip malformed rows */ }
    }

    return {
      count: rows.length,
      subsystems: [...subsystems].sort(),
      latestSessionShort,
      hadTimeout,
    };
  } catch {
    return empty;
  }
}
