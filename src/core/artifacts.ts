/**
 * Artifact CRUD and lifecycle for the reference + materialization context model.
 * Plain functions with `db: Database` as first param.
 *
 * Artifacts track context items (observations, learnings, decisions, etc.)
 * with a TTL-based lifecycle: fresh -> packed -> materialized -> packed.
 * The reference layer (packed summaries) is always visible; the materialization
 * layer (full content) is query-driven.
 *

 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

/** Artifact lifecycle states. */
export type ArtifactState = 'fresh' | 'packed' | 'materialized';

/** Valid artifact type discriminators. */
export type ArtifactType = 'observation' | 'learning' | 'decision' | 'hot_file' | 'flow' | 'milestone';

/** Row shape returned from artifact queries. */
export interface ArtifactRow {
  id: number;
  session_id: string;
  project: string;
  artifact_type: ArtifactType;
  artifact_ref: string | null;
  summary: string;
  content: string | null;
  state: ArtifactState;
  ttl: number;
  importance: number;
  timestamp_epoch: number;
  last_materialized_epoch: number | null;
}

/**
 * Creates an artifact. Returns the inserted row id.
 * TTL defaults to 3 for fresh artifacts.
 */
export function createArtifact(
  db: Database,
  sessionId: string,
  project: string,
  artifactType: ArtifactType,
  artifactRef: string | null,
  summary: string,
  content: string | null,
  importance: number,
): number {
  // TTL scales with importance — high-signal artifacts stay visible longer.
  // Each tick happens at ~120s intervals, so TTL=6 ≈ 12 minutes of visibility.
  const ttl = importance >= 5 ? 8 : importance >= 4 ? 6 : 4;

  const result = cachedPrepare(db,
    `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance)
     VALUES (?, ?, ?, ?, ?, ?, 'fresh', ?, ?)`
  ).run(sessionId, project, artifactType, artifactRef, summary, content, ttl, importance);

  return Number(result.lastInsertRowid);
}

/**
 * Retrieves artifacts for a project with optional filtering by state and/or type.
 * Ordered by importance DESC, timestamp_epoch DESC.
 * Default limit: 100.
 */
export function getArtifactsByProject(
  db: Database,
  project: string,
  opts?: { state?: ArtifactState; type?: ArtifactType; limit?: number },
): ArtifactRow[] {
  const limit = opts?.limit ?? 100;

  if (opts?.state && opts?.type) {
    return cachedPrepare(db,
      `SELECT * FROM artifacts
       WHERE project = ? AND state = ? AND artifact_type = ?
       ORDER BY importance DESC, timestamp_epoch DESC
       LIMIT ?`
    ).all(project, opts.state, opts.type, limit) as ArtifactRow[];
  }

  if (opts?.state) {
    return cachedPrepare(db,
      `SELECT * FROM artifacts
       WHERE project = ? AND state = ?
       ORDER BY importance DESC, timestamp_epoch DESC
       LIMIT ?`
    ).all(project, opts.state, limit) as ArtifactRow[];
  }

  if (opts?.type) {
    return cachedPrepare(db,
      `SELECT * FROM artifacts
       WHERE project = ? AND artifact_type = ?
       ORDER BY importance DESC, timestamp_epoch DESC
       LIMIT ?`
    ).all(project, opts.type, limit) as ArtifactRow[];
  }

  return cachedPrepare(db,
    `SELECT * FROM artifacts
     WHERE project = ?
     ORDER BY importance DESC, timestamp_epoch DESC
     LIMIT ?`
  ).all(project, limit) as ArtifactRow[];
}

/**
 * Returns packed artifacts for the reference layer.
 * These provide metadata-only listings of available context.
 * Sorted by type priority (decision > learning > observation) then importance.
 * This ensures architectural decisions and cross-session learnings always
 * appear above routine tool observations in the reference layer.
 */
export function getPackedArtifacts(
  db: Database,
  project: string,
  limit?: number,
): ArtifactRow[] {
  return cachedPrepare(db,
    `SELECT * FROM artifacts
     WHERE project = ? AND state = 'packed'
     ORDER BY
       CASE artifact_type
         WHEN 'decision' THEN 0
         WHEN 'learning' THEN 1
         WHEN 'flow' THEN 2
         WHEN 'milestone' THEN 3
         WHEN 'hot_file' THEN 4
         WHEN 'observation' THEN 5
         ELSE 6
       END,
       importance DESC,
       timestamp_epoch DESC
     LIMIT ?`
  ).all(project, limit ?? 100) as ArtifactRow[];
}

