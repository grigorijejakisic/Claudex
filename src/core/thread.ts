/**
 * Thread state CRUD — topic, summary, and key_exchanges tracking.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (thread_state table)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { redactContent } from '../extraction/redaction.js';

export interface ThreadStateRow {
  session_id: string;
  topic: string | null;
  summary: string | null;
  key_exchanges: Array<{ role: string; gist: string }>;
  updated_at_epoch: number;
}

interface RawThreadStateRow {
  session_id: string;
  topic: string | null;
  summary: string | null;
  key_exchanges: string;
  updated_at_epoch: number;
}

/**
 * Creates or replaces thread state for a session.
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
    `INSERT OR REPLACE INTO thread_state (session_id, topic, summary, key_exchanges, updated_at_epoch)
     VALUES (?, ?, ?, ?, unixepoch())`
  ).run(
    state.session_id,
    state.topic ? redactContent(state.topic) : null,
    state.summary ? redactContent(state.summary) : null,
    JSON.stringify((state.key_exchanges ?? []).map(ex => ({
      ...ex,
      gist: redactContent(ex.gist),
    })))
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

  return {
    ...row,
    key_exchanges: JSON.parse(row.key_exchanges),
  };
}

/**
 * Deletes thread state for a session. Used in beforeCompact transaction.
 */
export function resetThreadState(
  db: Database,
  sessionId: string
): void {
  cachedPrepare(db, 'DELETE FROM thread_state WHERE session_id = ?').run(sessionId);
}

// ---------------------------------------------------------------------------
// Topic shift cooldown state — piggybacked on key_exchanges JSON
// Uses a reserved entry with role '__cooldown' to avoid schema changes.
// ---------------------------------------------------------------------------

export interface CooldownState {
  lastShiftEpoch: number;
  turnsSinceShift: number;
}

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
 * Writes cooldown state into thread_state key_exchanges.
 * Preserves existing key_exchanges, adds/replaces the __cooldown entry.
 * Non-throwing.
 */
export function setCooldownState(
  db: Database,
  sessionId: string,
  state: CooldownState
): void {
  try {
    const existing = getThreadState(db, sessionId);
    const exchanges = existing?.key_exchanges?.filter(
      (e: { role: string }) => e.role !== COOLDOWN_ROLE
    ) ?? [];
    exchanges.push({
      role: COOLDOWN_ROLE,
      gist: JSON.stringify(state),
    });
    upsertThreadState(db, {
      session_id: sessionId,
      topic: existing?.topic ?? undefined,
      summary: existing?.summary ?? undefined,
      key_exchanges: exchanges,
    });
  } catch {
    // Non-throwing
  }
}
