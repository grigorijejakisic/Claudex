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

export interface OpenBlocker {
  /** wip | danger | failure (subset of session_signals.signal_type values). */
  signal_type: 'wip' | 'danger' | 'failure';
  /** File path / target string the signal pinned. */
  target: string;
  /** Free-text detail captured when the signal was raised, or null. */
  detail: string | null;
}

export interface SessionTerminationRow {
  session_id: string;
  project: string;
  ended_at_epoch_ms: number;
  end_reason: SessionEndReason;
  last_user_directive: string | null;
  last_assistant_text: string | null;
  observation_count: number;
  recorded_at_epoch_ms: number;
  /**
   * JSON-encoded array of unresolved signals at session-close time.
   * NULL on pre-V44 rows and on rows where no unresolved wip/danger/failure
   * signals existed at write time.
   */
  open_blockers: string | null;
  /**
   * Provenance flag — `true` when the row was synthesized at read time from
   * `sessions.ended_at_epoch_ms` + `sessions.status` because no real
   * `session_termination` row existed. Undefined/false on real rows.
   *
   * 2026-05-18 fresh-agent gate test exposed the value: the deterministic
   * tool was lying by omission, returning fabricated `end_reason='endsession'`
   * for derived rows. With this flag, the MCP consumer can mark output with
   * "inferred from session state" provenance so the agent doesn't get false
   * confidence from synthesized data.
   */
  derived?: boolean;
}

export interface RecordTerminationOpts {
  session_id: string;
  project: string;
  end_reason: SessionEndReason;
  last_user_directive?: string | null;
  last_assistant_text?: string | null;
  /** Override ended_at; defaults to Date.now(). */
  ended_at_epoch_ms?: number;
  /**
   * Explicit override for open_blockers JSON. When omitted (default),
   * `recordSessionTermination` queries `session_signals` for unresolved
   * wip/danger/failure signals for this session and serializes them.
   * Pass `null` to skip auto-derivation entirely.
   */
  open_blockers?: OpenBlocker[] | null;
}

/**
 * Query session_signals for unresolved wip/danger/failure signals attached
 * to a session. Used by recordSessionTermination to capture "what was
 * unfinished" at close time. Non-throwing.
 */
