/**
 * Phase 4.1 /endsession lesson proposer.
 *
 * Produces 0-3 LessonProposal candidates from session telemetry. The user
 * accepts (writeLesson is called), edits (user-provided content replaces the
 * draft body), or rejects (no write; declined record kept to prevent
 * re-propose).
 *
 * Cap: 3 (CONTEXT.md). For a routine session (no salience signal), returns [].
 *
 * Process_* proposal: gated by 2-of-5 trigger rule (process-trigger.ts).
 * Max 1 process_* per session.
 *
 * Feedback_* proposal: extracted from correction events.
 *
 * Project_* proposal: extracted from decision-capture events.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';
import type { LessonType, TelemetryHandles } from './lesson-types.js';
import { evaluateProcessTriggers } from './process-trigger.js';

export interface LessonProposal {
  type: LessonType;
  proposed_slug: string;
  proposed_body: string;
  proposed_telemetry: TelemetryHandles;
  proposed_shape?: { task_shape?: string; failure_mode?: string; solution_pattern?: string };
  rationale: string;
  triggers_fired?: string[];
}

const MAX_PROPOSALS_PER_SESSION = 3;
const PROCESS_TRIGGER_THRESHOLD = 2; // 2-of-5

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'should', 'would',
  'could', 'about', 'their', 'these', 'those', 'because', 'which',
  'where', 'there', 'while', 'after', 'before',
]);

/**
 * Build telemetry handles from session telemetry.
 *
 * Deterministic — given the same session events + turns, produces the same
 * telemetry. No LLM calls.
 */
export function harvestTelemetry(db: Database, sessionId: string): TelemetryHandles {
  // tools_used: distinct tool_name from action-bearing session_events.
  // Heuristic: pull entity from event types that represent tool invocations.
  const tools = (cachedPrepare(db,
    `SELECT DISTINCT entity FROM session_events
     WHERE session_id = ?
       AND event_type IN ('file_edit', 'file_create', 'file_read', 'command', 'search', 'build', 'test_run')
       AND entity IS NOT NULL
     ORDER BY entity ASC LIMIT 50`,
  ).all(sessionId) as Array<{ entity: string }>).map(r => r.entity);

  // files_touched: from file-edit/file-create entity (entity holds the file path)
  const files = (cachedPrepare(db,
    `SELECT DISTINCT entity FROM session_events
     WHERE session_id = ?
       AND event_type IN ('file_edit', 'file_create', 'file_read')
       AND entity IS NOT NULL
     ORDER BY entity ASC LIMIT 50`,
  ).all(sessionId) as Array<{ entity: string }>).map(r => r.entity);

  // errors_encountered: tool_error / stop_failure events
  const errors = (cachedPrepare(db,
    `SELECT DISTINCT entity FROM session_events
     WHERE session_id = ?
       AND event_type IN ('tool_error', 'stop_failure')
       AND entity IS NOT NULL
     LIMIT 20`,
  ).all(sessionId) as Array<{ entity: string }>).map(r => r.entity);

  // user_framing_tokens: distinctive 5+ char content words from user_text,
  // appearing >= 2 times across user turns.
  const userTexts = (cachedPrepare(db,
    `SELECT user_text FROM conversation_turns WHERE session_id = ? AND user_text IS NOT NULL`,
  ).all(sessionId) as Array<{ user_text: string }>).map(r => r.user_text);

  const tokenCounts = new Map<string, number>();
  for (const text of userTexts) {
    for (const tok of text.toLowerCase().match(/[a-z][a-z-]{4,}/g) || []) {
      if (STOPWORDS.has(tok)) continue;
      tokenCounts.set(tok, (tokenCounts.get(tok) || 0) + 1);
    }
  }
  const userFramingTokens = Array.from(tokenCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tok]) => tok);

  // session_arc: derived from topic_shift event entity labels (if any).
  const arc = (cachedPrepare(db,
    `SELECT DISTINCT entity FROM session_events
     WHERE session_id = ? AND event_type = 'topic_shift' AND entity IS NOT NULL
     LIMIT 10`,
  ).all(sessionId) as Array<{ entity: string }>).map(r => r.entity);

  // duration_min from sessions table
  const sessionRow = cachedPrepare(db,
    `SELECT created_at_epoch_ms, ended_at_epoch_ms FROM sessions WHERE session_id = ?`,
  ).get(sessionId) as { created_at_epoch_ms: number; ended_at_epoch_ms: number | null } | undefined;
  const durationMin = sessionRow && sessionRow.ended_at_epoch_ms
    ? Math.round((sessionRow.ended_at_epoch_ms - sessionRow.created_at_epoch_ms) / 60000)
    : 0;

  // correction_count from session_events
  const correctionRow = cachedPrepare(db,
    `SELECT COUNT(*) AS cnt FROM session_events
     WHERE session_id = ? AND event_type = 'correction_detected'`,
  ).get(sessionId) as { cnt: number };

  return {
    tools_used: tools,
    files_touched: files,
    errors_encountered: errors,
    user_framing_tokens: userFramingTokens,
    session_arc: arc,
    duration_min: durationMin,
    correction_count: correctionRow.cnt,
  };
}

