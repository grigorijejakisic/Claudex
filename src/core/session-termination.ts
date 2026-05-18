/**
 * Session termination — deterministic structured record of session end-state.
 *
 * Phase 14-09. Solves the "why did the last session stop?" question that
 * previously required raw SQL spelunking against session_events.user_framing
 * because session_highlights had been silently broken for days (degraded mode
 * when Ollama unreachable).
 *
 * Contract:
 *   - One row per session_id, written at session close by the responsible hook.
 *   - INSERT OR REPLACE — last-write-wins (a crash followed by /endsession on
 *     the same session_id, if it ever happens, takes the latter).
 *   - End reasons map to canonical hook outcomes:
 *       'endsession'  → operator ran /endsession (session-end hook)
 *       'crash'       → CC API failed mid-turn (stop-failure hook) OR
 *                       inferred at next session-start when status='active'
 *                       with stale last_heartbeat_ts (host crash / OOM kill)
 *       'compact'     → context compaction (pre-compact hook)
 *       'idle_close'  → Angel auto-close after sustained idle
 *       'unknown'     → fallback if no hook fired
 *
 * The next session's session-start hook reads this table to render a "Last
 * Session" block that's deterministic (vs the LLM-extracted LSS which is
 * stylized but Ollama-dependent).
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export type SessionEndReason =
  | 'endsession'
  | 'crash'
  | 'compact'
  | 'idle_close'
  | 'unknown';

export interface SessionTerminationRow {
  session_id: string;
  project: string;
  ended_at_epoch_ms: number;
  end_reason: SessionEndReason;
  last_user_directive: string | null;
  last_assistant_text: string | null;
  observation_count: number;
  recorded_at_epoch_ms: number;
}

export interface RecordTerminationOpts {
  session_id: string;
  project: string;
  end_reason: SessionEndReason;
  last_user_directive?: string | null;
  last_assistant_text?: string | null;
  /** Override ended_at; defaults to Date.now(). */
  ended_at_epoch_ms?: number;
}

/**
 * Idempotent: INSERT OR REPLACE keyed on session_id. Last write wins (an
 * operator who runs /endsession after a stop-failure has overridden the
 * crash reason — that's intentional).
 *
 * Non-throwing — hook completion must not depend on this row landing.
 * Returns true on successful write, false on schema/IO failure.
 */
