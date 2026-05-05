/**
 * Phase 6 EBD-03 — composition rule for episode boundary detection.
 *
 * Pure function. No DB, no I/O. Mirrors the formal aliveness predicate
 * from 06-CONTEXT.md verbatim so future readers can compare line-for-line:
 *
 *   ALIVE      <=>  pid_alive
 *                 ∧ (now - last_jsonl_write_ts < T_jsonl)
 *                 ∧ (now - last_heartbeat_ts < T_heartbeat
 *                    OR now - last_jsonl_write_ts < T_jsonl_short)
 *
 *   DORMANT    <=>  ¬ALIVE
 *                 ∧ (now - last_jsonl_write_ts < T_jsonl + T_grace)
 *
 *   TERMINATED <=>  ¬ALIVE
 *                 ∧ (jsonl_idle_full ∨ clean_endsession ∨ pid_dead_corroborated)
 *
 * Stale heartbeat ALONE never closes a session — that's the JSONL-trumps-heartbeat
 * invariant from CONTEXT decision item 5. The aliveClause requires JSONL fresh
 * (jsonlFreshFull) regardless; pid_dead branches only fire when JSONL has gone
 * silent too.
 */

import type { BoundaryThresholds } from './thresholds.js';

export interface SessionLivenessRow {
  session_id: string;
  project: string;
  /** Resolved by caller (boundary-detector.ts) before invocation. */
  pid: number | null;
  /** Caller pre-computes via isPidAlive(). */
  pid_alive: boolean;
  last_heartbeat_ts: number | null;
  last_jsonl_write_ts: number | null;
  /** Caller pre-computes by reading cursor.last_close_event_id metadata. */
  has_clean_endsession: boolean;
}

export type CloseReason = 'clean_endsession' | 'idle_timeout' | 'jsonl_silent' | 'pid_dead';

export type Classification =
  | { state: 'alive' }
  | { state: 'dormant' }
  | { state: 'terminated'; close_reason: CloseReason };

export function classifySession(
  now: number,
  row: SessionLivenessRow,
  t: BoundaryThresholds,
): Classification {
  if (row.has_clean_endsession) {
    return { state: 'terminated', close_reason: 'clean_endsession' };
  }

  const jsonlAge = row.last_jsonl_write_ts !== null
    ? now - row.last_jsonl_write_ts
    : Infinity;
  const heartbeatAge = row.last_heartbeat_ts !== null
    ? now - row.last_heartbeat_ts
    : Infinity;

  const jsonlFreshFull  = jsonlAge < t.tJsonl;
  const heartbeatFresh  = heartbeatAge < t.tHeartbeat;
  const jsonlFreshShort = jsonlAge < t.tJsonlShort;
  const aliveClause     = row.pid_alive && jsonlFreshFull && (heartbeatFresh || jsonlFreshShort);

  if (aliveClause) return { state: 'alive' };

  const jsonlIdleFull       = jsonlAge >= (t.tJsonl + t.tGrace);
  const pidDeadCorroborated = !row.pid_alive
    && heartbeatAge >= t.tHeartbeat
    && jsonlAge     >= t.tJsonlShort;

  if (jsonlIdleFull) {
    return { state: 'terminated', close_reason: 'idle_timeout' };
  }
  if (pidDeadCorroborated) {
    if (jsonlAge >= t.tJsonl) {
      return { state: 'terminated', close_reason: 'jsonl_silent' };
    }
    return { state: 'terminated', close_reason: 'pid_dead' };
  }

  return { state: 'dormant' };
}
