/**
 * V17 stale-row heuristic scanner.
 *
 * Per 02-CONTEXT.md Decision 8 and STOR-05: before P1 migration commits,
 * scan `project_curated_context` for rows matching a tightly-scoped list
 * of keywords that mark superseded-reality claims. Humans review the
 * result (`.planning/phases/02-p1-artifact-table-unification/stale-review.md`)
 * and decide per-row whether to flag `status='stale'` or keep as-is.
 *
 * Keywords are exact-substring, ASCII-case-insensitive (SQLite LIKE default).
 */

import type { Database } from 'better-sqlite3';

/**
 * Keywords lifted directly from CONTEXT.md §specifics + commit c84dd61
 * (Gemma 4 31B → Ollama Cloud glm-5.1:cloud swap). Do NOT extend without
 * a corresponding stated change in CONTEXT.md.
 */
export const STALE_KEYWORDS = [
  'Gemma 4 31B',
  'llama-server:8081',
  'local llama-server',
] as const;

export type StaleKeyword = (typeof STALE_KEYWORDS)[number];

export interface StaleMatch {
  /** Integer `project_curated_context.id`. Resolved to UUID via legacy_id_map at apply time. */
  legacyId: number;
  /** First 120 chars of `content` with newlines → spaces, for human review. */
  contentPreview: string;
  /** Which keyword(s) matched the row. */
  triggers: StaleKeyword[];
}

/**
 * Scan `project_curated_context` for rows whose `content` contains any
 * `STALE_KEYWORDS` substring. Results are deterministically ordered by `id`.
 *
 * Safe against missing table (returns []). No schema assumption beyond
 * `id INTEGER PRIMARY KEY` and `content TEXT`.
 */
export function scanStaleRows(db: Database): StaleMatch[] {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get('project_curated_context');
  if (!tableExists) return [];

  // Build an OR clause: content LIKE '%kw1%' OR content LIKE '%kw2%' ...
  const orClauses = STALE_KEYWORDS.map(() => 'content LIKE ?').join(' OR ');
  const params = STALE_KEYWORDS.map((kw) => `%${kw}%`);
  const rows = db
    .prepare(
      `SELECT id, content FROM project_curated_context WHERE ${orClauses} ORDER BY id ASC`,
    )
    .all(...params) as { id: number; content: string }[];

  return rows.map((row) => {
    const contentLower = row.content.toLowerCase();
    const triggers: StaleKeyword[] = STALE_KEYWORDS.filter((kw) =>
      contentLower.includes(kw.toLowerCase()),
    );
    const contentPreview = row.content.replace(/\s+/g, ' ').slice(0, 120);
    return { legacyId: row.id, contentPreview, triggers };
  });
}
