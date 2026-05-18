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
  name: string | null;
  files_editing: string[];
  recent_tools: string[];
  topic: string | null;
  observation_count: number;
  last_activity_epoch_ms: number;
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
    const oneHourAgoMs = Date.now() - 3600000;

    // Single query: sessions + topic + last activity (was 1 + 4×N = 21 queries)
    const sessions = cachedPrepare(db,
      `SELECT s.session_id, s.name, s.observation_count,
              t.topic,
              MAX(o.timestamp_epoch_ms) AS last_activity_epoch_ms
       FROM sessions s
       JOIN observations o ON o.session_id = s.session_id
       LEFT JOIN thread_state t ON t.session_id = s.session_id
       WHERE s.project = ? AND s.session_id != ? AND s.status = 'active'
         AND o.timestamp_epoch_ms > ?
       GROUP BY s.session_id
       ORDER BY last_activity_epoch_ms DESC
       LIMIT 5`
    ).all(project, currentSessionId, oneHourAgoMs) as Array<{
      session_id: string; name: string | null; observation_count: number;
      topic: string | null; last_activity_epoch_ms: number;
    }>;

    if (sessions.length === 0) return [];

    // Batch query: files and tools for ALL sessions at once (was N×2 queries)
    const sessionIds = sessions.map(s => s.session_id);
    const placeholders = sessionIds.map(() => '?').join(',');

    const filesRows = db.prepare(
      `SELECT o.session_id, json_each.value as file_path
       FROM observations o, json_each(o.files_modified)
       WHERE o.session_id IN (${placeholders})
         AND o.tool_name IN ('Edit', 'Write')
         AND o.timestamp_epoch_ms > ?
         AND json_each.value != ''`
    ).all(...sessionIds, oneHourAgoMs) as Array<{ session_id: string; file_path: string }>;

    const toolsRows = db.prepare(
      `SELECT DISTINCT session_id, tool_name FROM observations
       WHERE session_id IN (${placeholders})
         AND timestamp_epoch_ms > ?`
    ).all(...sessionIds, oneHourAgoMs) as Array<{ session_id: string; tool_name: string }>;

    // Group by session
    const filesMap = new Map<string, string[]>();
    const toolsMap = new Map<string, string[]>();
    for (const r of filesRows) {
      const arr = filesMap.get(r.session_id) ?? [];
      if (!arr.includes(r.file_path)) arr.push(r.file_path);
      filesMap.set(r.session_id, arr);
    }
    for (const r of toolsRows) {
      const arr = toolsMap.get(r.session_id) ?? [];
      arr.push(r.tool_name);
      toolsMap.set(r.session_id, arr);
    }

    return sessions.map(s => ({
      session_id: s.session_id,
      name: s.name,
      files_editing: (filesMap.get(s.session_id) ?? []).slice(0, 10),
      recent_tools: (toolsMap.get(s.session_id) ?? []).slice(0, 10),
      topic: s.topic,
      observation_count: s.observation_count,
      last_activity_epoch_ms: s.last_activity_epoch_ms,
    }));
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
    const fiveMinAgoMs = Date.now() - 300000;

    // Single query: find files edited by BOTH the current session AND other active sessions.
    // Replaces per-file N+1 queries with one JOIN-based query.
    const rows = db.prepare(
      `SELECT my.file_path, other.session_id
       FROM (
         SELECT DISTINCT jf.value AS file_path
         FROM observations o, json_each(o.files_modified) jf
         WHERE o.session_id = ?
           AND o.tool_name IN ('Edit', 'Write')
           AND o.timestamp_epoch_ms > ?
           AND jf.value != ''
       ) my
       JOIN observations o2 ON 1=1
       JOIN json_each(o2.files_modified) jf2 ON jf2.value = my.file_path
       JOIN sessions s ON s.session_id = o2.session_id
       WHERE o2.session_id != ?
         AND s.status = 'active'
         AND s.project = ?
         AND o2.tool_name IN ('Edit', 'Write')
         AND o2.timestamp_epoch_ms > ?`
    ).all(currentSessionId, fiveMinAgoMs, currentSessionId, project, fiveMinAgoMs) as Array<{
      file_path: string; session_id: string;
    }>;

    // Group by file path
    const conflictMap = new Map<string, Set<string>>();
    for (const r of rows) {
      const sessions = conflictMap.get(r.file_path) ?? new Set([currentSessionId]);
      sessions.add(r.session_id);
      conflictMap.set(r.file_path, sessions);
    }

    return Array.from(conflictMap.entries()).map(([file_path, sessions]) => ({
      file_path,
      sessions: [...sessions],
    }));
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
      const ago = Math.floor((Date.now() - a.last_activity_epoch_ms) / 60_000);
      const label = a.name ?? `session-${a.session_id.substring(0, 8)}`;
      parts.push(`- **${label}**${topicStr}${filesStr} — ${ago}m ago`);
    }
  }

  return parts.join('\n');
}