export function deriveOpenBlockers(db: Database, sessionId: string): OpenBlocker[] {
  try {
    const rows = cachedPrepare(
      db,
      `SELECT signal_type, target, detail
         FROM session_signals
        WHERE session_id = ?
          AND signal_type IN ('wip', 'danger', 'failure')
          AND cleared_at_epoch_ms IS NULL
          AND (expires_at_epoch_ms IS NULL OR expires_at_epoch_ms > ?)
        ORDER BY created_at_epoch_ms ASC`,
    ).all(sessionId, Date.now()) as Array<{
      signal_type: 'wip' | 'danger' | 'failure';
      target: string;
      detail: string | null;
    }>;
    return rows.map(r => ({
      signal_type: r.signal_type,
      target: r.target,
      detail: r.detail,
    }));
  } catch {
    return [];
  }
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

    // Derive open_blockers from active session_signals unless the caller
    // explicitly passed one (including `null` to skip).
    let blockersJson: string | null = null;
    if (opts.open_blockers === undefined) {
      const derived = deriveOpenBlockers(db, opts.session_id);
      blockersJson = derived.length > 0 ? JSON.stringify(derived) : null;
    } else if (opts.open_blockers !== null) {
      blockersJson = opts.open_blockers.length > 0 ? JSON.stringify(opts.open_blockers) : null;
    }

    // Detect V44 column presence — if the upgrade hasn't run on this DB,
    // fall back to the V43 INSERT shape so older DBs still get terminations.
    let hasOpenBlockers = false;
    try {
      const cols = db.prepare("PRAGMA table_info(session_termination)").all() as Array<{ name: string }>;
      hasOpenBlockers = cols.some(c => c.name === 'open_blockers');
    } catch { /* keep false */ }

    if (hasOpenBlockers) {
      cachedPrepare(
        db,
        `INSERT OR REPLACE INTO session_termination
           (session_id, project, ended_at_epoch_ms, end_reason,
            last_user_directive, last_assistant_text, observation_count, recorded_at_epoch_ms,
            open_blockers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        opts.session_id,
        opts.project,
        endedAt,
        opts.end_reason,
        truncate(opts.last_user_directive, 4000),
        truncate(opts.last_assistant_text, 4000),
        obsCount,
        Date.now(),
        blockersJson,
      );
    } else {
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
    }
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
 * Conservative regex for "operator-reported crash" markers in user_framing
 * text. Tuned against 6 known historical crash framings + sample seed of
 * recovery-prompt language. Must mention crash/died explicitly — not just
 * any failure.
 */
const CRASH_MARKER_RE = /\b(pc (cra(s|c)hed|died|crahsed)|pc (died|crashed) (over\s?night|mid|in the middle)|session (died|cra(s|c)hed|abrubptly died)|crashed (in the middle|over\s?night|mid)|killed our|got cut off|our worst fear happened|previous session died|session abrubptly died)\b/i;

// ---------------------------------------------------------------------------
// Reclassifier plugin shape
// ---------------------------------------------------------------------------

/**
 * Context handed to every Reclassifier. Carries the row's current state +
 * the DB so each classifier can run its own evidence queries.
 */
export interface ReclassifierContext {
  db: Database;
  session_id: string;
  project: string;
  ended_at_epoch_ms: number;
  current_reason: SessionEndReason;
  /** Detected timestamp column on session_events. */
  events_ts_col: string;
}

/**
 * What a classifier returns when it finds promotion evidence. Null means
 * no promotion — try the next classifier in the registry.
 */
export interface ReclassifierResult {
  new_reason: SessionEndReason;
  /** Short human-readable evidence string for telemetry / debugging. */
  evidence: string;
}

export interface Reclassifier {
  /** Identifier used in telemetry counts and tests. */
  name: string;
  /** Which `end_reason` values this classifier can transition FROM. */
  applies_to: SessionEndReason[];
  /** Examine the row's surrounding evidence; return promotion or null. */
  classify(ctx: ReclassifierContext): ReclassifierResult | null;
}

/**
 * Classifier 1: `unknown` → `crash` when the next session's first
 * user_framing event contains explicit operator-reported crash markers.
 * The canonical signal — the operator's recovery prompt is the most
 * reliable crash attestation in the substrate.
 */
const crashFromRecoveryFraming: Reclassifier = {
  name: 'crash-from-recovery-framing',
  applies_to: ['unknown'],
  classify(ctx): ReclassifierResult | null {
    const next = cachedPrepare(
      ctx.db,
      `SELECT session_id FROM sessions
        WHERE project = ? AND created_at_epoch_ms > ?
        ORDER BY created_at_epoch_ms ASC LIMIT 1`,
    ).get(ctx.project, ctx.ended_at_epoch_ms) as { session_id?: string } | undefined;
    if (!next?.session_id) return null;

    const framing = cachedPrepare(
      ctx.db,
      `SELECT detail FROM session_events
        WHERE session_id = ? AND event_type = 'user_framing'
        ORDER BY ${ctx.events_ts_col} ASC LIMIT 1`,
    ).get(next.session_id) as { detail?: string | null } | undefined;
    const detail = framing?.detail;
    if (!detail) return null;
    if (!CRASH_MARKER_RE.test(detail)) return null;

    return {
      new_reason: 'crash',
      evidence: `next-session-framing: "${detail.slice(0, 80).replace(/\s+/g, ' ')}"`,
    };
  },
};

/**
 * Classifier 2: `unknown` → `endsession` when there's a `session_end_action`
 * telemetry row for the session. That row is only written by the
 * session-end hook (or the boundary detector's fireEndOfSessionActions
 * with reason='explicit_close'), so its presence is deterministic evidence
 * that /endsession actually ran.
 *
 * Earns the plugin shape: same dispatcher, different evidence source —
 * shows the design is not crash-specific.
 */
const endsessionFromSessionEndAction: Reclassifier = {
  name: 'endsession-from-session-end-action',
  applies_to: ['unknown'],
  classify(ctx): ReclassifierResult | null {
    const row = cachedPrepare(
      ctx.db,
      `SELECT 1 AS hit FROM telemetry
        WHERE session_id = ?
          AND event_kind = 'session_end_action'
        LIMIT 1`,
    ).get(ctx.session_id) as { hit?: number } | undefined;
    if (!row?.hit) return null;
    return {
      new_reason: 'endsession',
      evidence: 'telemetry.session_end_action present',
    };
  },
};

/**
 * Reclassifier registry. Order matters — first match wins. Crash signal
 * is stronger than endsession-action presence (e.g., session-end might
 * have fired AFTER a partial crash recovery), so crash classifier runs first.
 *
 * Adding a classifier later: implement the interface, append to this array,
 * write a vitest. The dispatcher loop handles cursor + telemetry uniformly.
 */
const RECLASSIFIERS: Reclassifier[] = [
  crashFromRecoveryFraming,
  endsessionFromSessionEndAction,
];

/**
 * Result of one reconciliation pass. Surfaces per-classifier counts so the
 * telemetry row preserves attribution.
 */
export interface ReconcileResult {
  /** Total rows examined this pass (post-cursor filter). */
  scanned: number;
  /** Total rows promoted to a new reason. */
  promoted: number;
  /** Per-classifier promotion counts: { 'crash-from-recovery-framing': 3, ... } */
  by_classifier: Record<string, number>;
  /** Per-target-reason counts: { 'crash': 2, 'endsession': 1 } */
  by_new_reason: Record<string, number>;
}

/**
 * Continuous reclassification pass. Scans `session_termination` rows where
 * each registered Reclassifier's `applies_to` includes the row's current
 * end_reason, applies the first-matching classifier's promotion, updates
 * `last_reconciliation_attempt_ms` on every examined row.
 *
 * Cursor optimization (V45): rows that have a non-null
 * `last_reconciliation_attempt_ms` AND have no session created since that
 * timestamp in the same project are skipped — no new evidence to consider.
 *
 * Telemetry: when promotions > 0, writes one `reconcile_pass` telemetry row
 * with structured counts so post-hoc dashboards can spot the mechanism's
 * activity.
 *
 * Non-throwing. Returns a zero-counts result on any failure.
 *
 * Why this exists as a mechanism instead of a one-shot:
 * classification happens at WRITE time, based on whatever signal was
 * available then. But signals about a prior session emerge LATER — the
 * operator's first prompt in the recovery session is the canonical
 * deterministic crash signal, and that signal only exists AFTER the
 * recovery session starts. A one-shot backfill catches everything at one
 * moment; a continuous mechanism catches every future crash as soon as
 * the next session writes its first user_framing.
 */
export function reconcileTerminationClassifications(db: Database): ReconcileResult {
  const result: ReconcileResult = {
    scanned: 0,
    promoted: 0,
    by_classifier: {},
    by_new_reason: {},
  };
  try {
    // Detect timestamp column shape (V42 had timestamp_epoch; V43+ uses _ms).
    const evCols = (() => {
      try { return db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>; }
      catch { return []; }
    })();
    const eventsTsCol = evCols.some(c => c.name === 'timestamp_epoch_ms') ? 'timestamp_epoch_ms' : 'timestamp_epoch';

    // V45 cursor: row is "stale" (worth examining) if either
    //   (a) it's never been examined, OR
    //   (b) a session was created in the same project after the last attempt.
    // Without V45 cursor column, fall back to scanning everything (compat).
    const tCols = (() => {
      try { return db.prepare('PRAGMA table_info(session_termination)').all() as Array<{ name: string }>; }
      catch { return []; }
    })();
    const hasCursor = tCols.some(c => c.name === 'last_reconciliation_attempt_ms');

    // Build the set of from-reasons across all classifiers (dedupe).
    const fromReasons = new Set<string>();
    for (const r of RECLASSIFIERS) for (const reason of r.applies_to) fromReasons.add(reason);
    if (fromReasons.size === 0) return result;
    const reasonPlaceholders = Array.from(fromReasons).map(() => '?').join(',');

    const candidatesSql = hasCursor
      ? `SELECT session_id, project, ended_at_epoch_ms, end_reason, last_reconciliation_attempt_ms
           FROM session_termination t
          WHERE end_reason IN (${reasonPlaceholders})
            AND (
              last_reconciliation_attempt_ms IS NULL
              OR EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.project = t.project
                   AND s.created_at_epoch_ms > t.last_reconciliation_attempt_ms
              )
            )
          ORDER BY ended_at_epoch_ms ASC`
      : `SELECT session_id, project, ended_at_epoch_ms, end_reason
           FROM session_termination
          WHERE end_reason IN (${reasonPlaceholders})
          ORDER BY ended_at_epoch_ms ASC`;

    const candidates = cachedPrepare(db, candidatesSql)
      .all(...fromReasons) as Array<{
        session_id: string;
        project: string;
        ended_at_epoch_ms: number;
        end_reason: SessionEndReason;
      }>;

    if (candidates.length === 0) return result;
    result.scanned = candidates.length;

    const promote = cachedPrepare(
      db,
      `UPDATE session_termination
          SET end_reason = ?
        WHERE session_id = ?
          AND end_reason = ?`,
    );
    const stampAttempt = hasCursor
      ? cachedPrepare(
          db,
          `UPDATE session_termination
              SET last_reconciliation_attempt_ms = ?
            WHERE session_id = ?`,
        )
      : null;

    const nowMs = Date.now();
    for (const c of candidates) {
      const ctx: ReclassifierContext = {
        db,
        session_id: c.session_id,
        project: c.project,
        ended_at_epoch_ms: c.ended_at_epoch_ms,
        current_reason: c.end_reason,
        events_ts_col: eventsTsCol,
      };

      for (const classifier of RECLASSIFIERS) {
        if (!classifier.applies_to.includes(c.end_reason)) continue;
        let outcome: ReclassifierResult | null = null;
        try {
          outcome = classifier.classify(ctx);
        } catch { /* one classifier's failure must not break the pass */ }
        if (outcome) {
          const r = promote.run(outcome.new_reason, c.session_id, c.end_reason);
          if (r.changes > 0) {
            result.promoted++;
            result.by_classifier[classifier.name] = (result.by_classifier[classifier.name] ?? 0) + 1;
            result.by_new_reason[outcome.new_reason] = (result.by_new_reason[outcome.new_reason] ?? 0) + 1;
          }
          break; // first matching classifier wins
        }
      }
      // Stamp attempt regardless of whether we promoted — examined rows
      // shouldn't be re-scanned until new evidence emerges.
      if (stampAttempt) {
        try { stampAttempt.run(nowMs, c.session_id); } catch { /* non-fatal */ }
      }
    }

    // Telemetry: only on promotions to keep noise low. Scans without
    // promotions are silently OK (steady-state behavior).
    if (result.promoted > 0) {
      try {
        db.prepare(
          `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
           VALUES (?, ?, ?, ?)`,
        ).run(
          'system-reconcile',
          'reconcile_pass',
          JSON.stringify({
            scanned: result.scanned,
            promoted: result.promoted,
            by_classifier: result.by_classifier,
            by_new_reason: result.by_new_reason,
          }),
          'session-termination',
        );
      } catch { /* telemetry never escalates */ }
    }

    return result;
  } catch {
    return result;
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
  let primary: SessionTerminationRow[] = [];
  try {
    if (opts.project && opts.excludeSessionId) {
      primary = cachedPrepare(
        db,
        `SELECT * FROM session_termination
         WHERE project = ? AND session_id != ?
         ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
      ).all(opts.project, opts.excludeSessionId, limit) as SessionTerminationRow[];
    } else if (opts.project) {
      primary = cachedPrepare(
        db,
        `SELECT * FROM session_termination
         WHERE project = ?
         ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
      ).all(opts.project, limit) as SessionTerminationRow[];
    } else if (opts.excludeSessionId) {
      primary = cachedPrepare(
        db,
        `SELECT * FROM session_termination
         WHERE session_id != ?
         ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
      ).all(opts.excludeSessionId, limit) as SessionTerminationRow[];
    } else {
      primary = cachedPrepare(
        db,
        `SELECT * FROM session_termination
         ORDER BY ended_at_epoch_ms DESC LIMIT ?`,
      ).all(limit) as SessionTerminationRow[];
    }
  } catch {
    primary = [];
  }

  // Top up with derived rows from the `sessions` table when we couldn't fill
  // the requested limit from session_termination.
  //
  // Why this exists: Phase 13.1's heartbeat hang plus the fact that the V42
  // termination table is only written by the session-end / stop-failure /
  // pre-compact hooks meant the fresh-session gate test (2026-05-18) hit an
  // empty array — even though sessions.ended_at_epoch_ms had plenty of
  // signal. Without the fallback, the tool's most valuable shape ("the last
  // N sessions, why each ended") is unreachable until the heartbeat-driven
  // crash inference catches up. Derived rows give episodic answers from
  // available data while still preferring explicit session_termination rows
  // when they exist.
  if (primary.length >= limit) return primary;

  try {
    const fallback = getDerivedTerminations(db, {
      limit: limit - primary.length,
      project: opts.project,
      excludeSessionId: opts.excludeSessionId,
      excludeSessionIds: new Set(primary.map(r => r.session_id)),
    });
    return [...primary, ...fallback]
      .sort((a, b) => b.ended_at_epoch_ms - a.ended_at_epoch_ms)
      .slice(0, limit);
  } catch {
    return primary;
  }
}

