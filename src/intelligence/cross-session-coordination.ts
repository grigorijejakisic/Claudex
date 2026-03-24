/**
 * Cross-session coordination via shared DB observations (BossCat pattern).
 *
 * Instead of explicit message passing, agents coordinate by querying what
 * other active sessions have done. The DB is the coordination layer.
 *
 * All functions are non-throwing — return empty arrays on error.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../core/stmt-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossSessionActivity {
  session_id: string;
  files_editing: string[];
  recent_tools: string[];
  topic: string | null;
  observation_count: number;
  last_activity_epoch: number;
}

// ---------------------------------------------------------------------------
// Cross-session awareness
// ---------------------------------------------------------------------------

/**
 * Returns what other active sessions are working on in the same project.
 * Enables conflict detection (two sessions editing the same file) and
 * coordination (don't duplicate work another session is doing).
 *
 * "Active" = session status is 'active' and has observations within the last hour.
 */
export function getCrossSessionActivity(
  db: Database,
  project: string,
  currentSessionId: string,
): CrossSessionActivity[] {
  try {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    // Find other active sessions with recent activity
    const sessions = cachedPrepare(db,
      `SELECT s.session_id, s.observation_count, MAX(o.timestamp_epoch) AS last_obs
       FROM sessions s
       JOIN observations o ON o.session_id = s.session_id
       WHERE s.project = ? AND s.session_id != ? AND s.status = 'active'
         AND o.timestamp_epoch > ?
       GROUP BY s.session_id
       ORDER BY last_obs DESC
       LIMIT 5`
    ).all(project, currentSessionId, oneHourAgo) as Array<{ session_id: string; observation_count: number }>;

    return sessions.map(s => {
      // Get files being edited
      const files = cachedPrepare(db,
        `SELECT DISTINCT json_each.value as file_path
         FROM observations, json_each(observations.files_modified)
         WHERE observations.session_id = ?
           AND observations.tool_name IN ('Edit', 'Write')
           AND observations.timestamp_epoch > ?
           AND json_each.value != ''
         LIMIT 10`
      ).all(s.session_id, oneHourAgo) as Array<{ file_path: string }>;

      // Get recent tool usage pattern
      const tools = cachedPrepare(db,
        `SELECT DISTINCT tool_name FROM observations
         WHERE session_id = ? AND timestamp_epoch > ?
         LIMIT 10`
      ).all(s.session_id, oneHourAgo) as Array<{ tool_name: string }>;

      // Get topic
      const thread = cachedPrepare(db,
        `SELECT topic FROM thread_state WHERE session_id = ?`
      ).get(s.session_id) as { topic: string | null } | undefined;

      // Get last activity time
      const lastObs = cachedPrepare(db,
        `SELECT MAX(timestamp_epoch) as last_epoch FROM observations WHERE session_id = ?`
      ).get(s.session_id) as { last_epoch: number | null };

      return {
        session_id: s.session_id,
        files_editing: files.map(f => f.file_path),
        recent_tools: tools.map(t => t.tool_name),
        topic: thread?.topic ?? null,
        observation_count: s.observation_count,
        last_activity_epoch: lastObs?.last_epoch ?? 0,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Detects file conflicts — files being edited by multiple active sessions.
 * Returns a list of conflicting file paths with the session IDs touching them.
 */
export function detectFileConflicts(
  db: Database,
  project: string,
  currentSessionId: string,
): Array<{ file_path: string; sessions: string[] }> {
  try {
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;

    // Get files this session has edited recently
    const myFiles = cachedPrepare(db,
      `SELECT DISTINCT json_each.value as file_path
       FROM observations, json_each(observations.files_modified)
       WHERE observations.session_id = ?
         AND observations.tool_name IN ('Edit', 'Write')
         AND observations.timestamp_epoch > ?
         AND json_each.value != ''`
    ).all(currentSessionId, fiveMinAgo) as Array<{ file_path: string }>;

    if (myFiles.length === 0) return [];

    const conflicts: Array<{ file_path: string; sessions: string[] }> = [];

    for (const { file_path } of myFiles) {
      // Check if any OTHER active session also edited this file recently
      const others = cachedPrepare(db,
        `SELECT DISTINCT o.session_id
         FROM observations o, json_each(o.files_modified) jf
         JOIN sessions s ON s.session_id = o.session_id
         WHERE jf.value = ?
           AND o.session_id != ?
           AND s.status = 'active'
           AND s.project = ?
           AND o.tool_name IN ('Edit', 'Write')
           AND o.timestamp_epoch > ?`
      ).all(file_path, currentSessionId, project, fiveMinAgo) as Array<{ session_id: string }>;

      if (others.length > 0) {
        conflicts.push({
          file_path,
          sessions: [currentSessionId, ...others.map(o => o.session_id)],
        });
      }
    }

    return conflicts;
  } catch {
    return [];
  }
}

/**
 * Formats cross-session activity for assembly injection.
 * Returns null if no other sessions are active.
 */
export function formatCrossSessionAwareness(
  activities: CrossSessionActivity[],
  conflicts: Array<{ file_path: string; sessions: string[] }>,
): string | null {
  if (activities.length === 0 && conflicts.length === 0) return null;

  const parts: string[] = [];

  if (conflicts.length > 0) {
    parts.push('## File Conflicts Detected');
    for (const c of conflicts) {
      parts.push(`- **${c.file_path}** — edited by ${c.sessions.length} sessions`);
    }
    parts.push('');
  }

  if (activities.length > 0) {
    parts.push('## Other Active Sessions');
    for (const a of activities) {
      const filesStr = a.files_editing.length > 0
        ? ` editing: ${a.files_editing.slice(0, 3).join(', ')}`
        : '';
      const topicStr = a.topic ? ` (${a.topic})` : '';
      const ago = Math.floor((Date.now() / 1000 - a.last_activity_epoch) / 60);
      parts.push(`- Session ${a.session_id.substring(0, 8)}${topicStr}${filesStr} — ${ago}m ago`);
    }
  }

  return parts.join('\n');
}