/**
 * Slug from a body line: lowercase, hyphenate, alphanumeric+hyphen only,
 * max 60 chars. Fallback to `lesson-<epoch_ms>` if line yields empty slug.
 */
function bodyToSlug(line: string): string {
  const slug = line.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  if (slug.length === 0) return `lesson-${Date.now()}`;
  return slug;
}

/**
 * Propose 0-3 lesson candidates for the given session.
 *
 * Returns [] for routine sessions (no correction events, no novel patterns,
 * triggers below threshold). Caller (the /endsession skill) shows nothing
 * to the user in that case.
 */
export function proposeLessonsForSession(db: Database, sessionId: string): LessonProposal[] {
  const proposals: LessonProposal[] = [];
  const telemetry = harvestTelemetry(db, sessionId);

  // ---- Feedback_* candidates from correction events ----
  let feedbackCount = 0;
  try {
    const corrections = cachedPrepare(db,
      `SELECT detail FROM session_events
       WHERE session_id = ?
         AND event_type = 'correction_detected'
         AND detail IS NOT NULL
       ORDER BY id ASC
       LIMIT 5`,
    ).all(sessionId) as Array<{ detail: string }>;

    for (const row of corrections) {
      if (feedbackCount >= 2) break;
      let directiveText: string | null = null;
      try {
        const parsed = JSON.parse(row.detail);
        directiveText = parsed.directive_text ?? parsed.text ?? parsed.message ?? null;
      } catch {
        directiveText = row.detail;
      }
      if (!directiveText || directiveText.length < 5) continue;

      const firstLine = directiveText.split('\n')[0].trim();
      const slug = bodyToSlug(firstLine);
      proposals.push({
        type: 'feedback',
        proposed_slug: slug,
        proposed_body: `# ${firstLine}\n\nUser-corrected behavior captured during session ${sessionId}.\n`,
        proposed_telemetry: telemetry,
        rationale: 'User correction detected — feedback rule candidate',
      });
      feedbackCount++;
    }
  } catch { /* non-fatal */ }

  // ---- Project_* candidates from decision events ----
  if (proposals.length < MAX_PROPOSALS_PER_SESSION - 1) {
    try {
      const decisionRow = cachedPrepare(db,
        `SELECT detail FROM session_events
         WHERE session_id = ?
           AND event_type = 'decision'
           AND detail IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`,
      ).get(sessionId) as { detail: string } | undefined;

      if (decisionRow) {
        let summary: string | null = null;
        try {
          const parsed = JSON.parse(decisionRow.detail);
          summary = parsed.summary ?? parsed.decision ?? null;
        } catch {
          summary = decisionRow.detail;
        }
        if (summary && summary.length >= 5) {
          const firstLine = summary.split('\n')[0].trim();
          proposals.push({
            type: 'project',
            proposed_slug: bodyToSlug(firstLine),
            proposed_body: `# ${firstLine}\n\nFact captured during session ${sessionId}.\n`,
            proposed_telemetry: telemetry,
            rationale: 'Decision/fact captured — project knowledge candidate',
          });
        }
      }
    } catch { /* non-fatal */ }
  }

  // ---- Process_* candidate (max 1, gated by 2-of-5) ----
  if (proposals.length < MAX_PROPOSALS_PER_SESSION) {
    const triggers = evaluateProcessTriggers(db, sessionId);
    if (triggers.fireCount >= PROCESS_TRIGGER_THRESHOLD) {
      const fired: string[] = [];
      if (triggers.corrections.fired) fired.push('corrections');
      if (triggers.framing_break.fired) fired.push('framing_break');
      if (triggers.pivots.fired) fired.push('pivots');
      if (triggers.novel_pattern.fired) fired.push('novel_pattern');
      if (triggers.long_form.fired) fired.push('long_form');

      const firedDetail: string[] = [];
      if (triggers.corrections.fired) firedDetail.push(`corrections (${triggers.corrections.detail})`);
      if (triggers.framing_break.fired) firedDetail.push(`framing_break (${triggers.framing_break.detail})`);
      if (triggers.pivots.fired) firedDetail.push(`pivots (${triggers.pivots.detail})`);
      if (triggers.novel_pattern.fired) firedDetail.push(`novel_pattern (${triggers.novel_pattern.detail})`);
      if (triggers.long_form.fired) firedDetail.push(`long_form (${triggers.long_form.detail})`);

      proposals.push({
        type: 'process',
        proposed_slug: `session-${sessionId.slice(0, 8)}-trajectory`,
        proposed_body: `# Decision trajectory for session ${sessionId.slice(0, 8)}\n\nTriggers fired:\n${firedDetail.map(s => `- ${s}`).join('\n')}\n\n## Trajectory\n\n(populate with pivots, rejected alternatives, anti-patterns surfaced)\n`,
        proposed_telemetry: { ...telemetry, triggered_by: fired },
        rationale: `Process trajectory: ${triggers.fireCount}/5 salience triggers fired`,
        triggers_fired: fired,
      });
    }
  }

  return proposals.slice(0, MAX_PROPOSALS_PER_SESSION);
}
