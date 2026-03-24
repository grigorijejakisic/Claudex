/**
 * Angel Message Sender — writes to session_messages for delivery to active sessions.
 *
 * The Angel communicates with sessions through the session_messages table.
 * UserPromptSubmit hook reads pending messages and injects them into context.
 *
 * Non-throwing — all operations silently fail on error.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

export type MessageType = 'event' | 'command' | 'query' | 'advisory';
export type MessagePriority = 'normal' | 'urgent' | 'advisory';

/**
 * Send a message to a specific session (delivered on next UserPromptSubmit).
 */
export function sendMessage(
  db: Database,
  targetSession: string,
  content: string,
  messageType: MessageType = 'advisory',
  priority: MessagePriority = 'normal',
): boolean {
  try {
    cachedPrepare(db,
      `INSERT INTO session_messages (target_session, sender, message_type, content, priority)
       VALUES (?, 'angel', ?, ?, ?)`
    ).run(targetSession, messageType, content, priority);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all pending (undelivered) messages for a session.
 * Used by UserPromptSubmit hook to inject Angel messages.
 */
export function getPendingMessages(
  db: Database,
  sessionId: string,
): Array<{ id: number; content: string; message_type: string; priority: string }> {
  try {
    return cachedPrepare(db,
      `SELECT id, content, message_type, priority
       FROM session_messages
       WHERE target_session = ? AND delivered_at_epoch IS NULL
       ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         created_at_epoch ASC
       LIMIT 5`
    ).all(sessionId) as Array<{ id: number; content: string; message_type: string; priority: string }>;
  } catch {
    return [];
  }
}

/**
 * Mark messages as delivered (after UserPromptSubmit injects them).
 */
export function markMessagesDelivered(
  db: Database,
  messageIds: number[],
): void {
  if (messageIds.length === 0) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE session_messages SET delivered_at_epoch = ?
       WHERE id IN (${placeholders})`
    ).run(now, ...messageIds);
  } catch {
    // Non-throwing
  }
}

/**
 * Send idle session warning to a session.
 */
export function sendIdleWarning(
  db: Database,
  sessionId: string,
  idleMinutes: number,
  topic: string | null,
): boolean {
  const topicStr = topic ? ` (topic: ${topic})` : '';
  const content = `Session has been idle for ${idleMinutes} minutes${topicStr}. Consider running \`/endsession\` to preserve state and free resources.`;
  return sendMessage(db, sessionId, content, 'advisory', 'advisory');
}
