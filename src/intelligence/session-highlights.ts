/**
 * Session Highlights — reader/writer for the session_highlights table (V33).
 *
 * Per-session FRAME artifacts: mental model, open questions, reframes,
 * tools introduced, decisions not made, posture context.
 *
 * Distinct from project_curated_context (project-scoped, blob) and the event
 * artifact stream (observations/decisions/learnings). Highlights are qualitative
 * synthesis of what the session was THINKING ABOUT and WHY.
 *
 * Schema (V33): UNIQUE(session_id, project) — upsert overwrites prior row for
 * the same session+project pair. Used by 13-04 assembly and 13-05 cue gate.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

export interface OpenQuestion {
  question: string;
  context: string;
}

export interface Reframe {
  old_theory: string;
  new_theory: string;
  why: string;
}

export interface ToolIntroduced {
  path: string;
  purpose: string;
}

export interface DecisionNotMade {
  gray_area: string;
  why_deferred: string;
}

export interface SessionHighlightsRow {
  session_id: string;
  project: string;
  mental_model?: string;
  open_questions?: OpenQuestion[];
  reframes?: Reframe[];
  tools_introduced?: ToolIntroduced[];
  decisions_not_made?: DecisionNotMade[];
  posture_context?: string;
  degraded?: boolean;
  degraded_reason?: string;
  degraded_model?: string;
  created_at_epoch_ms: number;
  re_extracted_at_epoch_ms?: number;
}

export interface SessionHighlightsRecord extends SessionHighlightsRow {
  id: number;
}

const UPSERT_SQL = `
INSERT INTO session_highlights (
  session_id, project, mental_model, open_questions, reframes,
  tools_introduced, decisions_not_made, posture_context,
  degraded, degraded_reason, degraded_model,
  created_at_epoch_ms, re_extracted_at_epoch_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, project) DO UPDATE SET
  mental_model = excluded.mental_model,
  open_questions = excluded.open_questions,
  reframes = excluded.reframes,
  tools_introduced = excluded.tools_introduced,
  decisions_not_made = excluded.decisions_not_made,
  posture_context = excluded.posture_context,
  degraded = excluded.degraded,
  degraded_reason = excluded.degraded_reason,
  degraded_model = excluded.degraded_model,
  re_extracted_at_epoch_ms = excluded.re_extracted_at_epoch_ms
`;

export function upsertHighlights(db: Database, row: SessionHighlightsRow): void {
  // Phase 13.1 Fix #4 (2026-05-15): write-time project integrity check.
  // The 2026-05-15 substrate-readout test surfaced a big-mozzy session's
  // frame appearing in a claudex-v3 session-start injection. The read-side
  // filter (`WHERE project = ?`) was correct; the leakage came from a
  // mismatch between `session_highlights.project` and the originating
  // `sessions.project` for the same session_id. Validate at write time so
  // any future caller (heartbeat, manual one-shot, test fixture) that
  // passes the wrong project fails loudly instead of poisoning retrieval.
  //
  // Throws rather than silently coercing on a real mismatch — a
  // mis-attributed highlight is the kind of bug a degraded path should
  // surface, not paper over. The `sessions` table query itself is wrapped
  // so a missing table on minimal/test DBs falls through to "no
  // comparison possible" rather than blocking the write.
  try {
    const sessionRow = cachedPrepare(
      db,
      `SELECT project FROM sessions WHERE session_id = ?`,
    ).get(row.session_id) as { project: string | null } | undefined;
    if (sessionRow && sessionRow.project && sessionRow.project !== row.project) {
      throw new Error(
        `session_highlights project mismatch: row.project=${row.project} ` +
        `vs sessions.project=${sessionRow.project} for session_id=${row.session_id}`,
      );
    }
  } catch (e) {
    // Re-throw the integrity violation; swallow only "no such table" /
    // other shape errors that mean the comparison surface isn't present.
    if (e instanceof Error && e.message.startsWith('session_highlights project mismatch')) {
      throw e;
    }
    // Otherwise: sessions table missing on a minimal DB — skip the check.
  }

  cachedPrepare(db, UPSERT_SQL).run(
    row.session_id,
    row.project,
    row.mental_model ?? null,
    row.open_questions ? JSON.stringify(row.open_questions) : null,
    row.reframes ? JSON.stringify(row.reframes) : null,
    row.tools_introduced ? JSON.stringify(row.tools_introduced) : null,
    row.decisions_not_made ? JSON.stringify(row.decisions_not_made) : null,
    row.posture_context ?? null,
    row.degraded ? 1 : 0,
    row.degraded_reason ?? null,
    row.degraded_model ?? null,
    row.created_at_epoch_ms,
    row.re_extracted_at_epoch_ms ?? null,
  );
}

export function getLatestHighlights(
  db: Database,
  project: string,
  limit: number = 3,
  minEpochMs?: number,
): SessionHighlightsRecord[] {
  try {
    // Phase 13.1 Fix #4 (2026-05-15): JOIN to sessions so the project
    // filter is keyed off the source-of-truth `sessions.project` rather
    // than `session_highlights.project`. The write-time integrity check
    // in upsertHighlights makes the two equal going forward; the JOIN is
    // belt-and-suspenders for any legacy rows the integrity check missed
    // and for the cross-attribution failure mode that motivated the
    // readout test.
    //
    // Phase 13.1 Fix #6 (2026-05-15): optional `minEpochMs` floor. When
    // the caller passes ACTIVE.md's `created_at_epoch_ms`, frames extracted
    // before the most recent handoff rewrite drop out. The handoff IS the
    // operator's "new state begins here" marker; pre-pivot frames describe
    // work that has been superseded and shouldn't crowd the post-pivot
    // session-start cascade. Closes the big-mozzy frame leak from the
    // 2026-05-15 readout — `e6aeef55`'s PnL frame was extracted before
    // that day's ACTIVE.md rewrite and falls out naturally.
    if (minEpochMs !== undefined) {
      const rows = cachedPrepare(db, `
        SELECT sh.*
        FROM session_highlights sh
        JOIN sessions s ON s.session_id = sh.session_id
        WHERE s.project = ?
          AND sh.created_at_epoch_ms >= ?
        ORDER BY sh.created_at_epoch_ms DESC
        LIMIT ?
      `).all(project, minEpochMs, limit) as Array<Record<string, unknown>>;
      return rows.map(deserializeRow);
    }

    const rows = cachedPrepare(db, `
      SELECT sh.*
      FROM session_highlights sh
      JOIN sessions s ON s.session_id = sh.session_id
      WHERE s.project = ?
      ORDER BY sh.created_at_epoch_ms DESC
      LIMIT ?
    `).all(project, limit) as Array<Record<string, unknown>>;

    return rows.map(deserializeRow);
  } catch {
    // Table may not exist yet on very fresh DBs that haven't run V33.
    return [];
  }
}

export function getHighlightsBySessionId(
  db: Database,
  session_id: string,
  project: string,
): SessionHighlightsRecord | null {
  try {
    const row = cachedPrepare(db, `
      SELECT * FROM session_highlights WHERE session_id = ? AND project = ?
    `).get(session_id, project) as Record<string, unknown> | undefined;
    return row ? deserializeRow(row) : null;
  } catch {
    return null;
  }
}

/**
 * Return session IDs that have no highlights row (or have degraded highlights).
 * Used by the heartbeat to find sessions needing extraction / retry.
 *
 * Reads from the `sessions` table joined to `session_highlights`. Filters to
 * status='completed'. Includes degraded rows so the next heartbeat tick can
 * retry Opus extraction.
 */