export function recordSessionTermination(
  db: Database,
  opts: RecordTerminationOpts,
): boolean {
  try {
    const endedAt = opts.ended_at_epoch_ms ?? Date.now();
    // Look up observation_count from sessions; fallback 0.
    let obsCount = 0;
    try {
      const row = cachedPrepare(
        db,
        `SELECT observation_count FROM sessions WHERE session_id = ?`,
      ).get(opts.session_id) as { observation_count?: number } | undefined;
      obsCount = row?.observation_count ?? 0;
    } catch { /* sessions row missing — leave 0 */ }

    // Truncate long fields to bounded length (keep DB compact).
    const truncate = (s: string | null | undefined, n: number): string | null => {
      if (s === null || s === undefined) return null;
      return s.length <= n ? s : s.slice(0, n);
    };

    cachedPrepare(
      db,
      `INSERT OR REPLACE INTO session_termination
         (session_id, project, ended_at_epoch_ms, end_reason,
          last_user_directive, last_assistant_text, observation_count, recorded_at_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.session_id,
      opts.project,
      endedAt,
      opts.end_reason,
      truncate(opts.last_user_directive, 4000),
      truncate(opts.last_assistant_text, 4000),
      obsCount,
      Date.now(),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Crash inference: at session-start, find sessions still flagged active with
 * stale heartbeat / JSONL-write timestamps, and back-fill a 'crash' row for
 * each. Run from the session-start hook on every fresh session.
 *
 * "Stale" = no heartbeat or JSONL write in `staleThresholdMs` (default 30min).
 * Excludes the current session by `excludeSessionId`.
 *
 * Returns how many sessions were inferred-crashed.
 */
export function inferCrashedSessions(
  db: Database,
  opts: {
    excludeSessionId: string;
    staleThresholdMs?: number;
  },
): number {
  const stale = opts.staleThresholdMs ?? 30 * 60 * 1000;
  try {
    // Phase 14-09 — UNIT NOTE (codex review fix):
    // `last_heartbeat_ts` and `last_jsonl_write_ts` are stored as SECONDS
    // (matches the boundary-detector + thresholds convention — see
    // src/angel/boundary/composition-rule.ts and thresholds.ts).
    // `created_at_epoch_ms` is stored as MILLISECONDS.
    // We normalize all three to a single ms-shaped "last activity" value
    // and take the MAX (latest, not first non-null) before comparing
    // against the cutoff.
    const nowMs = Date.now();
    const cutoffMs = nowMs - stale;
    type Row = {
      session_id: string;
      project: string;
      last_heartbeat_ts: number | null;
      last_jsonl_write_ts: number | null;
      created_at_epoch_ms: number;
    };
    const candidates = cachedPrepare(
      db,
      `SELECT s.session_id, s.project, s.last_heartbeat_ts, s.last_jsonl_write_ts, s.created_at_epoch_ms
       FROM sessions s
       LEFT JOIN session_termination t ON t.session_id = s.session_id
       WHERE s.status = 'active'
         AND s.session_id != ?
         AND t.session_id IS NULL`,
    ).all(opts.excludeSessionId) as Row[];

    const markCompleted = cachedPrepare(
      db,
      `UPDATE sessions
         SET status = 'completed', ended_at_epoch_ms = ?
       WHERE session_id = ? AND status = 'active'`,
    );

    let inferred = 0;
    for (const o of candidates) {
      // Normalize each non-null timestamp to ms, take MAX (latest activity).
      const heartbeatMs = o.last_heartbeat_ts != null ? o.last_heartbeat_ts * 1000 : 0;
      const jsonlMs = o.last_jsonl_write_ts != null ? o.last_jsonl_write_ts * 1000 : 0;
      const createdMs = o.created_at_epoch_ms;
      const latestMs = Math.max(heartbeatMs, jsonlMs, createdMs);

      if (latestMs >= cutoffMs) continue; // Recently active — not a crash.

      const ok = recordSessionTermination(db, {
        session_id: o.session_id,
        project: o.project,
        end_reason: 'crash',
        ended_at_epoch_ms: latestMs,
      });
      if (ok) {
        // Codex review fix: don't leave inferred-crashed sessions in
        // status='active' — active-session queries would keep surfacing
        // them. Mark them terminated now that we have a termination row.
        try { markCompleted.run(latestMs, o.session_id); } catch { /* non-fatal */ }
        inferred++;
      }
    }
    return inferred;
  } catch {
    return 0;
  }
}

/**
 * Read the last user message + last assistant message from conversation_turns
 * for a session. Used by hook writers to populate session_termination without
 * each hook duplicating the query.
 *
 * Returns null fields when no turn rows exist (zero-turn session).
 */
export function readLastTurnTexts(
  db: Database,
  sessionId: string,
): { last_user_directive: string | null; last_assistant_text: string | null } {
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  try {
    const row = cachedPrepare(
      db,
      `SELECT user_text, assistant_text FROM conversation_turns
       WHERE session_id = ?
       ORDER BY turn_number DESC LIMIT 1`,
    ).get(sessionId) as { user_text?: string | null; assistant_text?: string | null } | undefined;
    if (row) {
      lastUser = row.user_text ?? null;
      lastAssistant = row.assistant_text ?? null;
    }
  } catch { /* schema mismatch — leave null */ }
  return { last_user_directive: lastUser, last_assistant_text: lastAssistant };
}

/**
 * Read recent session terminations for a project (or all projects when project
 * is omitted). Ordered by ended_at_epoch_ms DESC. Used by the new
 * `claudex_recent_sessions` MCP tool and by the session-start "Last Session"
 * deterministic surface.
 */
export function getRecentTerminations(
  db: Database,
  opts: {
    limit?: number;
    project?: string;
    excludeSessionId?: string;
  } = {},
): SessionTerminationRow[] {
  const limit = opts.limit ?? 10;
  try {
    if (opts.project && opts.excludeSessionId) {
      return cachedPrepare(
        db,
        `SELECT * FROM session_termination
         WHERE project = ? AND session_id != ?
         ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
      ).all(opts.project, opts.excludeSessionId, limit) as SessionTerminationRow[];
    }
    if (opts.project) {
      return cachedPrepare(
        db,
        `SELECT * FROM session_termination
         WHERE project = ?
         ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
      ).all(opts.project, limit) as SessionTerminationRow[];
    }
    if (opts.excludeSessionId) {
      return cachedPrepare(
        db,
        `SELECT * FROM session_termination
         WHERE session_id != ?
         ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
      ).all(opts.excludeSessionId, limit) as SessionTerminationRow[];
    }
    return cachedPrepare(
      db,
      `SELECT * FROM session_termination
       ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
    ).all(limit) as SessionTerminationRow[];
  } catch {
    return [];
  }
}
