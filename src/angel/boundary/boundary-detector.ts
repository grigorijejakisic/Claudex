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
import { recordSessionEndAction } from '../../observability/telemetry.js';

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

// ---------------------------------------------------------------------------
// Phase 14 Plan 14-05 — Single-owner session-end promotion
// ---------------------------------------------------------------------------

export type SessionEndReason = 'idle_terminated' | 'crash_recovered' | 'explicit_close';

/**
 * Single-owner session-end promotion.
 *
 * Idempotent: returns early if the session is already completed.
 * On promotion: writes status + ended_at_epoch_ms (using Date.now() — ms precision,
 * NOT Math.floor(Date.now() / 1000)), then fires the ordered action chain via
 * fireEndOfSessionActions.
 *
 * CRITICAL: This is the SOLE writer of sessions.status='completed' for TERMINATED
 * sessions. No other code path should write status='completed' for idle/dead sessions.
 * The clean_endsession path (session-end-close-marker.ts) is the separate gate
 * for explicit operator-driven closes and is not managed here.
 *
 * Caller (heartbeat) invokes this when boundary-detector decides the session
 * is TERMINATED. The idempotency guard prevents double-promotion on repeated
 * TERMINATED detections across heartbeat ticks.
 */
export async function promoteSessionToCompleted(
  db: Database,
  sessionId: string,
  reason: SessionEndReason,
): Promise<void> {
  // Idempotency check — check if actions have already been fired for this session.
  // We track this by presence of a 'session_summary' session_end_action telemetry row.
  const actionsFired = db.prepare(
    `SELECT 1 FROM telemetry
     WHERE session_id = ? AND event_kind = 'session_end_action'
       AND json_extract(detail, '$.action') = 'session_summary'
     LIMIT 1`
  ).get(sessionId);
  if (actionsFired) return; // Already promoted — idempotency guard

  // Check status to decide whether we need to write it or just fire actions.
  const existing = db.prepare(
    `SELECT status, ended_at_epoch_ms FROM sessions WHERE session_id = ?`
  ).get(sessionId) as { status: string; ended_at_epoch_ms: number | null } | undefined;

  let endedAt: number;
  if (existing?.status === 'completed' && existing.ended_at_epoch_ms != null) {
    // Status already written (e.g., by cursor.ts commitBoundaryTick) — only fire actions.
    endedAt = existing.ended_at_epoch_ms;
  } else {
    // Write status='completed' + ended_at_epoch_ms (ms-precision, NOT Math.floor(Date.now()/1000)).
    endedAt = Date.now();
    db.prepare(
      `UPDATE sessions SET status = 'completed', ended_at_epoch_ms = ? WHERE session_id = ?`
    ).run(endedAt, sessionId);
  }

  await fireEndOfSessionActions(db, sessionId, endedAt, reason);
}

/**
 * Fire the 5 ordered end-of-session actions with per-action try/catch isolation
 * and per-action telemetry (event_kind='session_end_action').
 *
 * Action order (per plan 14-05 must_haves.truths):
 *   1. session_summary write (if absent — preserves existing summaries)
 *   2. final pattern-extractor pass (one-shot, idempotent on already-extracted)
 *   3. highlights extraction (triggered explicitly, not opportunistically)
 *   4. MEMORY.md regeneration (curateMemoryMd)
 *   5. lesson-pointer index update (ensure new lesson files are registered)
 *
 * Each action:
 *   - Runs in its own try/catch: failure of action N does NOT abort N+1..5.
 *   - Records a telemetry row with outcome ∈ {'ok','failed','skipped'} + metadata.
 *   - Is idempotent (e.g., saveSessionSummary is upsert; curateMemoryMd has
 *     sentinel guard; ensurePointerId is INSERT OR IGNORE).
 */
