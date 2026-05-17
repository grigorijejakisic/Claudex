/**
 * Phase 8.5 — Per-session retrieval log writer + reader + aggregator.
 *
 * Sole writer/reader of the V22 `retrieval_log` table. Other code in the
 * codebase (MCP server, CLIs) calls these helpers — no raw SQL against the
 * table outside this module.
 *
 * Surfaces logged:
 *   - claudex_search   (every call after RRF fusion)
 *   - claudex_recall   (every successful resolution; not-found case skipped)
 *   - pointer_surface  (reserved; pointer_recall_log is the live surface today)
 *   - mcp_other        (reserved for future surfaces)
 *
 * `used_in_output` is a best-effort heuristic, computed post-hoc by the
 * reconciler against artifact(kind='transcript_chunk') rows.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import { countTokensCl100k } from '../shared/text-utils.js';
import { recordReferences } from './soft-link-writers.js';

export type RetrievalSurface =
  | 'claudex_search'
  | 'claudex_recall'
  | 'pointer_surface'
  | 'mcp_other';

export interface RetrievalLogInput {
  sessionId: string;
  surface: RetrievalSurface;
  query: string | null;
  topKResults: Array<{ id: number | string; source: string; score: number }>;
  /** The text the agent actually receives — used for cl100k_base token_cost. */
  responseText: string;
  /** Defaults to Date.now() when omitted. */
  invokedAtEpochMs?: number;
}

export interface RetrievalLogRow {
  id: number;
  session_id: string;
  invoked_at_epoch_ms: number;
  surface: RetrievalSurface;
  query: string | null;
  top_k_results: string;
  used_in_output: 0 | 1;
  token_cost: number;
}

export interface AggregateSessionCost {
  invocations: number;
  totalTokens: number;
  usedCount: number;
  hitRate: number;
  bySurface: Record<RetrievalSurface, { count: number; tokens: number }>;
}

/**
 * Insert a single retrieval event. Non-throwing — returns the inserted row id
 * or 0 on failure. Logging must never break the retrieval response.
 */
