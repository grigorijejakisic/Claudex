/**
 * sqlite-vec backend — mirrors the Qdrant client API using vec0 virtual tables.
 *
 * Phase 2 of the Qdrant → sqlite-vec migration (see
 * context/specs/SQLITE_VEC_MIGRATION.md). This file provides a one-to-one
 * implementation of qdrant-client.ts's public API, backed by the vec_*
 * virtual tables created in V14→V15. It does NOT change any caller —
 * the dispatcher inside qdrant-client.ts routes to this backend when the
 * CLAUDEX_VECTOR_BACKEND environment variable is set to "sqlite-vec".
 *
 * Design differences vs. Qdrant backend:
 *
 *   - No payload storage in the vector table. sqlite-vec's vec0 only stores
 *     the vector; the payload lives in the source SQLite tables (artifacts,
 *     experience_patterns, session_journal, conversation_turns,
 *     thread_state/sessions). Searches JOIN with those tables to reconstruct
 *     the payload shape Qdrant returns.
 *
 *   - No network latency or dual-write divergence risk. The vector and the
 *     source row live in the same SQLite file and can be inserted in the
 *     same transaction.
 *
 *   - Flat search, not HNSW. sqlite-vec scans every vector in the target
 *     table for each KNN query. At Claudex's current scale (tens of
 *     thousands of artifacts) this is fast (~10-30ms). At 500k+ vectors
 *     HNSW would matter; we're nowhere near that.
 *
 *   - String IDs (pattern ULIDs, thread session_ids) use the same
 *     FNV-1a hash as the Qdrant backend to produce a stable 32-bit integer
 *     rowid. This way the two backends agree on ID→rowid mapping during
 *     the dual-backend period, which simplifies cross-validation.
 *
 * All functions are non-throwing (safe defaults: false for writes, []
 * for searches).
 */

import type { Database } from 'better-sqlite3';
import { loadSqliteVec, encodeVector, sqliteVecLoadStatus } from '../core/sqlite-vec-loader.js';
import type {
  ArtifactPayload,
  PatternPayload,
  SearchResult,
  QdrantConfig,
} from './qdrant-client.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _db: Database | null = null;

/**
 * Register the Database instance the sqlite-vec backend should use.
 * Called once at process startup by the adapter that owns the DB connection
 * (Angel's main, CC hook infrastructure, OpenClaw bridge, tests).
 *
 * Idempotent: calling with the same db is a no-op. Calling with a different
 * db replaces the reference.
 */
export function setVectorStoreDb(db: Database | null): void {
  _db = db;
  if (db) {
    // Load the extension on the registered connection. loadSqliteVec is
    // idempotent per-connection — safe to call if already loaded.
    loadSqliteVec(db);
  }
}

/**
 * Get the current DB instance. Returns null if not set.
 */
export function getVectorStoreDb(): Database | null {
  return _db;
}

/**
 * Check if the sqlite-vec backend is ready to serve queries.
 */
