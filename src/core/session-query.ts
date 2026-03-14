/**
 * DB-first session context queries — replaces bulk file loading for session init.
 * Composes existing CRUD functions to produce a concise session context summary.
 * All public functions are non-throwing.
 * @see Architecture Section 3.2 (session-start), Section 7 (assembly)
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { getTopLearnings } from './learnings.js';
import { getThreadState } from './thread.js';
import {
  getDecisionsBySession,
  getDecisionsByProject,
  type DecisionRow,
} from './decisions.js';

/** Concise session context derived from DB — replaces file loading. */
export interface SessionContext {
  /** Project identifier. */
  project: string | null;
  /** Scope (repo path). */
  scope: string | null;

  /** Thread topic from thread_state. */
  threadTopic: string | null;
  /** Thread summary from thread_state. */
  threadSummary: string | null;

  /** Latest session summary (from thread_state of most recent prior session). */
  lastSummary: string | null;

  /** Recent decisions (from decisions table). */
  recentDecisions: Array<{ content: string; source: string; timestamp_epoch: number }>;

  /** Top learnings by promotion count. */
  topLearnings: Array<{ content: string; use_count: number }>;
}

/** Options for getSessionContext query limits. */
export interface SessionContextOptions {
  decisionLimit?: number;
  learningLimit?: number;
}

/**
 * Queries the DB for session context — replaces bulk file loading.
 * Composes thread state, decisions, and learnings into a single context object.
 * Non-throwing: returns safe defaults on any error.
 */
export function getSessionContext(
  db: Database,
  project: string,
  sessionId?: string,
  options?: SessionContextOptions,
): SessionContext {
  const defaults: SessionContext = {
    project,
    scope: null,
    threadTopic: null,
    threadSummary: null,
    lastSummary: null,
    recentDecisions: [],
    topLearnings: [],
  };

  try {
    // Thread state (current session)
    if (sessionId) {
      try {
        const thread = getThreadState(db, sessionId);
        if (thread) {
          defaults.threadTopic = thread.topic;
          defaults.threadSummary = thread.summary;
        }
      } catch { /* non-fatal */ }
    }

    // Session scope
    if (sessionId) {
      try {
        const row = cachedPrepare(
          db,
          'SELECT scope FROM sessions WHERE session_id = ?',
        ).get(sessionId) as { scope: string | null } | undefined;
        if (row?.scope) {
          defaults.scope = row.scope;
        }
      } catch { /* non-fatal */ }
    }

    // Latest prior session summary (from thread_state of most recent completed session)
    try {
      const latest = getLatestSession(db, project);
      if (latest && latest.summary) {
        defaults.lastSummary = latest.summary;
      }
    } catch { /* non-fatal */ }

    // Recent decisions — prefer session-scoped if sessionId given, else project-scoped
    const decisionLimit = options?.decisionLimit ?? 5;
    try {
      let decisions: DecisionRow[];
      if (sessionId) {
        decisions = getDecisionsBySession(db, sessionId, { limit: decisionLimit });
      } else {
        decisions = getDecisionsByProject(db, project).slice(0, decisionLimit);
      }
      defaults.recentDecisions = decisions.map((d) => ({
        content: d.content,
        source: d.source,
        timestamp_epoch: d.timestamp_epoch,
      }));
    } catch { /* non-fatal */ }

    // Top learnings
    const learningLimit = options?.learningLimit ?? 10;
    try {
      const learnings = getTopLearnings(db, project, learningLimit);
      defaults.topLearnings = learnings.map((l) => ({
        content: l.content,
        use_count: l.promotion_count,
      }));
    } catch { /* non-fatal */ }

    return defaults;
  } catch {
    return defaults;
  }
}

/**
 * Renders session context as a concise markdown injection string.
 * Target: under 500 tokens (~350-450 typical).
 */
export function renderSessionContextSummary(ctx: SessionContext): string {
  const lines: string[] = [];
  lines.push('## Session Context (from DB)');

  // Topic
  if (ctx.threadTopic) {
    lines.push(`**Topic**: ${ctx.threadTopic}`);
  }

  // Last session
  if (ctx.lastSummary) {
    lines.push(`**Last session**: ${truncate(ctx.lastSummary, 120)}`);
  } else {
    lines.push('**Last session**: no prior sessions');
  }

  // Thread summary
  if (ctx.threadSummary) {
    lines.push(`**Thread**: ${truncate(ctx.threadSummary, 120)}`);
  }

  // Decisions
  if (ctx.recentDecisions.length > 0) {
    lines.push(`**Key decisions** (last ${ctx.recentDecisions.length}):`);
    for (const d of ctx.recentDecisions) {
      lines.push(`- [${d.source}] ${truncate(d.content, 100)}`);
    }
  }

  // Learnings
  if (ctx.topLearnings.length > 0) {
    lines.push(`**Active learnings**: ${ctx.topLearnings.length} learnings loaded`);
  }

  return lines.join('\n');
}

/**
 * Returns the most recent completed or active session for a project.
 * Used for session continuity — finding the previous session's thread state.
 * Non-throwing: returns null on error or if no sessions exist.
 */
export function getLatestSession(
  db: Database,
  project: string,
): {
  sessionId: string;
  createdAt: number;
  summary: string | null;
} | null {
  try {
    // Find the most recent session for this project (any status)
    const row = cachedPrepare(
      db,
      `SELECT s.session_id, s.created_at_epoch, t.summary
       FROM sessions s
       LEFT JOIN thread_state t ON s.session_id = t.session_id
       WHERE s.project = ?
       ORDER BY s.created_at_epoch DESC
       LIMIT 1`,
    ).get(project) as
      | { session_id: string; created_at_epoch: number; summary: string | null }
      | undefined;

    if (!row) return null;

    return {
      sessionId: row.session_id,
      createdAt: row.created_at_epoch,
      summary: row.summary,
    };
  } catch {
    return null;
  }
}

/** Truncates a string to maxLen, appending ellipsis if needed. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