/**
 * Fallback derivation: synthesize SessionTerminationRow shapes from the
 * `sessions` table for any session that has ended (ended_at_epoch_ms IS NOT
 * NULL) but doesn't have a session_termination row. Enriches with the last
 * user_framing event as `last_user_directive`. `last_assistant_text` is left
 * null — no clean derivable source.
 *
 * end_reason mapping from sessions.status (best-effort, derived):
 *   'completed'  → 'endsession'  (closed cleanly)
 *   'active'     → 'crash'       (orphaned, heartbeat-inference hasn't run)
 *   anything else / null         → 'unknown'
 *
 * Exported so the recall surface can use it directly when it wants the
 * derived view only (e.g., debugging).
 */
export function getDerivedTerminations(
  db: Database,
  opts: {
    limit: number;
    project?: string;
    excludeSessionId?: string;
    excludeSessionIds?: Set<string>;
  },
): SessionTerminationRow[] {
  const limit = Math.max(1, opts.limit);
  const params: unknown[] = [];
  const filters: string[] = [];

  if (opts.project) { filters.push('s.project = ?'); params.push(opts.project); }
  if (opts.excludeSessionId) { filters.push('s.session_id != ?'); params.push(opts.excludeSessionId); }
  filters.push('s.ended_at_epoch_ms IS NOT NULL');
  filters.push('NOT EXISTS (SELECT 1 FROM session_termination t WHERE t.session_id = s.session_id)');
  // Derived rows are best when there's actual closure signal; treat
  // ended_at_epoch_ms = 0 / NULL as "not really ended" and skip.
  filters.push('s.ended_at_epoch_ms > 0');

  const sql = `
    SELECT
      s.session_id,
      s.project,
      s.ended_at_epoch_ms,
      s.status,
      s.observation_count,
      s.session_summary
    FROM sessions s
    WHERE ${filters.join(' AND ')}
    ORDER BY s.ended_at_epoch_ms DESC
    LIMIT ?
  `;
  params.push(limit * 2); // overfetch in case excludeSessionIds drops some
  type SRow = {
    session_id: string;
    project: string;
    ended_at_epoch_ms: number;
    status: string | null;
    observation_count: number | null;
    session_summary: string | null;
  };
  const rows = (() => {
    try { return cachedPrepare(db, sql).all(...params) as SRow[]; }
    catch { return []; }
  })();

  // Detect timestamp column for user_framing fallback (V42 vs V43+).
  const tsCol = (() => {
    try {
      const cols = db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>;
      return cols.some(c => c.name === 'timestamp_epoch_ms') ? 'timestamp_epoch_ms' : 'timestamp_epoch';
    } catch { return 'timestamp_epoch_ms'; }
  })();
  const lastFramingStmt = (() => {
    try {
      return cachedPrepare(
        db,
        `SELECT detail FROM session_events
           WHERE session_id = ? AND event_type = 'user_framing'
           ORDER BY ${tsCol} DESC LIMIT 1`,
      );
    } catch { return null; }
  })();

  const out: SessionTerminationRow[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (opts.excludeSessionIds?.has(r.session_id)) continue;

    let lastUser: string | null = null;
    try {
      const f = lastFramingStmt?.get(r.session_id) as { detail?: string | null } | undefined;
      lastUser = f?.detail ?? null;
    } catch { /* skip */ }

    // Derived end_reason: be honest. `sessions.status='completed'` does NOT
    // mean operator ran /endsession — it means "no longer active." Without
    // a real termination record we don't know if it was endsession,
    // idle_close, crash, or compact. Mark `unknown` and let the `derived`
    // provenance flag tell the consumer "this is inferred, not recorded."
    //
    // The one exception: `status='active'` + we're deriving (meaning
    // inferCrashedSessions hasn't caught it) — that's most-likely-crash by
    // process of elimination. Still emit `crash` for that signal.
    let endReason: SessionEndReason = 'unknown';
    if (r.status === 'active') endReason = 'crash';

    // open_blockers — derive from session_signals at read time for
    // derived rows too. Sessions that ended without a session_termination
    // row may still have unresolved signals attached.
    let derivedBlockers: string | null = null;
    try {
      const blockers = deriveOpenBlockers(db, r.session_id);
      derivedBlockers = blockers.length > 0 ? JSON.stringify(blockers) : null;
    } catch { /* leave null */ }

    out.push({
      session_id: r.session_id,
      project: r.project,
      ended_at_epoch_ms: r.ended_at_epoch_ms,
      end_reason: endReason,
      last_user_directive: lastUser,
      // No clean derivable source — leave null.
      last_assistant_text: null,
      observation_count: r.observation_count ?? 0,
      // Synthesized derivation, not a real recorded write. Use the same ms.
      recorded_at_epoch_ms: r.ended_at_epoch_ms,
      open_blockers: derivedBlockers,
      derived: true,
    });
  }
  return out;
}
