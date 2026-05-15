/**
 * Phase 6 EBD-04 / EBD-06 — boundary detector sweep loop.
 *
 * Single export: runBoundaryTick(db, thresholds, opts?).
 *
 * On each tick:
 *   1. Find candidate sessions (active OR cursor.last_close_event_id IS NULL),
 *      bounded by LIMIT 25, ordered oldest-jsonl-first.
 *   2. For each candidate (per-session try/catch — one bad session never
 *      blocks others):
 *        a. Resolve PID + isPidAlive
 *        b. If cursor has last_close_event_id (already closed, NON-clean),
 *           branch to RE-OPEN handling: within T_reopen + fresh JSONL → emit
 *           re_opened env event + flip status='active' + cursor reset; beyond
 *           T_reopen → episode_reopen_anomaly telemetry, no state change.
 *        c. If session has clean_endsession close marker → skip (hook owns it).
 *        d. Otherwise classifySession + commitBoundaryTick.
 *   3. Cursor offset overflow recovery: cursor.last_processed_jsonl_offset >
 *      fs size → resetCursor with 'offset_overflow' reason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isPidAlive } from './pid-liveness.js';
import { classifySession, type SessionLivenessRow } from './composition-rule.js';
import { commitBoundaryTick, resetCursor, loadCursor } from './cursor.js';
import type { BoundaryThresholds } from './thresholds.js';

const DEFAULT_SWEEP_LIMIT = 25;

export interface BoundaryTickResult {
  candidates: number;
  closesEmitted: number;
  closesAborted: number;
  reopensEmitted: number;
  reopensAnomalous: number;
  cursorReplays: number;
  perSessionErrors: number;
}

export interface BoundaryTickOptions {
  /** Override now (epoch seconds). Tests use this. */
  now?: number;
  /** Override projects root (defaults to ~/.claude/projects). Tests use this. */
  projectsRoot?: string;
  /** Override sweep LIMIT. Defaults to 25. */
  limit?: number;
  /** Pid resolver — caller may override (defaults to sessions.adapter / null). */
  resolvePid?: (sessionRow: { session_id: string; project: string; adapter: string | null }) => number | null;
}

interface CandidateRow {
  session_id: string;
  project: string;
  status: string;
  created_at_epoch_ms: number;
  ended_at_epoch_ms: number | null;
  adapter: string | null;
  last_heartbeat_ts: number | null;
  last_jsonl_write_ts: number | null;
  last_processed_jsonl_offset: number | null;
  last_processed_event_ts_epoch: number | null;
  last_close_event_id: number | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function jsonlPathFor(projectsRoot: string, project: string, sessionId: string): string {
  return path.join(projectsRoot, project, `${sessionId}.jsonl`);
}

function checkOffsetOverflow(
  db: Database,
  projectsRoot: string,
  c: CandidateRow,
): boolean {
  if (c.last_processed_jsonl_offset === null || c.last_processed_jsonl_offset <= 0) return false;
  const filePath = jsonlPathFor(projectsRoot, c.project, c.session_id);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false; // file missing — separate concern; not offset_overflow
  }
  if (c.last_processed_jsonl_offset > stat.size) {
    resetCursor(db, c.project, c.session_id, 'offset_overflow');
    return true;
  }
  return false;
}

function emitReopenEvent(
  db: Database,
  c: CandidateRow,
  now: number,
  gapSeconds: number,
): void {
  const tx = db.transaction(() => {
    const content = `Episode re-opened after gap of ${gapSeconds}s`;
    const contentHash = sha256(`${content}:${c.session_id}:${now}`);
    db.prepare(
      `INSERT INTO episodic_events
         (session_id, project, turn_number, type, source, content,
          provenance, parent_event_id, content_hash, metadata_json)
       VALUES (?, ?, NULL, 'environmental_event', 'angel-boundary', ?,
               'environmental', NULL, ?,
               json_object(
                 're_opened',           json('true'),
                 'gap_seconds',         ?,
                 'prior_close_event_id', ?
               ))`
    ).run(c.session_id, c.project, content, contentHash, gapSeconds, c.last_close_event_id);
    db.prepare(
      `UPDATE sessions SET status = 'active', ended_at_epoch_ms = NULL WHERE session_id = ?`
    ).run(c.session_id);
    db.prepare(
      `INSERT INTO episode_boundary_cursor
         (project, session_id, last_processed_jsonl_offset,
          last_processed_event_ts_epoch, last_close_event_id)
       VALUES (
         ?, ?,
         COALESCE((SELECT last_processed_jsonl_offset FROM episode_boundary_cursor
                   WHERE project = ? AND session_id = ?), 0),
         ?, NULL
       )
       ON CONFLICT(project, session_id) DO UPDATE SET
         last_processed_event_ts_epoch = excluded.last_processed_event_ts_epoch,
         last_close_event_id           = NULL`
    ).run(c.project, c.session_id, c.project, c.session_id, now);
  });
  tx();
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, 'episode_reopen', json_object('project',?,'gap_seconds',?), 'angel-boundary')`
    ).run(c.session_id, c.project, gapSeconds);
  } catch { /* CHECK enum may not admit; swallow */ }
}

function emitReopenAnomaly(db: Database, c: CandidateRow, gapSeconds: number): void {
  try {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, 'episode_reopen_anomaly', json_object('project',?,'gap_seconds',?), 'angel-boundary')`
    ).run(c.session_id, c.project, gapSeconds);
  } catch { /* CHECK enum may not admit; swallow */ }
}