/**
 * Returns materialized artifacts (full content visible).
 * Ordered by importance DESC, timestamp_epoch DESC.
 */
export function getMaterializedArtifacts(
  db: Database,
  project: string,
): ArtifactRow[] {
  return cachedPrepare(db,
    `SELECT * FROM artifacts
     WHERE project = ? AND state IN ('fresh', 'materialized')
     ORDER BY importance DESC, timestamp_epoch DESC`
  ).all(project) as ArtifactRow[];
}

/**
 * Materializes specific artifacts by ID — sets state to 'materialized', TTL to 2,
 * and records the materialization timestamp.
 */
export function materializeArtifacts(
  db: Database,
  artifactIds: number[],
): void {
  if (artifactIds.length === 0) return;

  const stmt = cachedPrepare(db,
    `UPDATE artifacts
     SET state = 'materialized', ttl = 2, last_materialized_epoch = unixepoch()
     WHERE id = ?`
  );

  for (const id of artifactIds) {
    stmt.run(id);
  }
}

/**
 * Decrements TTL for all non-packed artifacts in a project.
 * When TTL reaches 0, the artifact is packed (state='packed', content preserved in DB
 * but excluded from materialization layer).
 * Called at turn boundaries.
 * Returns count of newly packed artifacts and total affected.
 */
export function tickArtifactTTL(
  db: Database,
  project: string,
): { packed: number; total: number } {
  // Decrement TTL for all non-packed artifacts
  const decremented = cachedPrepare(db,
    `UPDATE artifacts
     SET ttl = ttl - 1
     WHERE project = ? AND state != 'packed' AND ttl > 0`
  ).run(project);

  // Pack artifacts whose TTL just hit 0
  const packed = cachedPrepare(db,
    `UPDATE artifacts
     SET state = 'packed'
     WHERE project = ? AND state != 'packed' AND ttl <= 0`
  ).run(project);

  return { packed: packed.changes, total: decremented.changes };
}

/**
 * Packs all non-packed artifacts for a project. Used during compaction.
 * Returns count of artifacts packed.
 */
export function packAllArtifacts(
  db: Database,
  project: string,
): number {
  const result = cachedPrepare(db,
    `UPDATE artifacts
     SET state = 'packed', ttl = 0
     WHERE project = ? AND state != 'packed'`
  ).run(project);

  return result.changes;
}

/** Stop words for keyword extraction in artifact search. */
const SEARCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'these',
  'those', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'my', 'your',
  'let', 'just', 'now', 'so', 'if', 'but', 'or', 'and', 'not', 'no',
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'whom',
]);

/**
 * Searches artifacts using a two-stage strategy:
 * 1. FTS5 search on observations_fts → find observation IDs → match via artifact_ref
 * 2. Fallback: keyword LIKE matching on artifact summary
 * Returns matching artifacts ordered by importance DESC.
 */
export function searchArtifacts(
  db: Database,
  project: string,
  query: string,
  limit?: number,
): ArtifactRow[] {
  if (!query || query.length < 3) return [];

  const maxResults = limit ?? 10;

  // Stage 1: FTS5 search on observations → artifact_ref join
  try {
    // Extract keywords for FTS query
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !SEARCH_STOP_WORDS.has(w));

    if (keywords.length > 0) {
      const ftsQuery = keywords.join(' OR ');
      const ftsResults = cachedPrepare(db,
        `SELECT a.* FROM artifacts a
         INNER JOIN observations_fts fts ON CAST(a.artifact_ref AS INTEGER) = fts.rowid
         WHERE a.project = ? AND a.artifact_type = 'observation'
           AND observations_fts MATCH ?
         ORDER BY a.importance DESC, a.timestamp_epoch DESC
         LIMIT ?`
      ).all(project, ftsQuery, maxResults) as ArtifactRow[];

      if (ftsResults.length > 0) return ftsResults;
    }
  } catch {
    // FTS may fail on invalid query syntax — fall through to keyword search
  }

  // Stage 2: Keyword LIKE fallback for non-observation artifacts and FTS failures
  try {
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !SEARCH_STOP_WORDS.has(w))
      .slice(0, 5);

    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => '(LOWER(summary) LIKE ?)').join(' OR ');
    const params = keywords.map(k => `%${k}%`);

    return cachedPrepare(db,
      `SELECT * FROM artifacts
       WHERE project = ? AND (${conditions})
       ORDER BY importance DESC, timestamp_epoch DESC
       LIMIT ?`
    ).all(project, ...params, maxResults) as ArtifactRow[];
  } catch {
    return [];
  }
}

