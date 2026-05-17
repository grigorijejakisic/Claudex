/**
 * Session Signals — stigmergic coordination between sessions.
 *
 * Sessions coordinate by modifying the shared environment (signals with temporal decay),
 * not by direct messaging. Other sessions sense these signals via assembly injection.
 *
 * Signal types:
 *   wip       — "I'm working on file X" (territory pheromone, 30 min decay)
 *   failure   — "Approach Y failed for reason Z" (alarm, 24h decay)
 *   danger    — "File X is fragile" (persists until manually cleared)
 *   claim     — "I claimed task T" (cleared when task completes or session ends)
 *   discovery — "Found that X is true about Y" (7 day decay)
 *
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export type SignalType = 'wip' | 'failure' | 'danger' | 'claim' | 'discovery';

export interface SessionSignal {
  id: number;
  session_id: string;
  project: string;
  signal_type: SignalType;
  target: string;
  detail: string | null;
  created_at_epoch_ms: number;
  expires_at_epoch_ms: number | null;
  cleared_at_epoch_ms: number | null;
}

/** Default TTL in seconds per signal type. */
const SIGNAL_TTL: Record<SignalType, number | null> = {
  wip: 30 * 60,          // 30 minutes
  failure: 24 * 3600,    // 24 hours
  danger: null,           // manual clear only
  claim: 2 * 3600,       // 2 hours (auto-expire if session dies)
  discovery: 7 * 86400,  // 7 days
};

/**
 * Create a signal in the shared environment.
 */
export function createSignal(
  db: Database,
  sessionId: string,
  project: string,
  signalType: SignalType,
  target: string,
  detail?: string,
): number {
  try {
    const nowMs = Date.now();
    const ttl = SIGNAL_TTL[signalType];
    const expires = ttl ? nowMs + ttl * 1000 : null;

    const result = cachedPrepare(db,
      `INSERT INTO session_signals (session_id, project, signal_type, target, detail, created_at_epoch_ms, expires_at_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, project, signalType, target, detail ?? null, nowMs, expires);

    return Number(result.lastInsertRowid);
  } catch {
    return 0;
  }
}

/**
 * Clear a specific signal (mark as cleared, not deleted).
 */
export function clearSignal(db: Database, signalId: number): void {
  try {
    cachedPrepare(db,
      `UPDATE session_signals SET cleared_at_epoch_ms = (unixepoch() * 1000) WHERE id = ?`
    ).run(signalId);
  } catch { /* non-throwing */ }
}

/**
 * Clear all signals of a type for a session (e.g., clear all wip on session end).
 */
export function clearSessionSignals(
  db: Database,
  sessionId: string,
  signalType?: SignalType,
): void {
  try {
    if (signalType) {
      cachedPrepare(db,
        `UPDATE session_signals SET cleared_at_epoch_ms = (unixepoch() * 1000)
         WHERE session_id = ? AND signal_type = ? AND cleared_at_epoch_ms IS NULL`
      ).run(sessionId, signalType);
    } else {
      cachedPrepare(db,
        `UPDATE session_signals SET cleared_at_epoch_ms = (unixepoch() * 1000)
         WHERE session_id = ? AND cleared_at_epoch_ms IS NULL`
      ).run(sessionId);
    }
  } catch { /* non-throwing */ }
}

/**
 * Get active signals for a project. Filters out expired and cleared signals.
 * Used by assembly to inject cross-session awareness.
 */
export function getActiveSignals(
  db: Database,
  project: string,
  excludeSessionId?: string,
): SessionSignal[] {
  try {
    const nowMs = Date.now();
    const query = excludeSessionId
      ? `SELECT * FROM session_signals
         WHERE project = ? AND cleared_at_epoch_ms IS NULL
           AND (expires_at_epoch_ms IS NULL OR expires_at_epoch_ms > ?)
           AND session_id != ?
         ORDER BY created_at_epoch_ms DESC LIMIT 20`
      : `SELECT * FROM session_signals
         WHERE project = ? AND cleared_at_epoch_ms IS NULL
           AND (expires_at_epoch_ms IS NULL OR expires_at_epoch_ms > ?)
         ORDER BY created_at_epoch_ms DESC LIMIT 20`;

    const params = excludeSessionId
      ? [project, nowMs, excludeSessionId]
      : [project, nowMs];

    return cachedPrepare(db, query).all(...params) as SessionSignal[];
  } catch {
    return [];
  }
}

/**
 * Sweep expired signals. Called by Angel heartbeat or session-end.
 */
export function sweepExpiredSignals(db: Database): number {
  try {
    const nowMs = Date.now();
    const result = cachedPrepare(db,
      `UPDATE session_signals SET cleared_at_epoch_ms = ?
       WHERE cleared_at_epoch_ms IS NULL AND expires_at_epoch_ms IS NOT NULL AND expires_at_epoch_ms <= ?`
    ).run(nowMs, nowMs);
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Format active signals for assembly injection.
 */
export function formatSignalsForInjection(signals: SessionSignal[]): string {
  if (signals.length === 0) return '';

  const nowMs = Date.now();
  const lines = signals.map(s => {
    // Belt-and-suspenders: if a legacy row stored seconds in the _ms column
    // (V35 DEFAULT-slip survivor pre-V40 migration), scale up before
    // computing age. 1e11 ms = 1973-03-05; anything below predates the
    // installation by decades and is unambiguously seconds.
    const createdMs = s.created_at_epoch_ms > 0 && s.created_at_epoch_ms < 100000000000
      ? s.created_at_epoch_ms * 1000
      : s.created_at_epoch_ms;
    const ageSec = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
    const ageStr = ageSec < 60 ? `${ageSec}s ago`
      : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago`
      : `${Math.round(ageSec / 3600)}h ago`;
    const detail = s.detail ? ` — ${s.detail}` : '';
    return `- [${s.signal_type}] ${s.target}${detail} (${ageStr})`;
  });

  return `## Active Signals\n${lines.join('\n')}`;
}
