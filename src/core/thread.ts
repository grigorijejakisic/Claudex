/**
 * Thread state CRUD — topic, summary, and key_exchanges tracking.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (thread_state table)
 */

import type { Database } from 'better-sqlite3';

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
  db.prepare(
    `INSERT OR REPLACE INTO thread_state (session_id, topic, summary, key_exchanges, updated_at_epoch)
     VALUES (?, ?, ?, ?, unixepoch())`
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
  const row = db
    .prepare('SELECT * FROM thread_state WHERE session_id = ?')
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
  db.prepare('DELETE FROM thread_state WHERE session_id = ?').run(sessionId);
}
