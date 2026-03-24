/**
 * Observation CRUD with FTS5 full-text search and BM25 temporal re-ranking.
 * Plain functions with `db: Database` as first param.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { CONTENT_MAX_CHARS } from '../shared/constants.js';
import { truncateText } from '../shared/text-utils.js';

/** Result of dedup check, returned by insertObservationWithDedup. */
export interface DedupResult {
  /** The observation ID (new or existing). */
  id: number;
  /** Whether this was a new insert, a skip (same-session dup), or an update (cross-session dup). */
  action: 'inserted' | 'skipped' | 'updated';
}

/** Stability classes for decay engine. */
export type StabilityClass = 'transient' | 'standard' | 'stable' | 'permanent';

/**
 * Classifies observation stability based on category.
 * Transient categories (error, test) decay fastest.
 * Stable categories (architecture, decision) decay slowest.
 * All others get 'standard' decay rates.
 */
export function classifyStability(category: string): StabilityClass {
  if (['error', 'test'].includes(category)) return 'transient';
  if (['architecture', 'decision'].includes(category)) return 'stable';
  return 'standard';
}

/** Valid observation categories. */
const VALID_CATEGORIES = [
  'code', 'architecture', 'decision', 'error', 'test',
  'config', 'dependency', 'documentation', 'performance',
  'security', 'other',
] as const;

export type ObservationCategory = (typeof VALID_CATEGORIES)[number];

/** Row shape returned from observation queries. */
export interface ObservationRow {
  id: number;
  session_id: string;
  project: string | null;
  tool_name: string;
  category: string;
  title: string;
  content: string;
  importance: number;
  files_modified: string;
  timestamp_epoch: number;
  access_count: number;
  last_accessed_at_epoch: number | null;
  deleted_at_epoch: number | null;
  consumed: number;
  obs_type: string | null;
}

/** Input for inserting an observation. */
export interface InsertObservationInput {
  session_id: string;
  project: string;
  tool_name: string;
  category: ObservationCategory;
  title: string;
  content: string;
  importance: number;
  files_modified: string[];
  obs_type?: string;
}

/**
 * Inserts an observation into the database.
 * Serializes files_modified as JSON. Returns the inserted row id.
 */
export function insertObservation(
  db: Database,
  obs: InsertObservationInput
): number {
  // Strip typed redaction markers from FTS-indexed fields so that
  // "secret", "pii", "entropy" stems don't pollute full-text search.
  // The generic "[REDACTED]" placeholder is kept for visual indication.
  const ftsCleanTitle = obs.title.replace(/\[REDACTED_\w+\]/g, '[REDACTED]');
  const ftsCleanContent = obs.content.replace(/\[REDACTED_\w+\]/g, '[REDACTED]');
  // Defense-in-depth content cap (backstop for extractors)
  const cappedContent = truncateText(ftsCleanContent, CONTENT_MAX_CHARS);

  const stabilityClass = classifyStability(obs.category);

  const result = cachedPrepare(db,
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, obs_type, stability_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      obs.session_id,
      obs.project,
      obs.tool_name,
      obs.category,
      ftsCleanTitle,
      cappedContent,
      obs.importance,
      JSON.stringify(obs.files_modified),
      obs.obs_type ?? null,
      stabilityClass
    );

  // Keep session observation_count in sync
  try {
    cachedPrepare(db,
      `UPDATE sessions SET observation_count = observation_count + 1 WHERE session_id = ?`
    ).run(obs.session_id);
  } catch { /* non-fatal — observation was stored successfully */ }

  return Number(result.lastInsertRowid);
}

/** Cosine similarity threshold for observation dedup. Above this = duplicate.
 * @deprecated Use getPolicy().shouldStore() instead. Kept for test compatibility. */
export const DEDUP_COSINE_THRESHOLD = 0.85;

/**
 * Async dedup-aware observation insert.
 *
 * Before inserting, embeds `title + ' ' + content` and searches Qdrant
 * `claudex_artifacts` (artifact_type='observation') for cosine > 0.85 matches.
 *
 * Decision logic delegated to MemoryPolicy.shouldStore():
 * - No match → normal insert
 * - Match in same session → skip (return existing observation ID)
 * - Match in different session → update existing: increment access_count, refresh last_accessed_at_epoch
 * - Qdrant unavailable or any error → fall through to normal insert
 *
 * NEVER blocks writes. The entire dedup path is wrapped in try/catch.
 *
 * @param db - SQLite database
 * @param obs - observation input (same as insertObservation)
 * @returns DedupResult with the observation id and the action taken
 */