function recordPerSessionError(db: Database, sessionId: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
       VALUES (?, 'episodic_write_failure',
               json_object('hook','boundary-detector','error_message',?),
               'angel-boundary')`
    ).run(sessionId, message.slice(0, 500));
  } catch { /* swallow */ }
}

function isCleanEndsession(db: Database, closeEventId: number | null): boolean {
  if (closeEventId === null) return false;
  const ev = db.prepare(
    `SELECT metadata_json FROM episodic_events WHERE id = ?`
  ).get(closeEventId) as { metadata_json: string | null } | undefined;
  if (!ev?.metadata_json) return false;
  return ev.metadata_json.includes('"clean_endsession"');
}

export function runBoundaryTick(
  db: Database,
  thresholds: BoundaryThresholds,
  opts: BoundaryTickOptions = {},
): BoundaryTickResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const projectsRoot = opts.projectsRoot ?? path.join(homedir(), '.claude', 'projects');
  const limit = opts.limit ?? DEFAULT_SWEEP_LIMIT;
  const resolvePid = opts.resolvePid;

  const result: BoundaryTickResult = {
    candidates: 0,
    closesEmitted: 0,
    closesAborted: 0,
    reopensEmitted: 0,
    reopensAnomalous: 0,
    cursorReplays: 0,
    perSessionErrors: 0,
  };

  // Candidate filter:
  //   - Active sessions (need possible close).
  //   - Sessions with a non-clean prior close marker AND fresher JSONL than
  //     the close ts (potential re-open within or beyond T_reopen).
  // We deliberately INCLUDE completed sessions whose cursor has a close
  // marker AND whose last_jsonl_write_ts > last_processed_event_ts_epoch
  // — those are the re-open / anomaly candidates. Sessions with NO cursor
  // row OR with cursor.last_close_event_id IS NULL but status='active' also
  // qualify (first-time close detection).
  const candidates = db.prepare(
    `SELECT s.session_id, s.project, s.status, s.created_at_epoch_ms, s.ended_at_epoch_ms,
            s.adapter, s.last_heartbeat_ts, s.last_jsonl_write_ts,
            c.last_processed_jsonl_offset,
            c.last_processed_event_ts_epoch,
            c.last_close_event_id
       FROM sessions s
       LEFT JOIN episode_boundary_cursor c
         ON c.project = s.project AND c.session_id = s.session_id
      WHERE s.status = 'active'
         OR c.last_close_event_id IS NULL
         OR (c.last_close_event_id IS NOT NULL
             AND s.last_jsonl_write_ts IS NOT NULL
             AND s.last_jsonl_write_ts > COALESCE(c.last_processed_event_ts_epoch, 0))
      ORDER BY COALESCE(s.last_jsonl_write_ts, 0) ASC, s.session_id ASC
      LIMIT ?`
  ).all(limit) as CandidateRow[];

  result.candidates = candidates.length;

  for (const c of candidates) {
    try {
      if (checkOffsetOverflow(db, projectsRoot, c)) {
        result.cursorReplays += 1;
      }

      const pid = resolvePid
        ? resolvePid({ session_id: c.session_id, project: c.project, adapter: c.adapter })
        : null;
      const pidAlive = pid !== null && isPidAlive(pid);

      // RE-OPEN branch — non-clean prior close, possibly resumable
      if (c.last_close_event_id !== null) {
        if (isCleanEndsession(db, c.last_close_event_id)) {
          continue; // hook-driven close; do not reopen
        }
        if (c.last_jsonl_write_ts === null) continue;
        const closeTs = c.last_processed_event_ts_epoch ?? 0;
        const gapSeconds = Math.max(0, c.last_jsonl_write_ts - closeTs);
        if (c.last_jsonl_write_ts > closeTs) {
          if (gapSeconds <= thresholds.tReopen) {
            emitReopenEvent(db, c, now, gapSeconds);
            result.reopensEmitted += 1;
          } else {
            emitReopenAnomaly(db, c, gapSeconds);
            result.reopensAnomalous += 1;
          }
        }
        continue;
      }

      const livenessRow: SessionLivenessRow = {
        session_id: c.session_id,
        project: c.project,
        pid,
        pid_alive: pidAlive,
        last_heartbeat_ts: c.last_heartbeat_ts,
        last_jsonl_write_ts: c.last_jsonl_write_ts,
        has_clean_endsession: false,
      };
      const cls = classifySession(now, livenessRow, thresholds);

      if (cls.state === 'alive' || cls.state === 'dormant') continue;
      if (cls.close_reason === 'clean_endsession') continue;

      const durationSeconds = c.created_at_epoch_ms
        ? Math.max(0, now - Math.floor(c.created_at_epoch_ms / 1000))
        : 0;

      const out = commitBoundaryTick(db, {
        project: c.project,
        sessionId: c.session_id,
        jsonlOffset: c.last_processed_jsonl_offset ?? 0,
        lastEventTsEpoch: now,
        closeMarker: {
          reason: cls.close_reason,
          detectionSnapshot: {
            last_heartbeat_ts: c.last_heartbeat_ts,
            last_jsonl_write_ts: c.last_jsonl_write_ts,
          },
          metadata: {
            duration_seconds: durationSeconds,
            event_count: 0,
            pid_alive: pidAlive,
            last_heartbeat_ts: c.last_heartbeat_ts,
            last_jsonl_write_ts: c.last_jsonl_write_ts,
          },
        },
      });
      if (out.closeEmitted) result.closesEmitted += 1;
      if (out.closeAborted) result.closesAborted += 1;
    } catch (err) {
      result.perSessionErrors += 1;
      recordPerSessionError(db, c.session_id, err);
    }
  }

  return result;
}
