/**
 * Session events — structured event capture for cross-session thread reconstruction.
 *
 * Captures lightweight events from PostToolUse (file edits, test runs, builds)
 * and synthesizes them into a session summary at session end.
 *
 * All functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export type EventType = 'file_edit' | 'file_create' | 'file_delete' | 'test_run' | 'build' | 'decision' | 'error' | 'topic_shift';

export interface SessionEvent {
  id: number;
  session_id: string;
  project: string;
  event_type: EventType;
  entity: string;
  action: string;
  detail: string | null;
  timestamp_epoch: number;
}

/**
 * Records a session event. Non-throwing.
 */
export function recordEvent(
  db: Database,
  sessionId: string,
  project: string,
  eventType: EventType,
  entity: string,
  action: string,
  detail?: string,
): void {
  try {
    cachedPrepare(db,
      `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, project, eventType, entity, action, detail ?? null);
  } catch {
    // Non-throwing
  }
}

/**
 * Retrieves events for a session, ordered by time.
 */
export function getSessionEvents(
  db: Database,
  sessionId: string,
): SessionEvent[] {
  try {
    return cachedPrepare(db,
      `SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp_epoch`
    ).all(sessionId) as SessionEvent[];
  } catch {
    return [];
  }
}

/**
 * Retrieves the most recent session's events for a project.
 */
export function getLastSessionEvents(
  db: Database,
  project: string,
): SessionEvent[] {
  try {
    const session = cachedPrepare(db,
      `SELECT session_id FROM sessions
       WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 1`
    ).get(project) as { session_id: string } | undefined;

    if (!session) return [];
    return getSessionEvents(db, session.session_id);
  } catch {
    return [];
  }
}

/**
 * Synthesizes session events into a human-readable summary.
 * Returns null if no events exist.
 */
export function synthesizeSessionSummary(events: SessionEvent[]): string | null {
  if (!events || events.length === 0) return null;

  const fileEdits = new Map<string, number>();
  const fileCreates: string[] = [];
  const testRuns: { passed: number; failed: number } = { passed: 0, failed: 0 };
  const builds: { success: number; error: number } = { success: 0, error: 0 };
  const decisions: string[] = [];
  const topics: string[] = [];

  for (const e of events) {
    switch (e.event_type) {
      case 'file_edit':
        fileEdits.set(e.entity, (fileEdits.get(e.entity) ?? 0) + 1);
        break;
      case 'file_create':
        fileCreates.push(e.entity);
        break;
      case 'test_run':
        if (e.action === 'passed') testRuns.passed++;
        else testRuns.failed++;
        break;
      case 'build':
        if (e.action === 'success') builds.success++;
        else builds.error++;
        break;
      case 'decision':
        if (e.detail) decisions.push(e.detail.slice(0, 80));
        break;
      case 'topic_shift':
        topics.push(e.entity);
        break;
    }
  }

  const parts: string[] = [];

  if (fileEdits.size > 0) {
    const top = [...fileEdits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f, n]) => n > 1 ? `${f} (${n}x)` : f);
    parts.push(`edited ${top.join(', ')}`);
  }

  if (fileCreates.length > 0) {
    parts.push(`created ${fileCreates.slice(0, 3).join(', ')}${fileCreates.length > 3 ? ` +${fileCreates.length - 3} more` : ''}`);
  }

  if (testRuns.passed + testRuns.failed > 0) {
    const total = testRuns.passed + testRuns.failed;
    parts.push(`ran tests (${total}x, ${testRuns.failed > 0 ? `${testRuns.failed} failed` : 'all pass'})`);
  }

  if (builds.success + builds.error > 0) {
    parts.push(`built (${builds.error > 0 ? `${builds.error} errors` : 'clean'})`);
  }

  if (decisions.length > 0) {
    parts.push(`decided: ${decisions.slice(0, 2).join('; ')}`);
  }

  if (topics.length > 0) {
    parts.push(`topics: ${topics.join(' → ')}`);
  }

  return parts.length > 0 ? parts.join(', ') + '.' : null;
}

/**
 * Saves a pre-computed session summary to the sessions table.
 * Non-throwing.
 */
export function saveSessionSummary(db: Database, sessionId: string, summary: string): void {
  try {
    cachedPrepare(db,
      `UPDATE sessions SET session_summary = ? WHERE session_id = ?`
    ).run(summary, sessionId);
  } catch {
    // Non-throwing
  }
}

/**
 * Reads the pre-computed session summary for the last session.
 */
export function getLastSessionSummary(db: Database, project: string): string | null {
  try {
    const row = cachedPrepare(db,
      `SELECT session_summary FROM sessions
       WHERE project = ? AND session_summary IS NOT NULL
       ORDER BY created_at_epoch DESC LIMIT 1`
    ).get(project) as { session_summary: string } | undefined;
    return row?.session_summary ?? null;
  } catch {
    return null;
  }
}

/**
 * Extracts events from PostToolUse data.
 * Called by the hook after observation extraction.
 * Returns events to record (caller persists via recordEvent).
 */
export function extractEventsFromToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput?: Record<string, unknown>,
): Array<{ type: EventType; entity: string; action: string; detail?: string }> {
  const events: Array<{ type: EventType; entity: string; action: string; detail?: string }> = [];

  const filePath = String(toolInput?.file_path ?? toolInput?.path ?? '');

  switch (toolName) {
    case 'Edit':
      if (filePath) events.push({ type: 'file_edit', entity: filePath, action: 'modified' });
      break;
    case 'Write':
      if (filePath) events.push({ type: 'file_create', entity: filePath, action: 'created' });
      break;
    case 'Bash': {
      const cmd = String(toolInput?.command ?? '');
      const output = String(toolOutput?.output ?? toolOutput?.stdout ?? '');

      // Test detection
      if (/\b(vitest|jest|test|spec)\b/i.test(cmd)) {
        const failed = /fail|error|FAIL/i.test(output) && !/0 failed/i.test(output);
        events.push({ type: 'test_run', entity: cmd.slice(0, 100), action: failed ? 'failed' : 'passed' });
      }

      // Build detection
      if (/\b(build|compile|tsc)\b/i.test(cmd)) {
        const errored = /error|Error|ERR/i.test(output);
        events.push({ type: 'build', entity: cmd.slice(0, 100), action: errored ? 'error' : 'success' });
      }
      break;
    }
  }

  return events;
}