export async function insertObservationWithDedup(
  db: Database,
  obs: InsertObservationInput,
): Promise<DedupResult> {
  // Try semantic dedup — any failure falls through to normal insert
  try {
    // Dynamic imports to avoid circular deps and keep sync path unaffected
    const { embedText } = await import('../embeddings/embed-pipeline.js');
    const { searchArtifacts } = await import('../embeddings/qdrant-client.js');

    const textToEmbed = obs.title + ' ' + obs.content;
    const embedding = await embedText(textToEmbed);

    if (embedding) {
      // Search existing observation artifacts in Qdrant
      const results = await searchArtifacts(embedding, obs.project, 3, {
        artifactTypes: ['observation'],
        excludeSuperseded: true,
      });

      // Find the best match
      const best = results.length > 0 ? results[0] : null;
      const bestScore = best?.score ?? 0;
      const matchSessionId = best?.payload?.session_id as string | undefined;
      const artifactId = best
        ? ((best.payload?.artifact_id as number | undefined)
          ?? (typeof best.id === 'number' ? best.id : 0))
        : 0;

      // Look up observation ID from artifact
      let existingObsId = 0;
      if (artifactId > 0) {
        const artifact = cachedPrepare(db,
          `SELECT artifact_ref FROM artifacts WHERE id = ? AND artifact_type = 'observation'`
        ).get(artifactId) as { artifact_ref: string | null } | undefined;
        existingObsId = artifact?.artifact_ref ? Number(artifact.artifact_ref) : 0;

        // Verify the observation still exists in SQLite
        if (existingObsId > 0) {
          const existingObs = getObservationById(db, existingObsId);
          if (!existingObs) existingObsId = 0; // Deleted from SQLite — fall through
        }
      }

      // Delegate decision to memory policy
      const { getPolicy } = await import('../intelligence/policy-registry.js');
      const policy = getPolicy();
      const candidate = {
        textToEmbed,
        sessionId: obs.session_id,
        project: obs.project,
        bestMatchScore: bestScore,
        bestMatchSessionId: matchSessionId,
        bestMatchObsId: existingObsId,
      };
      const now = new Date();
      const policyContext = {
        sessionId: obs.session_id,
        project: obs.project,
        hourOfDay: now.getHours(),
        dayOfWeek: now.getDay(),
        hoursSinceLastSession: 0,
      };

      const decision = policy.shouldStore(candidate, policyContext);

      if (decision.action === 'skip') {
        return { id: existingObsId, action: 'skipped' };
      }

      if (decision.action === 'update' && decision.targetId > 0) {
        try {
          cachedPrepare(db,
            `UPDATE observations
             SET access_count = access_count + 1,
                 last_accessed_at_epoch = unixepoch()
             WHERE id = ?`
          ).run(decision.targetId);
        } catch { /* non-fatal — we still return the existing ID */ }
        return { id: decision.targetId, action: 'updated' };
      }

      // action === 'add' — fall through to normal insert
    }
    // No embedding or no match — fall through to normal insert
  } catch {
    // Dedup check failed — fall through to normal insert (never block writes)
  }

  const id = insertObservation(db, obs);
  return { id, action: 'inserted' };
}

/**
 * Retrieves observations for a given project.
 * Excludes soft-deleted rows unless includeDeleted is true.
 * Ordered by timestamp_epoch DESC. Default limit 100.
 * Filters by project scope.
 */
export function getObservationsByProject(
  db: Database,
  project: string,
  opts?: { limit?: number; includeDeleted?: boolean }
): ObservationRow[] {
  const limit = opts?.limit ?? 100;
  const includeDeleted = opts?.includeDeleted ?? false;

  if (includeDeleted) {
    return cachedPrepare(db,
        `SELECT * FROM observations
         WHERE project = ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`
      )
      .all(project, limit) as ObservationRow[];
  }

  return cachedPrepare(db,
      `SELECT * FROM observations
       WHERE project = ? AND deleted_at_epoch IS NULL
       ORDER BY timestamp_epoch DESC
       LIMIT ?`
    )
    .all(project, limit) as ObservationRow[];
}

/**
 * Retrieves a single observation by its id.
 */
