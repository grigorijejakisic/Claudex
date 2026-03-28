/**
 * Session Transfer — SBAR-structured context packaging and injection.
 *
 * Packages a session's state for transfer to another session using the
 * SBAR framework (Situation, Background, Assessment, Recommendation)
 * with mandatory commander's intent.
 *
 * Theoretical backing:
 *   - Military OPORD: commander's intent as highest-priority element
 *   - Healthcare SBAR: structured handoff reduces adverse events 65%
 *   - I-PASS: receiver read-back for closed-loop verification
 *   - Wooldridge BDI: transfer beliefs + desires, not intentions
 *
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { estimateTokens } from '../shared/text-utils.js';
import { getActiveSignals } from './session-signals.js';

export interface SessionTransferPackage {
  intent: string;
  situation: {
    project: string | null;
    topic: string | null;
    sessionName: string | null;
    activeFiles: string[];
    activeSignals: string[];
  };
  background: {
    recentDecisions: string[];
    recentTurns: Array<{ user: string; assistant: string }>;
    keyLearnings: string[];
  };
  assessment: {
    failedApproaches: string[];
  };
  recommendation: {
    nextSteps: string[];
  };
  sourceSessionId: string;
  tokenCost: number;
}

/**
 * Package a session's context for transfer. Budget-aware greedy packing.
 */
export function packageSessionContext(
  db: Database,
  sourceSessionId: string,
  budgetTokens: number = 4000,
): SessionTransferPackage | null {
  try {
    // Get thread state for this session
    const thread = cachedPrepare(db,
      `SELECT topic, summary FROM thread_state WHERE session_id = ?`
    ).get(sourceSessionId) as { topic: string | null; summary: string | null } | undefined;

    // Get session info
    const session = cachedPrepare(db,
      `SELECT project, name, session_summary FROM sessions WHERE session_id = ?`
    ).get(sourceSessionId) as { project: string | null; name: string | null; session_summary: string | null } | undefined;

    if (!session) return null;

    const project = session.project ?? 'unknown';

    // Intent: derive from topic + summary
    const intent = thread?.summary?.slice(0, 200)
      || thread?.topic
      || session.session_summary?.slice(0, 200)
      || 'Continue work on this project';

    // Situation: active files (from pressure scores)
    const hotFiles = cachedPrepare(db,
      `SELECT file_path FROM pressure_scores
       WHERE project = ? AND raw_pressure > 0
       ORDER BY raw_pressure DESC LIMIT 10`
    ).all(project) as Array<{ file_path: string }>;

    // Active signals
    const signals = getActiveSignals(db, project, sourceSessionId);
    const signalStrs = signals.map(s => `[${s.signal_type}] ${s.target}${s.detail ? ': ' + s.detail : ''}`);

    // Background: recent decisions
    const decisions = cachedPrepare(db,
      `SELECT content FROM decisions
       WHERE session_id = ? ORDER BY timestamp_epoch DESC LIMIT 5`
    ).all(sourceSessionId) as Array<{ content: string }>;

    // Background: recent conversation turns
    const turns = cachedPrepare(db,
      `SELECT user_text, assistant_text FROM conversation_turns
       WHERE session_id = ? ORDER BY timestamp_epoch DESC LIMIT 10`
    ).all(sourceSessionId) as Array<{ user_text: string | null; assistant_text: string | null }>;

    // Assessment: failed approaches (from failure signals this session created)
    const failures = cachedPrepare(db,
      `SELECT target, detail FROM session_signals
       WHERE session_id = ? AND signal_type = 'failure'
       ORDER BY created_at_epoch DESC LIMIT 5`
    ).all(sourceSessionId) as Array<{ target: string; detail: string | null }>;

    // Recommendation: derive next steps from claimed tasks + last assistant message
    const claimedTasks = cachedPrepare(db,
      `SELECT target, detail FROM session_signals
       WHERE session_id = ? AND signal_type = 'claim' AND cleared_at_epoch IS NULL
       ORDER BY created_at_epoch DESC LIMIT 5`
    ).all(sourceSessionId) as Array<{ target: string; detail: string | null }>;

    const nextSteps: string[] = [];
    for (const c of claimedTasks) {
      nextSteps.push(`Claimed: ${c.target}${c.detail ? ' — ' + c.detail : ''}`);
    }
    // Extract "next steps" hints from the most recent assistant message
    if (turns.length > 0) {
      const lastAssistant = turns[0]?.assistant_text ?? '';
      const nextMatch = lastAssistant.match(/(?:next|then|after that|todo|remaining)[:\s]+(.{10,150})/i);
      if (nextMatch) nextSteps.push(nextMatch[1].trim());
    }

    // Build package with greedy packing
    const pkg: SessionTransferPackage = {
      intent,
      situation: {
        project,
        topic: thread?.topic ?? null,
        sessionName: session.name,
        activeFiles: hotFiles.map(f => f.file_path),
        activeSignals: signalStrs,
      },
      background: {
        recentDecisions: decisions.map(d => d.content.slice(0, 150)),
        recentTurns: [],
        keyLearnings: [],
      },
      assessment: {
        failedApproaches: failures.map(f => `${f.target}${f.detail ? ': ' + f.detail : ''}`),
      },
      recommendation: {
        nextSteps,
      },
      sourceSessionId,
      tokenCost: 0,
    };

    // Greedy pack turns until budget exhausted (hard cap)
    let used = estimateTokens(formatTransferPackage(pkg));

    // Hard cap: if base package already exceeds budget, return as-is (no turns)
    if (used <= budgetTokens) {
      for (const turn of turns.reverse()) {
        const turnText = [
          turn.user_text ? `User: ${turn.user_text.slice(0, 200)}` : '',
          turn.assistant_text ? `Assistant: ${turn.assistant_text.slice(0, 200)}` : '',
        ].filter(Boolean).join(' | ');
        const cost = estimateTokens(turnText) + 5;
        if (used + cost > budgetTokens) break;
        pkg.background.recentTurns.push({
          user: turn.user_text?.slice(0, 200) ?? '',
          assistant: turn.assistant_text?.slice(0, 200) ?? '',
        });
        used += cost;
      }
    }

    pkg.tokenCost = estimateTokens(formatTransferPackage(pkg));
    return pkg;
  } catch {
    return null;
  }
}

