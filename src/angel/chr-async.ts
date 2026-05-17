/**
 * CHR (Continuous Handoff Refresh) async queue — Phase 14-08.
 *
 * Replaces the synchronous Stop-hook call to `classifyTurnAsDecisionBoundary`
 * with an enqueue → Angel-drain pattern. With the Claude subprocess backend
 * taking ~10-15s per classification (Haiku), per-turn-sync would make every
 * turn-end visibly laggy. Async resolves that without losing the qualitative
 * gate: the 60s throttle on `handoff_refresh_state` already means CHR is
 * effectively per-minute, not per-turn. A ~10s drain delay sits well inside.
 *
 * Lifecycle:
 *   1. Stop hook: `enqueueChrClassification(...)` writes a row.
 *   2. Angel heartbeat: `drainChrQueue(...)` pulls up to N unprocessed rows,
 *      runs classifyTurnAsDecisionBoundary (which respects the 60s throttle),
 *      and marks each row processed.
 *   3. Retention: rows older than CHR_RETENTION_MS are GC'd by `sweepChrQueue`.
 *
 * Failure handling:
 *   - LLM failure → row marked processed with attempt_count++ and last_error set.
 *     The 60s throttle still keeps the loop bounded; permanent failures don't
 *     keep retrying because every row is processed exactly once.
 *   - Throttled (within 60s of a prior refresh) → row marked processed with
 *     attempt_count=0, last_error='throttled'. This is correct behavior, not
 *     a failure — the prior refresh already captured the recent state.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import {
  classifyTurnAsDecisionBoundary,
  type WatcherContext,
  type WatcherResult,
} from './handoff-decision-watcher.js';

/** Max rows drained per heartbeat tick. Bounds wall-clock per drain. */
const DRAIN_BATCH_SIZE = 10;

/** Retention: drop processed rows older than this. */
const CHR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface EnqueueChrOpts {
  db: Database;
  session_id: string;
  project: string;
  user_text: string | null;
  assistant_text: string;
  source_turn_uuid: string;
}

export interface ChrEnqueueResult {
  enqueued: boolean;
  row_id: number;
}

/**
 * Stop-hook entry point. Writes a pending row; returns immediately.
 * Non-throwing — hook completion must not depend on the queue.
 */
export function enqueueChrClassification(opts: EnqueueChrOpts): ChrEnqueueResult {
  // Operator override — CHR fully disabled. Don't enqueue.
  if (process.env['CLAUDEX_CHR_DISABLED'] === '1') {
    return { enqueued: false, row_id: 0 };
  }
  try {
    const result = cachedPrepare(
      opts.db,
      `INSERT INTO chr_pending_classifications
         (session_id, project, user_text, assistant_text, source_turn_uuid)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      opts.session_id,
      opts.project,
      opts.user_text,
      opts.assistant_text,
      opts.source_turn_uuid,
    );
    return { enqueued: true, row_id: Number(result.lastInsertRowid) };
  } catch {
    return { enqueued: false, row_id: 0 };
  }
}

export interface DrainChrResult {
  /** Rows attempted. */
  drained: number;
  /** Rows that produced a boundary refresh. */
  refreshed: number;
  /** Rows that returned no-boundary or were throttled. */
  no_boundary: number;
  /** Rows where the LLM call failed. */
  errors: number;
}

/**
 * Drain up to DRAIN_BATCH_SIZE oldest unprocessed rows. Each row is run
 * through `classifyTurnAsDecisionBoundary` and marked processed. Called
 * from Angel's heartbeat between Phase 2 and Phase 3.
 *
 * Non-throwing per row — one bad row never poisons the batch.
 */
export async function drainChrQueue(db: Database): Promise<DrainChrResult> {
  const result: DrainChrResult = { drained: 0, refreshed: 0, no_boundary: 0, errors: 0 };

  // Operator override — fully disabled.
  if (process.env['CLAUDEX_CHR_DISABLED'] === '1') {
    return result;
  }

  type Row = {
    id: number;
    session_id: string;
    project: string;
    user_text: string | null;
    assistant_text: string;
    source_turn_uuid: string;
    attempt_count: number;
  };

  let rows: Row[];
  try {
    rows = cachedPrepare(
      db,
      `SELECT id, session_id, project, user_text, assistant_text, source_turn_uuid, attempt_count
       FROM chr_pending_classifications
       WHERE processed_at_epoch_ms IS NULL
       ORDER BY enqueued_at_epoch_ms ASC
       LIMIT ?`,
    ).all(DRAIN_BATCH_SIZE) as Row[];
  } catch {
    return result;
  }

  const markProcessed = cachedPrepare(
    db,
    `UPDATE chr_pending_classifications
     SET processed_at_epoch_ms = (unixepoch() * 1000),
         attempt_count = attempt_count + 1,
         last_error = ?
     WHERE id = ?`,
  );

  for (const row of rows) {
    result.drained++;
    let outcome: WatcherResult | null = null;
    let errorMsg: string | null = null;
    try {
      const ctx: WatcherContext = {
        db,
        project: row.project,
        session_id: row.session_id,
        user_text: row.user_text,
        assistant_text: row.assistant_text,
        source_turn_uuid: row.source_turn_uuid,
      };
      outcome = await classifyTurnAsDecisionBoundary(ctx);
    } catch (e) {
      errorMsg = (e as Error).message?.slice(0, 200) ?? 'unknown';
      result.errors++;
    }

    if (outcome) {
      if (outcome.refreshed) result.refreshed++;
      else result.no_boundary++;
      if (outcome.throttled) errorMsg = 'throttled';
    }

    try {
      markProcessed.run(errorMsg, row.id);
    } catch {
      // If we can't mark processed, the row is retried next tick. Bounded
      // by attempt_count for diagnostic, but the loop never blocks.
    }
  }

  return result;
}

/**
 * GC processed rows older than CHR_RETENTION_MS. Called from Angel's
 * retention sweep. Returns row count deleted.
 */
export function sweepChrQueue(db: Database): number {
  try {
    const cutoff = Date.now() - CHR_RETENTION_MS;
    const result = cachedPrepare(
      db,
      `DELETE FROM chr_pending_classifications
       WHERE processed_at_epoch_ms IS NOT NULL AND processed_at_epoch_ms < ?`,
    ).run(cutoff);
    return result.changes;
  } catch {
    return 0;
  }
}