export function getObservationById(
  db: Database,
  id: number
): ObservationRow | undefined {
  return cachedPrepare(db, 'SELECT * FROM observations WHERE id = ?')
    .get(id) as ObservationRow | undefined;
}

/**
 * FTS5 search with BM25 + exponential temporal re-ranking.
 *
 * Uses BM25 for initial relevance scoring from SQLite FTS5,
 * then applies temporal decay: finalScore = bm25Rank * exp(-ageDays / 30).
 * BM25 returns negative values (lower = more relevant), so temporal decay
 * pushes older results toward zero (less relevant). Sort ascending.
 *
 * @internal Test-only. Not called in production code — the assembler uses
 * artifact-based retrieval (searchArtifacts with LIKE) rather than FTS5.
 * Retained for test coverage and potential future use.
 */
export function searchObservations(
  db: Database,
  query: string,
  project: string,
  opts?: { limit?: number }
): ObservationRow[] {
  const limit = opts?.limit ?? 100;

  // Sanitize FTS5 operator syntax to prevent query injection.
  // FTS5 MATCH interprets *, ", (), etc. as operators — strip them.
  const sanitized = query.replace(/[*"(){}[\]:^~!@#$%&|\\]/g, ' ').trim();
  if (!sanitized) return [];

  const rows = cachedPrepare(db,
      `SELECT o.*, bm25(observations_fts) as bm25_rank
       FROM observations_fts fts
       JOIN observations o ON o.id = fts.rowid
       WHERE observations_fts MATCH ?
         AND o.project = ?
         AND o.deleted_at_epoch IS NULL
         AND o.consumed = 0
       ORDER BY bm25(observations_fts)
       LIMIT ?`
    )
    .all(sanitized, project, limit) as Array<ObservationRow & { bm25_rank: number }>;

  const nowEpoch = Date.now() / 1000;

  // Apply temporal re-ranking
  const scored = rows.map((row) => {
    const ageDays = (nowEpoch - row.timestamp_epoch) / 86400;
    const finalScore = row.bm25_rank * Math.exp(-ageDays / 30);
    return { row, finalScore };
  });

  // Sort by finalScore ascending (more negative = more relevant)
  scored.sort((a, b) => a.finalScore - b.finalScore);

  // Strip bm25_rank from returned rows
  return scored.map(({ row }) => {
    const { bm25_rank: _, ...obs } = row;
    return obs as ObservationRow;
  });
}

/**
 * Marks observations as consumed (already injected into context).
 * Used by PreCompact to flag old observations that don't need re-injection.
 * Scoped by session_id to prevent cross-session blindness.
 * @param db Database instance
 * @param project Project scope
 * @param sessionId Session scope — only marks observations from this session
 * @param olderThanEpoch Unix epoch — observations older than this are marked consumed
 * @param excludeRecent Number of most recent observations to always keep unconsumed
 */
export function markObservationsConsumed(
  db: Database,
  project: string,
  sessionId: string,
  olderThanEpoch: number,
  excludeRecent: number = 10
): number {
  // Get IDs of the N most recent observations to exclude (scoped to session)
  const recentIds = cachedPrepare(db,
    `SELECT id FROM observations
     WHERE project = ? AND session_id = ? AND deleted_at_epoch IS NULL
     ORDER BY timestamp_epoch DESC
     LIMIT ?`
  ).all(project, sessionId, excludeRecent) as Array<{ id: number }>;

  const excludeSet = new Set(recentIds.map(r => r.id));

  if (excludeSet.size === 0) {
    // Mark all older observations as consumed (scoped to session)
    const result = cachedPrepare(db,
      `UPDATE observations SET consumed = 1
       WHERE project = ? AND session_id = ? AND deleted_at_epoch IS NULL
         AND consumed = 0 AND timestamp_epoch < ?`
    ).run(project, sessionId, olderThanEpoch);
    return result.changes;
  }

  // Use subquery to exclude the most recent N observations (scoped to session)
  const result = cachedPrepare(db,
    `UPDATE observations SET consumed = 1
     WHERE project = ? AND session_id = ? AND deleted_at_epoch IS NULL
       AND consumed = 0 AND timestamp_epoch < ?
       AND id NOT IN (
         SELECT id FROM observations
         WHERE project = ? AND session_id = ? AND deleted_at_epoch IS NULL
         ORDER BY timestamp_epoch DESC
         LIMIT ?
       )`
  ).run(project, sessionId, olderThanEpoch, project, sessionId, excludeRecent);
  return result.changes;
}