export function getSessionsPendingHighlights(
  db: Database,
  project: string,
  limit: number = 10,
): string[] {
  try {
    const rows = cachedPrepare(db, `
      SELECT s.session_id FROM sessions s
      LEFT JOIN session_highlights sh
        ON sh.session_id = s.session_id AND sh.project = s.project
      WHERE s.project = ?
        AND s.status = 'completed'
        AND (sh.session_id IS NULL OR sh.degraded = 1)
      ORDER BY s.created_at_epoch_ms DESC
      LIMIT ?
    `).all(project, limit) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  } catch {
    return [];
  }
}

function deserializeRow(raw: Record<string, unknown>): SessionHighlightsRecord {
  return {
    id: raw.id as number,
    session_id: raw.session_id as string,
    project: raw.project as string,
    mental_model: (raw.mental_model as string | null) ?? undefined,
    open_questions: raw.open_questions ? tryParseJson<OpenQuestion[]>(raw.open_questions as string) : undefined,
    reframes: raw.reframes ? tryParseJson<Reframe[]>(raw.reframes as string) : undefined,
    tools_introduced: raw.tools_introduced ? tryParseJson<ToolIntroduced[]>(raw.tools_introduced as string) : undefined,
    decisions_not_made: raw.decisions_not_made ? tryParseJson<DecisionNotMade[]>(raw.decisions_not_made as string) : undefined,
    posture_context: (raw.posture_context as string | null) ?? undefined,
    degraded: Boolean(raw.degraded),
    degraded_reason: (raw.degraded_reason as string | null) ?? undefined,
    degraded_model: (raw.degraded_model as string | null) ?? undefined,
    created_at_epoch_ms: raw.created_at_epoch_ms as number,
    re_extracted_at_epoch_ms: (raw.re_extracted_at_epoch_ms as number | null) ?? undefined,
  };
}

function tryParseJson<T>(s: string): T | undefined {
  try { return JSON.parse(s) as T; } catch { return undefined; }
}