export function recordRetrieval(
  db: Database,
  input: RetrievalLogInput,
): number {
  try {
    const tokenCost = countTokensCl100k(input.responseText);
    const ts = input.invokedAtEpochMs ?? Date.now();
    const json = JSON.stringify(input.topKResults ?? []);
    const result = cachedPrepare(db,
      `INSERT INTO retrieval_log
         (session_id, invoked_at_epoch_ms, surface, query, top_k_results, used_in_output, token_cost)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).run(input.sessionId, ts, input.surface, input.query, json, tokenCost);
    return Number(result.lastInsertRowid) || 0;
  } catch {
    return 0;
  }
}

/**
 * All retrieval rows for a session in chronological order.
 * Used by /claudex-why renderer and the reconciler.
 */
export function listSessionRetrievals(
  db: Database,
  sessionId: string,
): RetrievalLogRow[] {
  return cachedPrepare(db,
    `SELECT id, session_id, invoked_at_epoch_ms, surface, query, top_k_results, used_in_output, token_cost
       FROM retrieval_log
      WHERE session_id = ?
      ORDER BY invoked_at_epoch_ms ASC`
  ).all(sessionId) as RetrievalLogRow[];
}

/**
 * Aggregate token cost + invocation counts for a session.
 * Used by /endsession summary and /claudex-why footer.
 */
export function aggregateSessionCost(
  db: Database,
  sessionId: string,
): AggregateSessionCost {
  const rows = listSessionRetrievals(db, sessionId);
  let invocations = 0;
  let totalTokens = 0;
  let usedCount = 0;
  const bySurface: Record<RetrievalSurface, { count: number; tokens: number }> =
    {} as Record<RetrievalSurface, { count: number; tokens: number }>;
  for (const r of rows) {
    invocations++;
    totalTokens += r.token_cost;
    if (r.used_in_output === 1) usedCount++;
    const surf = r.surface;
    const bucket = bySurface[surf] ?? { count: 0, tokens: 0 };
    bucket.count++;
    bucket.tokens += r.token_cost;
    bySurface[surf] = bucket;
  }
  const hitRate = invocations > 0 ? usedCount / invocations : 0;
  return { invocations, totalTokens, usedCount, hitRate, bySurface };
}

/**
 * Mark a set of retrieval_log rows as used_in_output=1.
 * Idempotent — only flips 0→1, never 1→0.
 * Returns rows updated.
 */
export function markRetrievalUsed(
  db: Database,
  retrievalIds: number[],
): number {
  if (!retrievalIds || retrievalIds.length === 0) return 0;
  const placeholders = retrievalIds.map(() => '?').join(',');
  const result = cachedPrepare(db,
    `UPDATE retrieval_log
        SET used_in_output = 1
      WHERE id IN (${placeholders})
        AND used_in_output = 0`
  ).run(...retrievalIds);
  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// used_in_output heuristic
// ---------------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'is', 'was',
  'this', 'that', 'with', 'for', 'on', 'as', 'by', 'at', 'from', 'it',
  'its', 'but', 'not', 'no', 'are', 'were', 'has', 'have', 'had', 'be',
  'been', 'do', 'does', 'did', 'can', 'will', 'would', 'should', 'could',
  'may', 'might', 'must', 'our', 'your', 'their', 'my', 'his', 'her',
  'who', 'what', 'where',
]);

/**
 * Extract distinctive tokens from text:
 *   - lowercased
 *   - alphanumeric/underscore/dash, length ≥ 6
 *   - not a stopword
 */
export function distinctiveTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const lower = text.toLowerCase();
  const re = /[a-z][a-z0-9_-]{5,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const tok = m[0];
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Run the used_in_output heuristic for a session.
 *
 * For each retrieval_log row in the session:
 *   - Distinctive tokens from the row's `top_k_results` summaries (resolved
 *     through `artifact.body`/`artifact.title` when ids are integers).
 *     If resolution fails, fall back to tokens of the `query` column —
 *     a query echo in assistant output is also a weak usage signal.
 *   - Distinctive tokens from up to 5 transcript-chunk artifacts whose
 *     `created_at_epoch_ms >= retrieval.invoked_at_epoch_ms` (both ms).
 *     `transcript_chunk` rows are stored in the `artifact` table with
 *     `kind='transcript_chunk'`. They contain joined turn text per the
 *     Phase 4.1 chunker (`user_text\nassistant_text`).
 *   - Overlap ≥ 2 → row marked.
 *
 * Returns rowsUpdated. Non-throwing.
 */
export function reconcileUsedInOutput(
  db: Database,
  sessionId: string,
): { rowsUpdated: number } {
  let rowsUpdated = 0;
  try {
    const rows = listSessionRetrievals(db, sessionId);
    if (rows.length === 0) return { rowsUpdated: 0 };

    // Detect whether `artifact` table is queryable. On legacy/partial DBs the
    // table may be missing — degrade silently (no false positives).
    let hasArtifactTable = false;
    try {
      const probe = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name='artifact' LIMIT 1`
      ).get();
      hasArtifactTable = !!probe;
    } catch {
      hasArtifactTable = false;
    }

    const toMark: number[] = [];

    for (const row of rows) {
      if (row.used_in_output === 1) continue;

      // Source tokens from the retrieval result.
      const sourceTokens = new Set<string>();

      let topK: Array<{ id: number | string; source?: string; score?: number }> = [];
      try {
        topK = JSON.parse(row.top_k_results) as typeof topK;
      } catch {
        topK = [];
      }

      if (hasArtifactTable && topK.length > 0) {
        const numericIds = topK
          .map(r => (typeof r.id === 'number' ? r.id : Number(r.id)))
          .filter(n => Number.isFinite(n));
        if (numericIds.length > 0) {
          const placeholders = numericIds.map(() => '?').join(',');
          try {
            const arts = db.prepare(
              `SELECT title, body FROM artifact WHERE id IN (${placeholders})`
            ).all(...numericIds) as Array<{ title?: string; body?: string }>;
            for (const a of arts) {
              for (const t of distinctiveTokens(a.title)) sourceTokens.add(t);
              for (const t of distinctiveTokens(a.body)) sourceTokens.add(t);
            }
          } catch {
            // Resolution failed — fall through to query echo only
          }
        }
      }
      // Fallback / supplement: query string itself.
      for (const t of distinctiveTokens(row.query)) sourceTokens.add(t);

      if (sourceTokens.size === 0) continue;

      // Assistant transcript_chunk artifacts in the post-retrieval window.
      let chunkTokens = new Set<string>();
      if (hasArtifactTable) {
        try {
          const chunks = db.prepare(
            `SELECT body FROM artifact
              WHERE kind = 'transcript_chunk'
                AND session_id = ?
                AND created_at_epoch_ms >= ?
              ORDER BY created_at_epoch_ms ASC
              LIMIT 5`
          ).all(sessionId, row.invoked_at_epoch_ms) as Array<{ body?: string }>;
          for (const c of chunks) {
            for (const t of distinctiveTokens(c.body)) chunkTokens.add(t);
          }
        } catch {
          chunkTokens = new Set<string>();
        }
      }
      if (chunkTokens.size === 0) continue;

      // Intersection size.
      let overlap = 0;
      for (const t of sourceTokens) {
        if (chunkTokens.has(t)) {
          overlap++;
          if (overlap >= 2) break;
        }
      }
      if (overlap >= 2) toMark.push(row.id);
    }

    if (toMark.length > 0) {
      const updateTx = db.transaction((ids: number[]) => {
        rowsUpdated = markRetrievalUsed(db, ids);
      });
      updateTx(toMark);
    }
  } catch {
    return { rowsUpdated: 0 };
  }
  return { rowsUpdated };
}
