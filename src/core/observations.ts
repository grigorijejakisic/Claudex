/**
 * Observation CRUD with FTS5 full-text search and BM25 temporal re-ranking.
 * Plain functions with `db: Database` as first param.
 * @see Architecture Section 4.2 (observations table + FTS5 schema)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { CONTENT_MAX_CHARS } from '../shared/constants.js';
import { truncateText } from '../shared/text-utils.js';

/** Valid observation categories. */
const VALID_CATEGORIES = [
  'code', 'architecture', 'decision', 'error', 'test',
  'config', 'dependency', 'documentation', 'performance',
  'security', 'other',
] as const;

export type ObservationCategory = (typeof VALID_CATEGORIES)[number];

/** Row shape returned from observation queries. */
export interface ObservationRow {
  id: number;
  session_id: string;
  project: string | null;
  tool_name: string;
  category: string;
  title: string;
  content: string;
  importance: number;
  files_modified: string;
  timestamp_epoch: number;
  access_count: number;
  last_accessed_at_epoch: number | null;
  deleted_at_epoch: number | null;
  consumed: number;
  obs_type: string | null;
}

/** Input for inserting an observation. */
export interface InsertObservationInput {
  session_id: string;
  project: string;
  tool_name: string;
  category: ObservationCategory;
  title: string;
  content: string;
  importance: number;
  files_modified: string[];
  obs_type?: string;
}

/**
 * Inserts an observation into the database.
 * Serializes files_modified as JSON. Returns the inserted row id.
 */
export function insertObservation(
  db: Database,
  obs: InsertObservationInput
): number {
  // Strip typed redaction markers from FTS-indexed fields so that
  // "secret", "pii", "entropy" stems don't pollute full-text search.
  // The generic "[REDACTED]" placeholder is kept for visual indication.
  const ftsCleanTitle = obs.title.replace(/\[REDACTED_\w+\]/g, '[REDACTED]');
  const ftsCleanContent = obs.content.replace(/\[REDACTED_\w+\]/g, '[REDACTED]');
  // Defense-in-depth content cap (backstop for extractors)
  const cappedContent = truncateText(ftsCleanContent, CONTENT_MAX_CHARS);

  const result = cachedPrepare(db,
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, obs_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      obs.session_id,
      obs.project,
      obs.tool_name,
      obs.category,
      ftsCleanTitle,
      cappedContent,
      obs.importance,
      JSON.stringify(obs.files_modified),
      obs.obs_type ?? null
    );

  return Number(result.lastInsertRowid);
}

/**
 * Retrieves observations for a given project.
 * Excludes soft-deleted rows unless includeDeleted is true.
 * Ordered by timestamp_epoch DESC. Default limit 100.
 * QUAL-04: Filters by project scope.
 */
export function getObservationsByProject(
  db: Database,
  project: string,
  opts?: { limit?: number; includeDeleted?: boolean }
): ObservationRow[] {
  const limit = opts?.limit ?? 100;
  const includeDeleted = opts?.includeDeleted ?? false;

  if (includeDeleted) {
    return cachedPrepare(db,
        `SELECT * FROM observations
         WHERE project = ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`
      )
      .all(project, limit) as ObservationRow[];
  }

  return cachedPrepare(db,
      `SELECT * FROM observations
       WHERE project = ? AND deleted_at_epoch IS NULL
       ORDER BY timestamp_epoch DESC
       LIMIT ?`
    )
    .all(project, limit) as ObservationRow[];
}

/**
 * Retrieves a single observation by its id.
 */
export function getObservationById(
  db: Database,
  id: number
): ObservationRow | undefined {
  return cachedPrepare(db, 'SELECT * FROM observations WHERE id = ?')
    .get(id) as ObservationRow | undefined;
}

