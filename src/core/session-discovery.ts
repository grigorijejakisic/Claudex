/**
 * Session Discovery — resolve human-friendly session references to session IDs.
 *
 * Resolution order:
 *   1. Exact name match
 *   2. Fuzzy name match (LIKE)
 *   3. Topic match (thread_state)
 *   4. Project match + recency
 *
 * Non-throwing throughout.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

export interface DiscoveredSession {
  session_id: string;
  name: string | null;
  project: string | null;
  topic: string | null;
  created_at_epoch: number;
  match_type: 'exact_name' | 'fuzzy_name' | 'topic' | 'project';
}

/**
 * Resolve a human-friendly reference to a session.
 * Accepts: session name, topic fragment, project name, or session_id.
 */
/** Escape LIKE wildcards to prevent broad/ambiguous matches. */
function escapeLike(s: string): string {
  return s.replace(/[%_]/g, '\\$&');
}

export function resolveSession(
  db: Database,
  query: string,
  excludeSessionId?: string,
): DiscoveredSession | null {
  try {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return null;
    const safeLike = escapeLike(trimmed);

    // 0. Direct session_id match (UUID format)
    if (trimmed.length > 30 && trimmed.includes('-')) {
      const direct = cachedPrepare(db,
        `SELECT s.session_id, s.name, s.project, ts.topic, s.created_at_epoch
         FROM sessions s LEFT JOIN thread_state ts ON ts.session_id = s.session_id
         WHERE s.session_id = ? AND s.status = 'active'`
      ).get(trimmed) as DiscoveredSession | undefined;
      if (direct) return { ...direct, match_type: 'exact_name' };
    }

    const exclude = excludeSessionId ?? '';

    // 1. Exact name match
    const exact = cachedPrepare(db,
      `SELECT s.session_id, s.name, s.project, ts.topic, s.created_at_epoch
       FROM sessions s LEFT JOIN thread_state ts ON ts.session_id = s.session_id
       WHERE LOWER(s.name) = ? AND s.status = 'active' AND s.session_id != ?
       ORDER BY s.created_at_epoch DESC LIMIT 1`
    ).get(trimmed, exclude) as DiscoveredSession | undefined;
    if (exact) return { ...exact, match_type: 'exact_name' };

    // 2. Fuzzy name match
    const fuzzyName = cachedPrepare(db,
      `SELECT s.session_id, s.name, s.project, ts.topic, s.created_at_epoch
       FROM sessions s LEFT JOIN thread_state ts ON ts.session_id = s.session_id
       WHERE LOWER(s.name) LIKE ? ESCAPE '\\' AND s.status = 'active' AND s.session_id != ?
       ORDER BY s.created_at_epoch DESC LIMIT 1`
    ).get(`%${safeLike}%`, exclude) as DiscoveredSession | undefined;
    if (fuzzyName) return { ...fuzzyName, match_type: 'fuzzy_name' };

    // 3. Topic match
    const topicMatch = cachedPrepare(db,
      `SELECT s.session_id, s.name, s.project, ts.topic, s.created_at_epoch
       FROM sessions s JOIN thread_state ts ON ts.session_id = s.session_id
       WHERE LOWER(ts.topic) LIKE ? ESCAPE '\\' AND s.status = 'active' AND s.session_id != ?
       ORDER BY s.created_at_epoch DESC LIMIT 1`
    ).get(`%${safeLike}%`, exclude) as DiscoveredSession | undefined;
    if (topicMatch) return { ...topicMatch, match_type: 'topic' };

    // 4. Project match
    const projectMatch = cachedPrepare(db,
      `SELECT s.session_id, s.name, s.project, ts.topic, s.created_at_epoch
       FROM sessions s LEFT JOIN thread_state ts ON ts.session_id = s.session_id
       WHERE LOWER(s.project) LIKE ? ESCAPE '\\' AND s.status = 'active' AND s.session_id != ?
       ORDER BY s.created_at_epoch DESC LIMIT 1`
    ).get(`%${safeLike}%`, exclude) as DiscoveredSession | undefined;
    if (projectMatch) return { ...projectMatch, match_type: 'project' };

    return null;
  } catch {
    return null;
  }
}

/**
 * List all active sessions with their names, topics, and projects.
 */
export function listActiveSessions(
  db: Database,
  excludeSessionId?: string,
): DiscoveredSession[] {
  try {
    const exclude = excludeSessionId ?? '';
    return cachedPrepare(db,
      `SELECT s.session_id, s.name, s.project, ts.topic, s.created_at_epoch, 'exact_name' as match_type
       FROM sessions s LEFT JOIN thread_state ts ON ts.session_id = s.session_id
       WHERE s.status = 'active' AND s.session_id != ?
       ORDER BY s.created_at_epoch DESC LIMIT 20`
    ).all(exclude) as DiscoveredSession[];
  } catch {
    return [];
  }
}

/**
 * Set or update a session's human-readable name.
 */
export function nameSession(db: Database, sessionId: string, name: string): void {
  try {
    const slug = name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 40);
    cachedPrepare(db,
      `UPDATE sessions SET name = ? WHERE session_id = ?`
    ).run(slug, sessionId);
  } catch { /* non-throwing */ }
}

/**
 * Auto-generate a session name: project-sN-pid.
 * Format: claudex-v3-s38-12345 (project + session number + PID).
 * Only sets name if the session doesn't already have one.
 */
export function autoNameSession(db: Database, sessionId: string, _topic: string): void {
  try {
    const existing = cachedPrepare(db,
      `SELECT name, project FROM sessions WHERE session_id = ?`
    ).get(sessionId) as { name: string | null; project: string | null } | undefined;

    if (existing?.name) return; // already named

    const project = existing?.project ?? 'unknown';
    // Shorten project name: "claudex-v3" from "claudex-v3", "nexus" from "nexus-e53c6c93"
    const projSlug = project.replace(/-[a-f0-9]{8}$/, '').toLowerCase()
      .replace(/[^a-z0-9-]/g, '').slice(0, 20);

    // Session number: count completed + active sessions for this project
    const sessionCount = cachedPrepare(db,
      `SELECT COUNT(*) as c FROM sessions WHERE project = ?`
    ).get(project) as { c: number };
    const num = sessionCount.c;

    const pid = process.pid;
    const name = `${projSlug}-s${num}-${pid}`;

    if (name.length >= 3) {
      cachedPrepare(db,
        `UPDATE sessions SET name = ? WHERE session_id = ?`
      ).run(name, sessionId);
    }
  } catch { /* non-throwing */ }
}