export function isSqliteVecReady(): boolean {
  if (!_db) return false;
  const status = sqliteVecLoadStatus();
  return status.succeeded;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable FNV-1a hash: converts a string ID into a positive 32-bit integer.
 * MUST match the implementation in qdrant-client.ts so both backends agree
 * on rowid assignment during the dual-backend period.
 */
function hashStringToInt(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return Math.abs(hash);
}

/**
 * Safely execute a database operation with the registered db.
 * Returns `fallback` if the db isn't set or the operation throws.
 */
function withDb<T>(fn: (db: Database) => T, fallback: T): T {
  if (!_db) return fallback;
  try {
    return fn(_db);
  } catch {
    return fallback;
  }
}

/**
 * Convert an ArrayBuffer-backed BLOB row result into a distance number.
 * sqlite-vec returns `distance` as a REAL column.
 */
interface VecSearchRow {
  rowid: number | bigint;
  distance: number;
}

/**
 * Convert sqlite-vec L2 distance into a Qdrant-style cosine similarity score.
 * sqlite-vec uses L2 distance by default (lower = closer).
 * Qdrant callers expect scores where higher = more similar.
 *
 * For normalized embeddings, L2^2 = 2 - 2*cos(θ), so cos = 1 - L2^2/2.
 * We don't normalize here (callers pass whatever), so this is an
 * approximation that preserves ordering and maps distance → similarity
 * in a monotonic way. Higher output = more similar.
 */
function distanceToScore(distance: number): number {
  // Monotonic decreasing map: small distance → high score, large → low.
  // 1 / (1 + d) keeps the result in (0, 1] and is order-preserving.
  return 1 / (1 + distance);
}

// ---------------------------------------------------------------------------
// Client lifecycle (mirroring qdrant-client.ts API)
// ---------------------------------------------------------------------------

/**
 * sqlite-vec analog of `ensureCollections`. The virtual tables are created
 * by the V14→V15 migration; this function just verifies they exist and
 * the extension is loaded.
 */
export async function ensureVecCollections(_config?: Partial<QdrantConfig>): Promise<boolean> {
  return withDb(db => {
    loadSqliteVec(db);
    const tables = ['vec_artifacts', 'vec_patterns', 'vec_threads', 'vec_journal', 'vec_conversations'];
    for (const t of tables) {
      try {
        db.prepare(`SELECT COUNT(*) FROM ${t}`).get();
      } catch {
        return false;
      }
    }
    return true;
  }, false);
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

/**
 * Upsert an artifact embedding into vec_artifacts.
 * The rowid matches the artifact_id in the SQLite `artifacts` table.
 * Payload is NOT stored — it's recovered via JOIN on search.
 *
 * Uses INSERT OR REPLACE semantics (delete + insert) because vec0 doesn't
 * support UPDATE on the embedding column directly.
 */
export async function upsertArtifactEmbeddingVec(
  artifactId: number,
  embedding: number[],
  _payload: ArtifactPayload,
  _config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return withDb(db => {
    const vec = encodeVector(embedding);
    const rowid = BigInt(artifactId);
    // vec0 doesn't support INSERT OR REPLACE directly; simulate via delete+insert.
    db.prepare('DELETE FROM vec_artifacts WHERE rowid = ?').run(rowid);
    db.prepare('INSERT INTO vec_artifacts (rowid, embedding) VALUES (?, ?)').run(rowid, vec);
    return true;
  }, false);
}

/**
 * Upsert a pattern embedding into vec_patterns.
 * Pattern IDs are ULIDs (strings); we hash them to 32-bit integers
 * using the same hashStringToInt as qdrant-client.ts so both backends
 * agree on rowid assignment.
 */
export async function upsertPatternEmbeddingVec(
  patternId: string,
  embedding: number[],
  _payload: PatternPayload,
  _config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return withDb(db => {
    const vec = encodeVector(embedding);
    const rowid = BigInt(hashStringToInt(patternId));
    db.prepare('DELETE FROM vec_patterns WHERE rowid = ?').run(rowid);
    db.prepare('INSERT INTO vec_patterns (rowid, embedding) VALUES (?, ?)').run(rowid, vec);
    return true;
  }, false);
}

export async function upsertThreadEmbeddingVec(
  sessionId: string,
  embedding: number[],
  _payload: Record<string, unknown>,
  _config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return withDb(db => {
    const vec = encodeVector(embedding);
    const rowid = BigInt(hashStringToInt(sessionId));
    db.prepare('DELETE FROM vec_threads WHERE rowid = ?').run(rowid);
    db.prepare('INSERT INTO vec_threads (rowid, embedding) VALUES (?, ?)').run(rowid, vec);
    return true;
  }, false);
}

export async function upsertJournalEmbeddingVec(
  journalId: number,
  embedding: number[],
  _payload: Record<string, unknown>,
  _config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return withDb(db => {
    const vec = encodeVector(embedding);
    const rowid = BigInt(journalId);
    db.prepare('DELETE FROM vec_journal WHERE rowid = ?').run(rowid);
    db.prepare('INSERT INTO vec_journal (rowid, embedding) VALUES (?, ?)').run(rowid, vec);
    return true;
  }, false);
}

export async function upsertConversationEmbeddingVec(
  turnId: number,
  embedding: number[],
  _payload: Record<string, unknown>,
  _config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return withDb(db => {
    const vec = encodeVector(embedding);
    const rowid = BigInt(turnId);
    db.prepare('DELETE FROM vec_conversations WHERE rowid = ?').run(rowid);
    db.prepare('INSERT INTO vec_conversations (rowid, embedding) VALUES (?, ?)').run(rowid, vec);
    return true;
  }, false);
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

/**
 * Semantic search over vec_artifacts with metadata filters.
 * Returns Qdrant-compatible SearchResult shape.
 *
 * The KNN search runs over vec_artifacts; results are JOINed with the
 * artifacts table to apply filters (project, importance, type, superseded)
 * and reconstruct the payload.
 *
 * Known quirk: vec0 wants `k = N` in the WHERE clause to bound the KNN
 * search. Extra filtering (project, etc.) happens in the outer query, so
 * we over-fetch the KNN result then filter down. For small N this is fine.
 */
export async function searchArtifactsVec(
  embedding: number[],
  project: string,
  limit: number = 10,
  filters?: {
    minImportance?: number;
    artifactTypes?: string[];
    excludeSuperseded?: boolean;
  },
  _config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return withDb(db => {
    const queryVec = encodeVector(embedding);
    // Over-fetch to allow for filter attrition. Bounded at 200 to keep cost sane.
    const knnLimit = Math.min(200, Math.max(limit * 4, 40));

    const excludeSuperseded = filters?.excludeSuperseded !== false;
    const minImportance = filters?.minImportance ?? null;
    const artifactTypes = filters?.artifactTypes ?? null;

    // Note: the artifacts table tracks supersession via the `superseded_by`
    // column (integer FK to artifacts.id), not via a state value. The
    // `state` column is a lifecycle enum: fresh / packed / materialized.
    const where: string[] = ['a.project = ?'];
    const params: unknown[] = [queryVec, knnLimit, project];

    if (excludeSuperseded) {
      where.push('a.superseded_by IS NULL');
    }
    if (minImportance != null) {
      where.push('a.importance >= ?');
      params.push(minImportance);
    }
    if (artifactTypes && artifactTypes.length > 0) {
      const placeholders = artifactTypes.map(() => '?').join(',');
      where.push(`a.artifact_type IN (${placeholders})`);
      for (const t of artifactTypes) params.push(t);
    }

    const sql = `
      SELECT
        v.rowid AS id,
        v.distance AS distance,
        a.id AS artifact_id,
        a.project AS project,
        a.artifact_type AS artifact_type,
        a.importance AS importance,
        a.confidence AS confidence,
        a.activation_score AS activation_score,
        a.session_id AS session_id,
        a.timestamp_epoch AS timestamp_epoch,
        a.superseded_by AS superseded_by,
        a.summary AS summary
      FROM vec_artifacts v
      JOIN artifacts a ON a.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
        AND ${where.join(' AND ')}
      ORDER BY v.distance
      LIMIT ?
    `;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Array<{
      id: number;
      distance: number;
      artifact_id: number;
      project: string;
      artifact_type: string;
      importance: number;
      confidence: number;
      activation_score: number;
      session_id: string;
      timestamp_epoch: number;
      superseded_by: number | null;
      summary: string;
    }>;

    return rows.map(r => ({
      id: r.artifact_id,
      score: distanceToScore(r.distance),
      payload: {
        artifact_id: r.artifact_id,
        project: r.project,
        artifact_type: r.artifact_type,
        importance: r.importance,
        confidence: r.confidence,
        activation_score: r.activation_score,
        session_id: r.session_id,
        timestamp_epoch: r.timestamp_epoch,
        superseded: r.superseded_by != null,
        summary: r.summary,
      },
    }));
  }, []);
}

/**
 * Search experience patterns by embedding similarity. Scoped to current
 * project + __global__ (same as Qdrant backend).
 */
export async function searchPatternsVec(
  embedding: number[],
  project: string,
  limit: number = 5,
  _config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return withDb(db => {
    const queryVec = encodeVector(embedding);
    const knnLimit = Math.min(200, Math.max(limit * 4, 20));

    // Phase 2 limitation: experience_patterns.id is a ULID (text) and we
    // don't have a stable rowid → pattern_id mapping stored anywhere. To
    // enrich KNN results with the full pattern payload, we scan all
    // patterns once, hash each id, and build an in-memory map. At Claudex's
    // current scale (~40 patterns) this is fine. Phase 2b should add a
    // fnv_hash column to experience_patterns via a V16 migration and JOIN
    // directly instead.
    // reads pre-Phase-4 experience_patterns table — write surface deleted, no
    // new INSERTs (V28 trigger blocks them). Rows persist for as long as their
    // content is useful. See .planning/reframes/2026-05-05-multi-handle-kill.md.
    const allPatterns = db.prepare(`
      SELECT id, pattern_type, severity, score, times_triggered, times_useful,
             verified, trigger_context, source_project
      FROM experience_patterns
      WHERE source_project = ? OR source_project = '__global__'
    `).all(project) as Array<{
      id: string;
      pattern_type: string;
      severity: string;
      score: number;
      times_triggered: number;
      times_useful: number;
      verified: number;
      trigger_context: string;
      source_project: string;
    }>;

    const byHash = new Map<number, typeof allPatterns[0]>();
    for (const p of allPatterns) {
      byHash.set(hashStringToInt(p.id), p);
    }

    // Now run the KNN query and filter by known hashes.
    const knn = db.prepare(`
      SELECT rowid, distance
      FROM vec_patterns
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(queryVec, knnLimit) as VecSearchRow[];

    const results: SearchResult[] = [];
    for (const hit of knn) {
      const rowid = typeof hit.rowid === 'bigint' ? Number(hit.rowid) : hit.rowid;
      const pattern = byHash.get(rowid);
      if (!pattern) continue; // rowid from a different project or stale
      results.push({
        id: rowid,
        score: distanceToScore(hit.distance),
        payload: {
          pattern_id: pattern.id,
          pattern_id_str: pattern.id,
          project: pattern.source_project,
          pattern_type: pattern.pattern_type,
          severity: pattern.severity,
          score: pattern.score,
          times_triggered: pattern.times_triggered,
          times_useful: pattern.times_useful,
          verified: pattern.verified === 1,
          trigger_context: pattern.trigger_context,
        },
      });
      if (results.length >= limit) break;
    }
    return results;
  }, []);
}

export async function searchThreadsVec(
  embedding: number[],
  project: string,
  limit: number = 5,
  _config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return withDb(db => {
    const queryVec = encodeVector(embedding);
    const knnLimit = Math.min(200, Math.max(limit * 4, 20));

    // Threads don't have a stable FNV hash column; we can't easily JOIN
    // them from the rowid alone. For Phase 2 we return KNN results with
    // no payload enrichment — callers that need full thread metadata
    // should look it up by session_id separately. This matches the
    // pattern of returning partial-payload results.
    const sql = `
      SELECT
        v.rowid AS id,
        v.distance AS distance
      FROM vec_threads v
      WHERE v.embedding MATCH ?
        AND v.k = ?
      ORDER BY v.distance
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(queryVec, knnLimit, limit) as VecSearchRow[];

    // Post-filter by project via a lookup pass. Could be improved with a
    // thread_state JOIN once we have a stable rowid→session_id mapping.
    return rows.map(r => ({
      id: typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid,
      score: distanceToScore(r.distance),
      payload: { project },
    }));
  }, []);
}

export async function searchJournalVec(
  embedding: number[],
  project: string,
  limit: number = 5,
  _config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return withDb(db => {
    const queryVec = encodeVector(embedding);
    const knnLimit = Math.min(200, Math.max(limit * 4, 20));

    const sql = `
      SELECT
        v.rowid AS id,
        v.distance AS distance,
        j.id AS journal_id,
        j.session_id AS session_id,
        j.project AS project,
        j.entry_type AS entry_type,
        j.recall_text AS recall_text,
        j.content AS content,
        j.timestamp_epoch AS timestamp_epoch
      FROM vec_journal v
      JOIN session_journal j ON j.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
        AND j.project = ?
      ORDER BY v.distance
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(queryVec, knnLimit, project, limit) as Array<{
      id: number;
      distance: number;
      journal_id: number;
      session_id: string;
      project: string;
      entry_type: string;
      recall_text: string | null;
      content: string;
      timestamp_epoch: number;
    }>;

    return rows.map(r => ({
      id: r.journal_id,
      score: distanceToScore(r.distance),
      payload: {
        journal_id: r.journal_id,
        session_id: r.session_id,
        project: r.project,
        entry_type: r.entry_type,
        recall_text: r.recall_text,
        content: r.content,
        timestamp_epoch: r.timestamp_epoch,
      },
    }));
  }, []);
}

export async function searchConversationsVec(
  embedding: number[],
  project: string,
  limit: number = 5,
  _config?: Partial<QdrantConfig>,
): Promise<SearchResult[]> {
  return withDb(db => {
    const queryVec = encodeVector(embedding);
    const knnLimit = Math.min(200, Math.max(limit * 4, 20));

    const sql = `
      SELECT
        v.rowid AS id,
        v.distance AS distance,
        ct.id AS turn_id,
        ct.session_id AS session_id,
        ct.project AS project,
        ct.user_text AS user_text,
        ct.assistant_text AS assistant_text,
        ct.turn_number AS turn_number,
        ct.timestamp_epoch AS timestamp_epoch
      FROM vec_conversations v
      JOIN conversation_turns ct ON ct.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
        AND ct.project = ?
      ORDER BY v.distance
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(queryVec, knnLimit, project, limit) as Array<{
      id: number;
      distance: number;
      turn_id: number;
      session_id: string;
      project: string;
      user_text: string | null;
      assistant_text: string | null;
      turn_number: number;
      timestamp_epoch: number;
    }>;

    return rows.map(r => ({
      id: r.turn_id,
      score: distanceToScore(r.distance),
      payload: {
        turn_id: r.turn_id,
        session_id: r.session_id,
        project: r.project,
        user_text: r.user_text,
        assistant_text: r.assistant_text,
        turn_number: r.turn_number,
        timestamp_epoch: r.timestamp_epoch,
      },
    }));
  }, []);
}

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

export async function deleteArtifactPointVec(
  artifactId: number,
  _config?: Partial<QdrantConfig>,
): Promise<boolean> {
  return withDb(db => {
    const rowid = BigInt(artifactId);
    db.prepare('DELETE FROM vec_artifacts WHERE rowid = ?').run(rowid);
    return true;
  }, false);
}