/**
 * FTS5 search with BM25 + exponential temporal re-ranking.
 *
 * Uses BM25 for initial relevance scoring from SQLite FTS5,
 * then applies temporal decay: finalScore = bm25Rank * exp(-ageDays / 30).
 * BM25 returns negative values (lower = more relevant), so temporal decay
 * pushes older results toward zero (less relevant). Sort ascending.
 *
 * @see Architecture Section 4.2 (FTS5 search)
 */
export function searchObservations(
  db: Database,
  query: string,
  project: string,
  opts?: { limit?: number }
): ObservationRow[] {
  const limit = opts?.limit ?? 100;

  const rows = cachedPrepare(db,
      `SELECT o.*, bm25(observations_fts) as bm25_rank
       FROM observations_fts fts
       JOIN observations o ON o.id = fts.rowid
       WHERE observations_fts MATCH ?
         AND o.project = ?
         AND o.deleted_at_epoch IS NULL
         AND o.consumed = 0
       ORDER BY bm25(observations_fts)
       LIMIT ?`
    )
    .all(query, project, limit) as Array<ObservationRow & { bm25_rank: number }>;

  const nowEpoch = Date.now() / 1000;

  // Apply temporal re-ranking
  const scored = rows.map((row) => {
    const ageDays = (nowEpoch - row.timestamp_epoch) / 86400;
    const finalScore = row.bm25_rank * Math.exp(-ageDays / 30);
    return { row, finalScore };
  });

  // Sort by finalScore ascending (more negative = more relevant)
  scored.sort((a, b) => a.finalScore - b.finalScore);

  // Strip bm25_rank from returned rows
  return scored.map(({ row }) => {
    const { bm25_rank: _, ...obs } = row;
    return obs as ObservationRow;
  });
}

/**
 * Soft-deletes an observation by setting deleted_at_epoch.
 */
export function softDeleteObservation(db: Database, id: number): void {
  cachedPrepare(db,
    'UPDATE observations SET deleted_at_epoch = unixepoch() WHERE id = ?'
  ).run(id);
}

/**
 * Increments access_count and updates last_accessed_at_epoch for an observation.
 */
export function incrementAccessCount(db: Database, id: number): void {
  cachedPrepare(db,
    `UPDATE observations SET access_count = access_count + 1, last_accessed_at_epoch = unixepoch()
     WHERE id = ?`
  ).run(id);
}

/**
 * Marks observations as consumed (already injected into context).
 * Used by PreCompact to flag old observations that don't need re-injection.
 * @param db Database instance
 * @param project Project scope
 * @param olderThanEpoch Unix epoch — observations older than this are marked consumed
 * @param excludeRecent Number of most recent observations to always keep unconsumed
 */
export function markObservationsConsumed(
  db: Database,
  project: string,
  olderThanEpoch: number,
  excludeRecent: number = 10
): number {
  // Get IDs of the N most recent observations to exclude
  const recentIds = cachedPrepare(db,
    `SELECT id FROM observations
     WHERE project = ? AND deleted_at_epoch IS NULL
     ORDER BY timestamp_epoch DESC
     LIMIT ?`
  ).all(project, excludeRecent) as Array<{ id: number }>;

  const excludeSet = new Set(recentIds.map(r => r.id));

  if (excludeSet.size === 0) {
    // Mark all older observations as consumed
    const result = cachedPrepare(db,
      `UPDATE observations SET consumed = 1
       WHERE project = ? AND deleted_at_epoch IS NULL
         AND consumed = 0 AND timestamp_epoch < ?`
    ).run(project, olderThanEpoch);
    return result.changes;
  }

  // Use subquery to exclude the most recent N observations
  const result = cachedPrepare(db,
    `UPDATE observations SET consumed = 1
     WHERE project = ? AND deleted_at_epoch IS NULL
       AND consumed = 0 AND timestamp_epoch < ?
       AND id NOT IN (
         SELECT id FROM observations
         WHERE project = ? AND deleted_at_epoch IS NULL
         ORDER BY timestamp_epoch DESC
         LIMIT ?
       )`
  ).run(project, olderThanEpoch, project, excludeRecent);
  return result.changes;
}
