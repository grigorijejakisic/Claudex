/**
 * claudex projects-touched CLI — queries the DB for distinct projects touched in a session.
 *
 * Usage:
 *   node dist/cli/projects-touched.cjs [session-id]
 *
 * If session-id is omitted, finds the most recent session from the sessions table.
 *
 * Output (JSON to stdout):
 *   {
 *     "session_id": "abc-123",
 *     "projects": [
 *       {
 *         "id": "claudex-v3",
 *         "observation_count": 42,
 *         "decision_count": 5,
 *         "files": ["src/foo.ts", "src/bar.ts"]
 *       }
 *     ]
 *   }
 *
 * Exit 0 on success, 1 on error (no DB, no session found).
 * Errors go to stderr; structured JSON goes to stdout.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import { cachedPrepare } from '../core/stmt-cache.js';
import { resolveProjectPath } from '../shared/scope-detector.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ProjectTouched {
  id: string;
  path: string | null;
  observation_count: number;
  decision_count: number;
  files: string[];
}

export interface ProjectsTouchedResult {
  session_id: string;
  projects: ProjectTouched[];
}

// ── DB queries ───────────────────────────────────────────────────────

/**
 * Finds the most recent session ID from the sessions table.
 * Returns null if no sessions exist.
 */
export function findLatestSessionId(db: Database.Database): string | null {
  try {
    const row = cachedPrepare(db,
      'SELECT session_id FROM sessions ORDER BY created_at_epoch DESC LIMIT 1')
      .get() as { session_id: string } | undefined;
    return row ? row.session_id : null;
  } catch (err) {
    throw new Error(
      `Failed to query sessions table: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Verifies a session ID exists in the sessions table.
 * Returns false if the session is not found.
 */
export function sessionExists(db: Database.Database, sessionId: string): boolean {
  try {
    const row = cachedPrepare(db,
      'SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { 1: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Queries observations grouped by project for a session.
 * Returns a map of project → count.
 */
export function queryObservationsByProject(
  db: Database.Database,
  sessionId: string
): Map<string, number> {
  const rows = cachedPrepare(db,
      'SELECT project, COUNT(*) as count FROM observations WHERE session_id = ? GROUP BY project')
    .all(sessionId) as Array<{ project: string | null; count: number }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    const project = row.project ?? '__global__';
    map.set(project, row.count);
  }
  return map;
}

/**
 * Queries decisions grouped by project for a session.
 * Returns a map of project → count.
 */
export function queryDecisionsByProject(
  db: Database.Database,
  sessionId: string
): Map<string, number> {
  const rows = cachedPrepare(db,
      'SELECT project, COUNT(*) as count FROM decisions WHERE session_id = ? GROUP BY project')
    .all(sessionId) as Array<{ project: string | null; count: number }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    const project = row.project ?? '__global__';
    map.set(project, row.count);
  }
  return map;
}

/**
 * Queries all files_modified for a given project in a session.
 * Parses the JSON array field, flattens, and deduplicates.
 * Handles malformed/empty JSON gracefully.
 */
export function queryFilesForProject(
  db: Database.Database,
  sessionId: string,
  project: string
): string[] {
  const rows = cachedPrepare(db,
      'SELECT files_modified FROM observations WHERE session_id = ? AND project = ? AND files_modified IS NOT NULL')
    .all(sessionId, project) as Array<{ files_modified: string }>;

  const fileSet = new Set<string>();
  for (const row of rows) {
    const raw = row.files_modified;
    if (!raw || raw.trim() === '') continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const f of parsed) {
          if (typeof f === 'string' && f.trim() !== '') {
            fileSet.add(f.trim());
          }
        }
      }
    } catch {
      // Malformed JSON — skip silently
    }
  }

  return Array.from(fileSet).sort();
}

// ── Core logic ───────────────────────────────────────────────────────

/**
 * Main query logic. Opens the DB, resolves the session, and returns structured result.
 * Exported for testability.
 */
export function queryProjectsTouched(
  db: Database.Database,
  sessionId: string
): ProjectsTouchedResult {
  const obsByProject = queryObservationsByProject(db, sessionId);
  const decByProject = queryDecisionsByProject(db, sessionId);

  // Union of all projects that appear in either observations or decisions
  const allProjects = new Set<string>([...obsByProject.keys(), ...decByProject.keys()]);

  const projects: ProjectTouched[] = [];
  for (const projectId of Array.from(allProjects).sort()) {
    const observationCount = obsByProject.get(projectId) ?? 0;
    const decisionCount = decByProject.get(projectId) ?? 0;
    const files = observationCount > 0
      ? queryFilesForProject(db, sessionId, projectId)
      : [];

    projects.push({
      id: projectId,
      path: projectId === '__global__' ? null : resolveProjectPath(projectId),
      observation_count: observationCount,
      decision_count: decisionCount,
      files,
    });
  }

  return { session_id: sessionId, projects };
}

/**
 * Opens the DB, resolves session, runs queries, returns result.
 * Throws on fatal errors (DB open failure, session not found).
 */
export function run(dbPath: string, sessionIdArg: string | null): ProjectsTouchedResult {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    throw new Error(
      `Could not open database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    let sessionId: string;

    if (sessionIdArg) {
      if (!sessionExists(db, sessionIdArg)) {
        throw new Error(`Session not found: ${sessionIdArg}`);
      }
      sessionId = sessionIdArg;
    } else {
      const latest = findLatestSessionId(db);
      if (!latest) {
        throw new Error('No sessions found in database');
      }
      sessionId = latest;
    }

    return queryProjectsTouched(db, sessionId);
  } finally {
    try { db.close(); } catch { /* non-throwing */ }
  }
}

// ── Entry point ──────────────────────────────────────────────────────

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].includes('projects-touched') || process.argv[1].endsWith('projects-touched.cjs'));

if (isDirectExecution) {
  try {
    const dbPath = getDbPath();
    const sessionIdArg = process.argv[2] ?? null;

    const result = run(dbPath, sessionIdArg);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `projects-touched error: ${err instanceof Error ? err.message : 'Unknown error'}\n`
    );
    process.exit(1);
  }
}
