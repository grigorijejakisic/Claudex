/**
 * Session journal CRUD — flow breadcrumbs, milestones, and session summaries.
 * Plain functions with `db: Database` as first param.
 * @see session_journal table in migrations.ts
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { tokenizeQuery } from '../shared/search-utils.js';

/** Valid journal entry types. */
export type JournalEntryType = 'flow' | 'milestone' | 'summary';

/** Structured metadata for journal entries — machine-queryable context. */
export interface JournalMetadata {
  /** Test run results */
  test_count?: number;
  pass_count?: number;
  fail_count?: number;
  /** Build results */
  build_tool?: string;
  build_duration_ms?: number;
  /** Commit info */
  commit_hash?: string;
  commit_message?: string;
  /** File info */
  files?: string[];
  /** Generic key-value pairs */
  [key: string]: unknown;
}

/**
 * Recall metadata — bridges human associative memory and LLM lexical search.
 * Generated at session boundaries (Stop hook heuristic + /endsession LLM quality).
 */
export interface RecallMetadata extends JournalMetadata {
  /** How a human would search for this session later (in user's voice) */
  recall_aliases?: string[];
  /** One-line story of what happened in human language */
  narrative?: string;
  /** Emotional/contextual signals: frustration, breakthrough, unresolved, correction, etc. */
  situational_tags?: string[];
  /** Entity/topic associations beyond exact keywords */
  related_concepts?: string[];
}

/** Row shape returned from session_journal queries. */
export interface JournalEntry {
  id: number;
  session_id: string;
  project: string;
  entry_type: JournalEntryType;
  content: string;
  metadata: string | null;
  recall_text: string | null;
  timestamp_epoch_ms: number;
}

/** Parsed journal entry with typed metadata. */
export interface JournalEntryParsed extends Omit<JournalEntry, 'metadata'> {
  metadata: JournalMetadata | null;
}

/**
 * Inserts a journal entry with optional structured metadata and recall text.
 * Returns the inserted row id.
 */
export function addJournalEntry(
  db: Database,
  sessionId: string,
  project: string,
  entryType: JournalEntryType,
  content: string,
  metadata?: JournalMetadata,
  recallText?: string,
): number {
  const metaJson = metadata ? JSON.stringify(metadata) : null;
  const result = cachedPrepare(db,
    `INSERT INTO session_journal (session_id, project, entry_type, content, metadata, recall_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, project, entryType, content, metaJson, recallText ?? null);

  return Number(result.lastInsertRowid);
}

/**
 * Updates recall_text on an existing journal entry (for /endsession LLM enrichment).
 */
export function updateRecallText(
  db: Database,
  entryId: number,
  recallText: string,
  metadata?: RecallMetadata,
): void {
  try {
    if (metadata) {
      cachedPrepare(db,
        `UPDATE session_journal SET recall_text = ?, metadata = ? WHERE id = ?`
      ).run(recallText, JSON.stringify(metadata), entryId);
    } else {
      cachedPrepare(db,
        `UPDATE session_journal SET recall_text = ? WHERE id = ?`
      ).run(recallText, entryId);
    }
  } catch {
    // Non-throwing
  }
}

/**
 * Searches session_journal via FTS5 for recall-friendly retrieval.
 * Returns matching entries ranked by relevance.
 */
export function searchJournalFTS(
  db: Database,
  query: string,
  project?: string,
  limit?: number,
): JournalEntry[] {
  try {
    // Tokenize using shared search-utils (stop-word filtered, min 3 chars)
    const tokens = tokenizeQuery(query, 15);
    if (tokens.length === 0) return [];

    const ftsQuery = tokens.join(' OR ');

    if (project) {
      return cachedPrepare(db,
        `SELECT j.* FROM session_journal j
         JOIN session_journal_fts fts ON j.id = fts.rowid
         WHERE session_journal_fts MATCH ? AND j.project = ?
         ORDER BY bm25(session_journal_fts, 1.0, 2.0) ASC
         LIMIT ?`
      ).all(ftsQuery, project, limit ?? 10) as JournalEntry[];
    }

    return cachedPrepare(db,
      `SELECT j.* FROM session_journal j
       JOIN session_journal_fts fts ON j.id = fts.rowid
       WHERE session_journal_fts MATCH ?
       ORDER BY bm25(session_journal_fts, 1.0, 2.0) ASC
       LIMIT ?`
    ).all(ftsQuery, limit ?? 10) as JournalEntry[];
  } catch {
    return [];
  }
}

/**
 * Parses a raw JournalEntry's metadata JSON string into a typed object.
 */
export function parseJournalMetadata(entry: JournalEntry): JournalEntryParsed {
  let parsed: JournalMetadata | null = null;
  if (entry.metadata) {
    try { parsed = JSON.parse(entry.metadata); } catch { /* malformed JSON */ }
  }
  return { ...entry, metadata: parsed };
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
       ORDER BY timestamp_epoch_ms DESC
       LIMIT ?`
    ).all(sessionId, options.entryType, limit) as JournalEntry[];
  }

  return cachedPrepare(db,
    `SELECT * FROM session_journal
     WHERE session_id = ?
     ORDER BY timestamp_epoch_ms DESC
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
     ORDER BY timestamp_epoch_ms DESC
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
     ORDER BY timestamp_epoch_ms DESC
     LIMIT ?`
  ).all(sessionId, limit ?? 50) as JournalEntry[];
}

