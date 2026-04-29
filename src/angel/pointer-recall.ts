/**
 * Phase 5.5 — Pointer recall logging + helpful_yn marking.
 *
 * Helpers used by:
 *   - src/mcp/recall-server.ts (claudex_recall handler — Plan 02)
 *   - src/cli/list-session-pointers.ts + mark-pointers-helpful.ts (Plan 03)
 *
 * Locked schema: V19 lesson_pointer + pointer_recall_log.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

export type PointerSource = 'lesson' | 'user_note';

/**
 * Ensure a pointer registry row exists for the given (project, filename, source)
 * tuple and return its INTEGER id. INSERT OR IGNORE keeps it idempotent under
 * concurrent inserts.
 */
export function ensurePointerId(
  db: Database,
  project: string,
  filename: string,
  source: PointerSource,
): number {
  const now = Date.now();
  cachedPrepare(db,
    `INSERT OR IGNORE INTO lesson_pointer (project, filename, source, first_seen_epoch_ms)
     VALUES (?, ?, ?, ?)`
  ).run(project, filename, source, now);

  const row = cachedPrepare(db,
    `SELECT id FROM lesson_pointer WHERE project = ? AND filename = ? AND source = ?`
  ).get(project, filename, source) as { id: number } | undefined;

  if (!row) {
    throw new Error(`ensurePointerId: row missing after INSERT OR IGNORE — DB corruption? (${project}/${filename}/${source})`);
  }
  return row.id;
}

/**
 * Record a single retrieval event for a pointer. Fire-and-forget from MCP
 * server callers (no await needed — this is sync better-sqlite3).
 *
 * `query` is null when the surface is non-search (e.g., MEMORY.md inclusion).
 */
export function recordPointerRecall(
  db: Database,
  pointerId: number,
  sessionId: string,
  query: string | null,
): void {
  cachedPrepare(db,
    `INSERT INTO pointer_recall_log (pointer_id, session_id, retrieved_at_epoch_ms, query)
     VALUES (?, ?, ?, ?)`
  ).run(pointerId, sessionId, Date.now(), query);
}

/**
 * Mark a set of pointers as helpful for the given session. Updates ALL
 * matching rows (a pointer may have been retrieved multiple times in one
 * session — the user's helpful tap applies to the whole set).
 *
 * Only flips rows where helpful_yn IS NULL — never overwrites a prior mark.
 *
 * Returns the number of rows updated.
 */
export function markPointersHelpful(
  db: Database,
  sessionId: string,
  pointerIds: number[],
): number {
  if (pointerIds.length === 0) return 0;
  const placeholders = pointerIds.map(() => '?').join(',');
  const result = cachedPrepare(db,
    `UPDATE pointer_recall_log
       SET helpful_yn = 1
     WHERE session_id = ?
       AND helpful_yn IS NULL
       AND pointer_id IN (${placeholders})`
  ).run(sessionId, ...pointerIds);
  return result.changes;
}

/**
 * Convenience: list pointer_recall_log rows for a session, joined with
 * lesson_pointer. Used by the /endsession list CLI (Plan 03). Sorted by
 * first retrieval time ascending so the numbered list is in the order
 * the agent encountered the pointers.
 */
export interface SessionPointerRow {
  pointer_id: number;
  project: string;
  filename: string;
  source: PointerSource;
  first_retrieved_at_epoch_ms: number;
  recall_count: number;
  helpful_yn: number | null;
}

export function listSessionPointers(db: Database, sessionId: string): SessionPointerRow[] {
  return cachedPrepare(db,
    `SELECT lp.id AS pointer_id,
            lp.project,
            lp.filename,
            lp.source,
            MIN(prl.retrieved_at_epoch_ms) AS first_retrieved_at_epoch_ms,
            COUNT(*) AS recall_count,
            MAX(prl.helpful_yn) AS helpful_yn
     FROM pointer_recall_log prl
     JOIN lesson_pointer lp ON lp.id = prl.pointer_id
     WHERE prl.session_id = ?
     GROUP BY lp.id
     ORDER BY first_retrieved_at_epoch_ms ASC`
  ).all(sessionId) as SessionPointerRow[];
}
