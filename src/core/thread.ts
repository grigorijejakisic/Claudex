/**
 * Thread state CRUD — topic, summary, and key_exchanges tracking.
 * Plain functions with `db: Database` as first param.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import type { CooldownState } from '../intelligence/topic-shift.js';

export interface ThreadStateRow {
  session_id: string;
  topic: string | null;
  summary: string | null;
  key_exchanges: Array<{ role: string; gist: string }>;
  updated_at_epoch_ms: number;
}

interface RawThreadStateRow {
  session_id: string;
  topic: string | null;
  summary: string | null;
  key_exchanges: string;
  updated_at_epoch_ms: number;
}

/**
 * Creates or merges thread state for a session.
 * Uses ON CONFLICT with COALESCE so omitted optional fields preserve
 * existing values instead of being silently cleared.
 * JSON.stringifies key_exchanges for storage.
 */
export function upsertThreadState(
  db: Database,
  state: {
    session_id: string;
    topic?: string;
    summary?: string;
    key_exchanges?: Array<{ role: string; gist: string }>;
  }
): void {
  cachedPrepare(db,
    `INSERT INTO thread_state (session_id, topic, summary, key_exchanges, updated_at_epoch)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(session_id) DO UPDATE SET
       topic = COALESCE(excluded.topic, thread_state.topic),
       summary = COALESCE(excluded.summary, thread_state.summary),
       key_exchanges = CASE
         WHEN excluded.key_exchanges = '[]' THEN thread_state.key_exchanges
         ELSE excluded.key_exchanges
       END,
       updated_at_epoch = unixepoch()`
  ).run(
    state.session_id,
    state.topic ?? null,
    state.summary ?? null,
    JSON.stringify(state.key_exchanges ?? [])
  );
}

/**
 * Retrieves thread state for a session, parsing key_exchanges JSON.
 */
export function getThreadState(
  db: Database,
  sessionId: string
): ThreadStateRow | undefined {
  const row = cachedPrepare(db, 'SELECT * FROM thread_state WHERE session_id = ?')
    .get(sessionId) as RawThreadStateRow | undefined;

  if (!row) return undefined;

  let parsed: Array<{ role: string; gist: string }> = [];
  try {
    parsed = JSON.parse(row.key_exchanges);
  } catch {
    // Corrupted JSON — fallback to empty exchanges
  }

  return {
    ...row,
    key_exchanges: parsed,
  };
}

// ---------------------------------------------------------------------------
// Topic shift cooldown state — piggybacked on key_exchanges JSON
// Uses a reserved entry with role '__cooldown' to avoid schema changes.
// ---------------------------------------------------------------------------

export type { CooldownState } from '../intelligence/topic-shift.js';

const COOLDOWN_ROLE = '__cooldown';

/**
 * Reads cooldown state from thread_state key_exchanges.
 * Returns null if no cooldown state found. Non-throwing.
 */
export function getCooldownState(
  db: Database,
  sessionId: string
): CooldownState | null {
  try {
    const row = getThreadState(db, sessionId);
    if (!row) return null;
    const meta = row.key_exchanges.find(
      (e: { role: string; gist: string }) => e.role === COOLDOWN_ROLE
    );
    if (!meta) return null;
    const parsed = JSON.parse(meta.gist);
    return {
      lastShiftEpoch: parsed.lastShiftEpoch ?? 0,
      turnsSinceShift: parsed.turnsSinceShift ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persists cooldown state into thread_state key_exchanges.
 * Upserts the __cooldown meta-entry without disturbing real exchanges.
 * Non-throwing.
 */
export function setCooldownState(
  db: Database,
  sessionId: string,
  cooldown: CooldownState
): void {
  try {
    const row = getThreadState(db, sessionId);
    if (!row) return; // No thread state to attach cooldown to
    // Filter out any existing __cooldown entry, then append new one
    const exchanges = row.key_exchanges.filter(
      (e: { role: string }) => e.role !== COOLDOWN_ROLE
    );
    exchanges.push({
      role: COOLDOWN_ROLE,
      gist: JSON.stringify(cooldown),
    });
    upsertThreadState(db, {
      session_id: sessionId,
      topic: row.topic ?? undefined,
      summary: row.summary ?? undefined,
      key_exchanges: exchanges,
    });
  } catch {
    // Non-throwing
  }
}