export async function fireEndOfSessionActions(
  db: Database,
  sessionId: string,
  endedAt: number,
  reason: SessionEndReason,
): Promise<void> {
  // Determine project for this session (needed by multiple actions).
  const sessRow = db.prepare(
    `SELECT project FROM sessions WHERE session_id = ?`
  ).get(sessionId) as { project: string } | undefined;
  const project = sessRow?.project ?? '__global__';

  // --- Action 1: session_summary write ---
  const a1Start = Date.now();
  let a1Outcome: 'ok' | 'failed' | 'skipped' = 'ok';
  let a1Error: string | undefined;
  let a1Skip: string | undefined;
  try {
    const { getSessionEvents, synthesizeSessionSummary, saveSessionSummary } =
      await import('../../core/session-events.js');
    // Check if summary already exists (preserve existing).
    const existing = db.prepare(
      `SELECT session_summary FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { session_summary: string | null } | undefined;
    if (existing?.session_summary) {
      a1Outcome = 'skipped';
      a1Skip = 'summary_already_exists';
    } else {
      const events = getSessionEvents(db, sessionId);
      const summary = synthesizeSessionSummary(events);
      if (summary) {
        saveSessionSummary(db, sessionId, summary);
      } else {
        a1Outcome = 'skipped';
        a1Skip = 'no_events_to_summarize';
      }
    }
  } catch (err) {
    a1Outcome = 'failed';
    a1Error = (err as Error).message?.slice(0, 300);
  }
  recordSessionEndAction(db, {
    session_id: sessionId,
    action: 'session_summary',
    outcome: a1Outcome,
    duration_ms: Date.now() - a1Start,
    reason,
    error_message: a1Error,
    skip_reason: a1Skip,
  });

  // --- Action 2: final pattern-extractor pass ---
  const a2Start = Date.now();
  let a2Outcome: 'ok' | 'failed' | 'skipped' = 'ok';
  let a2Error: string | undefined;
  try {
    const { extractDirectivesFromSession } = await import('../../intelligence/directive-detector.js');
    const { classifySessionDomains } = await import('../domain-classifier.js');
    // Both are idempotent: directive-detector has its own cursor;
    // classifySessionDomains is content-deterministic.
    await extractDirectivesFromSession(db, sessionId, project);
    await classifySessionDomains(db, sessionId, project);
  } catch (err) {
    a2Outcome = 'failed';
    a2Error = (err as Error).message?.slice(0, 300);
  }
  recordSessionEndAction(db, {
    session_id: sessionId,
    action: 'pattern_extraction',
    outcome: a2Outcome,
    duration_ms: Date.now() - a2Start,
    reason,
    error_message: a2Error,
  });

  // --- Action 3: highlights extraction ---
  const a3Start = Date.now();
  let a3Outcome: 'ok' | 'failed' | 'skipped' = 'ok';
  let a3Error: string | undefined;
  let a3Skip: string | undefined;
  try {
    const { extractHighlightsForSession } = await import('../highlights-extractor.js');
    const { getRegisteredProjectDirs } = await import('../sessions-indexer.js');
    // Resolve projectDir for this session's project.
    const dirs = getRegisteredProjectDirs();
    const entry = dirs.find(d => d.projectId === project);
    if (!entry) {
      a3Outcome = 'skipped';
      a3Skip = 'no_sessions_file';
    } else {
      // Check if a Sessions/ file exists for this session.
      const sessionsDir = (await import('node:path')).join(entry.projectDir, 'Sessions');
      let hasFile = false;
      try {
        const files = (await import('node:fs')).readdirSync(sessionsDir);
        hasFile = files.some((f: string) => f.endsWith(`_${sessionId}.md`));
      } catch { /* directory missing — treat as no file */ }
      if (!hasFile) {
        a3Outcome = 'skipped';
        a3Skip = 'no_sessions_file';
      } else {
        // Load config from environment — highlights-extractor needs it for localModel.
        const { loadConfig } = await import('../../shared/config.js');
        const config = loadConfig();
        await extractHighlightsForSession({
          db,
          sessionId,
          project,
          projectDir: entry.projectDir,
          config,
        });
      }
    }
  } catch (err) {
    a3Outcome = 'failed';
    a3Error = (err as Error).message?.slice(0, 300);
  }
  recordSessionEndAction(db, {
    session_id: sessionId,
    action: 'highlights_extraction',
    outcome: a3Outcome,
    duration_ms: Date.now() - a3Start,
    reason,
    error_message: a3Error,
    skip_reason: a3Skip,
  });

  // --- Action 4: MEMORY.md regeneration ---
  const a4Start = Date.now();
  let a4Outcome: 'ok' | 'failed' | 'skipped' = 'ok';
  let a4Error: string | undefined;
  let a4Skip: string | undefined;
  try {
    const { curateMemoryMd } = await import('../memory-md-writer.js');
    const result = curateMemoryMd(db, project);
    if (!result.written && result.reason === 'no_project_dir') {
      a4Outcome = 'skipped';
      a4Skip = 'no_project_dir';
    }
  } catch (err) {
    a4Outcome = 'failed';
    a4Error = (err as Error).message?.slice(0, 300);
  }
  recordSessionEndAction(db, {
    session_id: sessionId,
    action: 'memory_md_regeneration',
    outcome: a4Outcome,
    duration_ms: Date.now() - a4Start,
    reason,
    error_message: a4Error,
    skip_reason: a4Skip,
  });

  // --- Action 5: lesson-pointer index update ---
  const a5Start = Date.now();
  let a5Outcome: 'ok' | 'failed' | 'skipped' = 'ok';
  let a5Error: string | undefined;
  let a5Skip: string | undefined;
  try {
    const { listLessonsForProject } = await import('../lesson-reader.js');
    const { ensurePointerId } = await import('../pointer-recall.js');
    const lessons = listLessonsForProject(project);
    if (lessons.length === 0) {
      a5Outcome = 'skipped';
      a5Skip = 'no_lesson_files';
    } else {
      for (const lesson of lessons) {
        ensurePointerId(db, project, lesson.filename, 'lesson');
      }
    }
  } catch (err) {
    a5Outcome = 'failed';
    a5Error = (err as Error).message?.slice(0, 300);
  }
  recordSessionEndAction(db, {
    session_id: sessionId,
    action: 'lesson_pointer_update',
    outcome: a5Outcome,
    duration_ms: Date.now() - a5Start,
    reason,
    error_message: a5Error,
    skip_reason: a5Skip,
  });
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