/**
 * Format a transfer package for injection into a session's context.
 */
export function formatTransferPackage(pkg: SessionTransferPackage): string {
  const parts: string[] = [];

  // Intent — MANDATORY, always first
  parts.push(`## Session Transfer\n**Intent:** ${pkg.intent}`);

  // Situation
  const sitParts: string[] = [];
  if (pkg.situation.project) sitParts.push(`**Project:** ${pkg.situation.project}`);
  if (pkg.situation.topic) sitParts.push(`**Topic:** ${pkg.situation.topic}`);
  if (pkg.situation.sessionName) sitParts.push(`**From session:** ${pkg.situation.sessionName}`);
  if (pkg.situation.activeFiles.length > 0) {
    sitParts.push(`**Active files:** ${pkg.situation.activeFiles.join(', ')}`);
  }
  if (pkg.situation.activeSignals.length > 0) {
    sitParts.push(`**Signals:** ${pkg.situation.activeSignals.join('; ')}`);
  }
  if (sitParts.length > 0) parts.push(`### Situation\n${sitParts.join('\n')}`);

  // Assessment — failed approaches (high value, prevents re-trying dead ends)
  if (pkg.assessment.failedApproaches.length > 0) {
    parts.push(`### Failed Approaches (do NOT retry)\n${pkg.assessment.failedApproaches.map(f => `- ${f}`).join('\n')}`);
  }

  // Background — decisions
  if (pkg.background.recentDecisions.length > 0) {
    parts.push(`### Recent Decisions\n${pkg.background.recentDecisions.map(d => `- ${d}`).join('\n')}`);
  }

  // Recommendation — next steps (the R in SBAR)
  if (pkg.recommendation.nextSteps.length > 0) {
    parts.push(`### Recommendation\n${pkg.recommendation.nextSteps.map(s => `- ${s}`).join('\n')}`);
  }

  // Background — conversation
  if (pkg.background.recentTurns.length > 0) {
    const turnLines = pkg.background.recentTurns.map(t =>
      [t.user ? `User: ${t.user}` : '', t.assistant ? `Assistant: ${t.assistant}` : '']
        .filter(Boolean).join(' | ')
    );
    parts.push(`### Recent Conversation\n${turnLines.join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Write a transfer message to session_messages for the target session.
 */
export function sendTransfer(
  db: Database,
  sourceSessionId: string,
  targetSessionId: string,
  pkg: SessionTransferPackage,
): boolean {
  try {
    const content = formatTransferPackage(pkg);
    cachedPrepare(db,
      `INSERT INTO session_messages (target_session, sender, sender_type, message_type, content, priority)
       VALUES (?, ?, 'session', 'transfer', ?, 'urgent')`
    ).run(targetSessionId, sourceSessionId, content);

    // Mark source session as transferred
    cachedPrepare(db,
      `UPDATE sessions SET status = 'transferred', transferred_to = ? WHERE session_id = ?`
    ).run(targetSessionId, sourceSessionId);

    return true;
  } catch {
    return false;
  }
}

/**
 * Write a read-back acknowledgment (I-PASS protocol).
 * The receiving session confirms what it understood.
 */
export function acknowledgeTransfer(
  db: Database,
  receiverSessionId: string,
  sourceSessionId: string,
  understanding: string,
): void {
  try {
    cachedPrepare(db,
      `INSERT INTO session_messages (target_session, sender, sender_type, message_type, content)
       VALUES (?, ?, 'session', 'acknowledge', ?)`
    ).run(sourceSessionId, receiverSessionId, `Transfer acknowledged: ${understanding}`);
  } catch { /* non-throwing */ }
}
