/**
 * Artifact CRUD and lifecycle for the reference + materialization context model.
 * Plain functions with `db: Database` as first param.
 *
 * Artifacts track context items (observations, learnings, decisions, etc.)
 * with a TTL-based lifecycle: fresh -> packed -> materialized -> packed.
 * The reference layer (packed summaries) is always visible; the materialization
 * layer (full content) is query-driven.
 *
 * @see Architecture: artifact model replaces binary inclusion/exclusion cascade
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
  artifact_type: string;
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
  const result = cachedPrepare(db,
    `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance)
     VALUES (?, ?, ?, ?, ?, ?, 'fresh', 3, ?)`
  ).run(sessionId, project, artifactType, artifactRef, summary, content, importance);

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
 * Ordered by importance DESC, timestamp_epoch DESC.
 */
export function getPackedArtifacts(
  db: Database,
  project: string,
  limit?: number,
): ArtifactRow[] {
  return cachedPrepare(db,
    `SELECT * FROM artifacts
     WHERE project = ? AND state = 'packed'
     ORDER BY importance DESC, timestamp_epoch DESC
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

/**
 * Searches artifacts by summary and content text using LIKE matching.
 * Returns matching artifacts ordered by importance DESC.
 * Used for materialization selection based on prompt analysis.
 */
export function searchArtifacts(
  db: Database,
  project: string,
  query: string,
  limit?: number,
): ArtifactRow[] {
  const pattern = `%${query}%`;
  return cachedPrepare(db,
    `SELECT * FROM artifacts
     WHERE project = ?
       AND (summary LIKE ? OR content LIKE ?)
     ORDER BY importance DESC, timestamp_epoch DESC
     LIMIT ?`
  ).all(project, pattern, pattern, limit ?? 20) as ArtifactRow[];
}

/**
 * Returns total artifact count for a project.
 * Used by assembler to decide between artifact model vs legacy fallback.
 */
export function getArtifactCount(
  db: Database,
  project: string,
): number {
  const row = cachedPrepare(db,
    `SELECT COUNT(*) as cnt FROM artifacts WHERE project = ?`
  ).get(project) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}
