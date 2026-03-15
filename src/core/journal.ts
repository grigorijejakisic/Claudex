/**
 * Session journal CRUD — flow breadcrumbs, milestones, and session summaries.
 * Plain functions with `db: Database` as first param.
 * @see session_journal table in migrations.ts
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

/** Valid journal entry types. */
export type JournalEntryType = 'flow' | 'milestone' | 'summary';

/** Row shape returned from session_journal queries. */
export interface JournalEntry {
  id: number;
  session_id: string;
  project: string;
  entry_type: JournalEntryType;
  content: string;
  timestamp_epoch: number;
}

/**
 * Inserts a journal entry.
 * Returns the inserted row id.
 */
export function addJournalEntry(
  db: Database,
  sessionId: string,
  project: string,
  entryType: JournalEntryType,
  content: string
): number {
  const result = cachedPrepare(db,
    `INSERT INTO session_journal (session_id, project, entry_type, content)
     VALUES (?, ?, ?, ?)`
  ).run(sessionId, project, entryType, content);

  return Number(result.lastInsertRowid);
}

/**
 * Returns journal entries for a session, newest first.
 * Optionally filtered by entry_type. Default limit 100.
 */
export function getJournalBySession(
  db: Database,
  sessionId: string,
  options?: { entryType?: JournalEntryType; limit?: number }
): JournalEntry[] {
  const limit = options?.limit ?? 100;

  if (options?.entryType) {
    return cachedPrepare(db,
      `SELECT * FROM session_journal
       WHERE session_id = ? AND entry_type = ?
       ORDER BY timestamp_epoch DESC
       LIMIT ?`
    ).all(sessionId, options.entryType, limit) as JournalEntry[];
  }

  return cachedPrepare(db,
    `SELECT * FROM session_journal
     WHERE session_id = ?
     ORDER BY timestamp_epoch DESC
     LIMIT ?`
  ).all(sessionId, limit) as JournalEntry[];
}

/**
 * Returns recent flow entries for a project, newest first.
 * Used for assembly injection of reasoning breadcrumbs.
 * Default limit 20.
 */
export function getRecentFlow(
  db: Database,
  project: string,
  limit?: number
): JournalEntry[] {
  return cachedPrepare(db,
    `SELECT * FROM session_journal
     WHERE project = ? AND entry_type = 'flow'
     ORDER BY timestamp_epoch DESC
     LIMIT ?`
  ).all(project, limit ?? 20) as JournalEntry[];
}

/**
 * Returns milestones for a session, newest first.
 * Default limit 50.
 */
export function getSessionMilestones(
  db: Database,
  sessionId: string,
  limit?: number
): JournalEntry[] {
  return cachedPrepare(db,
    `SELECT * FROM session_journal
     WHERE session_id = ? AND entry_type = 'milestone'
     ORDER BY timestamp_epoch DESC
     LIMIT ?`
  ).all(sessionId, limit ?? 50) as JournalEntry[];
}

