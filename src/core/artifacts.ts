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
import { tokenizeQuery } from '../shared/search-utils.js';

/** Artifact lifecycle states. */
export type ArtifactState = 'fresh' | 'packed' | 'materialized';

/** Valid artifact type discriminators. */
export type ArtifactType = 'observation' | 'learning' | 'decision' | 'hot_file' | 'flow' | 'milestone' | 'memory_file' | 'session_log' | 'handoff';

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
  retrieval_score: number;
  timestamp_epoch_ms: number;
  last_materialized_epoch_ms: number | null;
  /** V9: embedding BLOB for vector search fallback */
  embedding?: Buffer | null;
  /** V9: ACT-R activation score (replaces flat TTL decay) */
  activation_score?: number;
  /** V9: ID of the artifact that superseded this one */
  superseded_by?: number | null;
  /** V9: epoch when this artifact was superseded */
  valid_until?: number | null;
  /** V9: factual confidence at write time (0.0-1.0) */
  confidence?: number;
  /** V9: semantic novelty at creation (0.0-1.0) */
  novelty_score?: number;
}

/** Confidence scores by artifact source (2.6). */
export const CONFIDENCE_SCORES: Record<string, number> = {
  // Observations from deterministic tools
  'observation:Read': 1.0,
  'observation:Grep': 1.0,
  'observation:Glob': 1.0,
  'observation:Edit': 1.0,
  'observation:Write': 1.0,
  // Observations from non-deterministic tools
  'observation:Bash': 0.9,
  // Decisions
  'decision:user': 0.9,
  'decision:assistant': 0.7,
  // Other types
  'learning': 0.7,
  'flow': 0.8,
  'milestone': 0.9,
  'hot_file': 1.0,
  'memory_file': 0.9,
  'session_log': 0.8,
  'handoff': 0.8,
};

/**
 * Determine confidence score for an artifact based on its type and source tool.
 * Returns a value in [0.0, 1.0].
 */
export function getConfidenceScore(
  artifactType: ArtifactType,
  toolName?: string,
  decisionSource?: 'user' | 'assistant',
): number {
  if (artifactType === 'observation' && toolName) {
    return CONFIDENCE_SCORES[`observation:${toolName}`] ?? 0.9;
  }
  if (artifactType === 'decision' && decisionSource) {
    return CONFIDENCE_SCORES[`decision:${decisionSource}`] ?? 0.8;
  }
  return CONFIDENCE_SCORES[artifactType] ?? 0.8;
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
       ORDER BY importance DESC, timestamp_epoch_ms DESC
       LIMIT ?`
    ).all(project, opts.state, opts.type, limit) as ArtifactRow[];
  }

  if (opts?.state) {
    return cachedPrepare(db,
      `SELECT * FROM artifacts
       WHERE project = ? AND state = ?
       ORDER BY importance DESC, timestamp_epoch_ms DESC
       LIMIT ?`
    ).all(project, opts.state, limit) as ArtifactRow[];
  }

  if (opts?.type) {
    return cachedPrepare(db,
      `SELECT * FROM artifacts
       WHERE project = ? AND artifact_type = ?
       ORDER BY importance DESC, timestamp_epoch_ms DESC
       LIMIT ?`
    ).all(project, opts.type, limit) as ArtifactRow[];
  }

  return cachedPrepare(db,
    `SELECT * FROM artifacts
     WHERE project = ?
     ORDER BY importance DESC, timestamp_epoch_ms DESC
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
       timestamp_epoch_ms DESC,
       id ASC
     LIMIT ?`
  ).all(project, limit ?? 100) as ArtifactRow[];
}

/**
 * Returns materialized artifacts (full content visible).
 * Ordered by importance DESC, timestamp_epoch DESC.
 */
/**
 * Get materialized/fresh artifacts. Global scope searches all projects with
 * current-project priority and a hard cap to prevent unbounded context bloat.
 */
export function getMaterializedArtifacts(
  db: Database,
  project: string,
  globalScope: boolean = false,
): ArtifactRow[] {
  if (globalScope) {
    return cachedPrepare(db,
      `SELECT * FROM artifacts
       WHERE state IN ('fresh', 'materialized')
       ORDER BY
         CASE WHEN project = ? THEN 0 ELSE 1 END,
         importance DESC, timestamp_epoch_ms DESC, id ASC
       LIMIT 20`
    ).all(project) as ArtifactRow[];
  }
  return cachedPrepare(db,
    `SELECT * FROM artifacts
     WHERE project = ? AND state IN ('fresh', 'materialized')
     ORDER BY importance DESC, timestamp_epoch_ms DESC, id ASC`
  ).all(project) as ArtifactRow[];
}

/**
 * Materializes specific artifacts by ID — sets state to 'materialized', TTL to 2,
 * and records the materialization timestamp.
 *
 * When scopeProject is provided, only materializes artifacts belonging to that project.
 * Cross-project artifacts are left unchanged — they surface via global search each turn
 * without contaminating other projects' artifact lifecycle state.
 */
export function materializeArtifacts(
  db: Database,
  artifactIds: number[],
  scopeProject?: string,
): void {
  if (artifactIds.length === 0) return;

  // Dynamic import to avoid circular dependency (hybrid-retrieval imports from artifacts)
  let recordAccess: ((db: Database, id: number) => void) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const hr = require('../core/hybrid-retrieval.js');
    recordAccess = hr.recordArtifactAccess;
  } catch { /* non-fatal — access tracking is optional */ }

  if (scopeProject) {
    // Only materialize same-project artifacts — prevents cross-project state contamination
    const stmt = cachedPrepare(db,
      `UPDATE artifacts
       SET state = 'materialized', ttl = 2, last_materialized_epoch_ms = unixepoch() * 1000
       WHERE id = ? AND project = ?`
    );
    for (const id of artifactIds) {
      stmt.run(id, scopeProject);
      recordAccess?.(db, id);
    }
  } else {
    const stmt = cachedPrepare(db,
      `UPDATE artifacts
       SET state = 'materialized', ttl = 2, last_materialized_epoch_ms = unixepoch() * 1000
       WHERE id = ?`
    );
    for (const id of artifactIds) {
      stmt.run(id);
      recordAccess?.(db, id);
    }
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
 * Packs specific artifacts after they've been injected by full assembly.
 * Prevents double-injection: session-start materializes + injects, then
 * the next user prompt's assembleRegularPrompt would re-read the same
 * artifacts via getMaterializedArtifacts() and inject them again.
 * Non-throwing.
 */
export function consumeInjectedArtifacts(
  db: Database,
  artifactIds: number[],
): void {
  if (artifactIds.length === 0) return;
  try {
    const stmt = cachedPrepare(db,
      `UPDATE artifacts SET state = 'packed', ttl = 0 WHERE id = ?`
    );
    for (const id of artifactIds) {
      stmt.run(id);
    }
  } catch { /* non-throwing */ }
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
 * Internal two-stage artifact search. Consolidates project-scoped and global
 * search into one implementation to eliminate code duplication.
 *
 * When globalScope is false: filters by project (original behavior).
 * When globalScope is true: searches all projects, prioritizes currentProject.
 */
function searchArtifactsInternal(
  db: Database,
  currentProject: string,
  query: string,
  limit: number,
  globalScope: boolean,
): ArtifactRow[] {
  if (!query || query.length < 3) return [];

  const projectFilter = globalScope ? '' : 'AND a.project = ?';
  const orderPrefix = globalScope
    ? 'CASE WHEN a.project = ? THEN 0 ELSE 1 END,'
    : '';

  // Stage 1: FTS5 search on observation artifacts (via observations_fts join)
  let ftsResults: ArtifactRow[] = [];
  try {
    const keywords = tokenizeQuery(query);
    if (keywords.length > 0) {
      const ftsQuery = keywords.join(' OR ');
      const sql = `SELECT a.* FROM artifacts a
         INNER JOIN observations_fts fts ON CAST(a.artifact_ref AS INTEGER) = fts.rowid
         WHERE a.artifact_type = 'observation'
           ${projectFilter}
           AND observations_fts MATCH ?
         ORDER BY ${orderPrefix}
           a.importance DESC, a.retrieval_score DESC, a.timestamp_epoch_ms DESC
         LIMIT ?`;

      const params = globalScope
        ? [ftsQuery, currentProject, limit]
        : [currentProject, ftsQuery, limit];
      ftsResults = cachedPrepare(db, sql).all(...params) as ArtifactRow[];
    }
  } catch {
    // FTS may fail on invalid query syntax — fall through to keyword search
  }

  // Stage 2: FTS5 search on artifacts_fts (summary + content of ALL artifact types)
  // Covers file-type artifacts, decisions, learnings — everything in the artifacts table.
  // Falls back to LIKE if artifacts_fts doesn't exist (pre-migration DB).
  try {
    const keywords = tokenizeQuery(query, 5);
    if (keywords.length === 0) return ftsResults.length > 0 ? ftsResults : [];

    let stage2Results: ArtifactRow[] = [];

    // Try artifacts_fts first (fast path)
    try {
      const ftsQuery2 = keywords.join(' OR ');
      const projectWhere2 = globalScope ? '' : 'AND a.project = ?';
      const orderPrefix2 = globalScope
        ? 'CASE WHEN a.project = ? THEN 0 ELSE 1 END,'
        : '';
      // bm25() returns negative values (more negative = better match)
      const sql2 = `SELECT a.* FROM artifacts a
         JOIN artifacts_fts fts ON fts.rowid = a.id
         WHERE artifacts_fts MATCH ?
           ${projectWhere2}
         ORDER BY ${orderPrefix2}
           CASE a.artifact_type
             WHEN 'decision' THEN 0 WHEN 'learning' THEN 1
             WHEN 'memory_file' THEN 2 WHEN 'observation' THEN 3 ELSE 4
           END,
           bm25(artifacts_fts, 2.0, 1.0),
           a.importance DESC, a.retrieval_score DESC
         LIMIT ?`;
      const params2 = globalScope
        ? [ftsQuery2, currentProject, limit]
        : [ftsQuery2, currentProject, limit];
      stage2Results = cachedPrepare(db, sql2).all(...params2) as ArtifactRow[];
    } catch {
      // artifacts_fts may not exist (pre-migration) — fall back to LIKE
      const conditions = keywords.map(() => '(LOWER(summary) LIKE ? OR LOWER(content) LIKE ?)').join(' OR ');
      const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
      const projectWhere = globalScope ? '' : 'project = ? AND';
      const orderPrefixLike = globalScope
        ? 'CASE WHEN project = ? THEN 0 ELSE 1 END,'
        : '';
      const sql = `SELECT * FROM artifacts
         WHERE ${projectWhere} (${conditions})
         ORDER BY ${orderPrefixLike}
           importance DESC, retrieval_score DESC, timestamp_epoch_ms DESC
         LIMIT ?`;
      const params = globalScope
        ? [...likeParams, currentProject, limit]
        : [currentProject, ...likeParams, limit];
      stage2Results = cachedPrepare(db, sql).all(...params) as ArtifactRow[];
    }

    const likeResults = stage2Results;

    // Merge FTS1 + LIKE results, deduplicate by id, cap at limit
    if (ftsResults.length === 0) return likeResults;
    if (likeResults.length === 0) return ftsResults;

    const seen = new Set<number>();
    const merged: ArtifactRow[] = [];
    for (const r of [...ftsResults, ...likeResults]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
        if (merged.length >= limit) break;
      }
    }
    return merged;
  } catch {
    return ftsResults.length > 0 ? ftsResults : [];
  }
}

/**
 * Search artifacts within a specific project.
 */
export function searchArtifacts(
  db: Database,
  project: string,
  query: string,
  limit?: number,
): ArtifactRow[] {
  return searchArtifactsInternal(db, project, query, limit ?? 10, false);
}

/**
 * Search artifacts across ALL projects. Enables cross-project knowledge
 * retrieval — the artifact layer is the shared memory surface.
 * Current project results are prioritized in ordering.
 */
export function searchArtifactsGlobal(
  db: Database,
  currentProject: string,
  query: string,
  limit?: number,
): ArtifactRow[] {
  return searchArtifactsInternal(db, currentProject, query, limit ?? 10, true);
}

// ---------------------------------------------------------------------------
// V9: Superseded-artifact flagging (2.3)
// ---------------------------------------------------------------------------

/**
 * Flag older artifacts as superseded by a newly created artifact.
 *
 * After creating artifact A, search for existing artifacts about the same
 * entity (same project, FTS5 match on summary). If found and semantically
 * similar (cosine > 0.85), mark the older artifact as superseded.
 *
 * This is the synchronous FTS5-only path. When embeddings are available,
 * the caller should additionally check cosine similarity before flagging.
 *
 * Non-throwing — superseded flagging is best-effort.
 */
export function flagSupersededArtifacts(
  db: Database,
  newArtifactId: number,
  project: string,
  summary: string,
): number {
  try {
    const keywords = tokenizeQuery(summary, 3);
    if (keywords.length === 0) return 0;

    const ftsQuery = keywords.join(' AND ');
    const now = Math.floor(Date.now() / 1000);

    // Find existing artifacts with similar summaries in the same project
    let candidates: Array<{ id: number }> = [];
    try {
      candidates = cachedPrepare(db,
        `SELECT a.id FROM artifacts a
         JOIN artifacts_fts fts ON fts.rowid = a.id
         WHERE artifacts_fts MATCH ?
           AND a.project = ?
           AND a.id != ?
           AND a.superseded_by IS NULL
         ORDER BY bm25(artifacts_fts, 2.0, 1.0)
         LIMIT 5`
      ).all(ftsQuery, project, newArtifactId) as Array<{ id: number }>;
    } catch {
      // FTS unavailable — skip superseded detection
      return 0;
    }

    if (candidates.length === 0) return 0;

    // Flag candidates as superseded (FTS-only path — no cosine check here)
    // The cosine check is done by the caller when embeddings are available.
    // FTS match alone means keyword overlap; we only flag if ALL query keywords matched (AND).
    let flagged = 0;
    // Temporal guard: only supersede artifacts that are OLDER than the new one
    const flagStmt = cachedPrepare(db,
      `UPDATE artifacts
       SET superseded_by = ?, valid_until = ?
       WHERE id = ? AND superseded_by IS NULL AND timestamp_epoch_ms < ?`
    );

    for (const candidate of candidates) {
      const result = flagStmt.run(newArtifactId, now, candidate.id, now);
      if (result.changes > 0) flagged++;
    }

    return flagged;
  } catch {
    return 0;
  }
}

/**
 * Flag a specific artifact as superseded by another, with cosine similarity check.
 * Called from the embedding pipeline when both artifacts have embeddings.
 * Cosine threshold: 0.85.
 * Non-throwing.
 */
export function flagSupersededByCosine(
  db: Database,
  oldArtifactId: number,
  newArtifactId: number,
  cosineSimilarity: number,
  threshold: number = 0.85,
): boolean {
  try {
    if (cosineSimilarity < threshold) return false;

    const now = Math.floor(Date.now() / 1000);
    const result = cachedPrepare(db,
      `UPDATE artifacts
       SET superseded_by = ?, valid_until = ?
       WHERE id = ? AND superseded_by IS NULL`
    ).run(newArtifactId, now, oldArtifactId);

    return result.changes > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// V9: Confidence scoring (2.6)
// ---------------------------------------------------------------------------

/**
 * Set confidence score on an artifact.
 * Called after createArtifact() with the appropriate confidence value.
 * Non-throwing.
 */
export function setArtifactConfidence(
  db: Database,
  artifactId: number,
  confidence: number,
): void {
  try {
    cachedPrepare(db,
      'UPDATE artifacts SET confidence = ? WHERE id = ?'
    ).run(Math.max(0, Math.min(1, confidence)), artifactId);
  } catch {
    // Non-throwing
  }
}

/**
 * Set novelty score on an artifact.
 * Called after novelty gating in the extraction pipeline.
 * Non-throwing.
 */
export function setArtifactNovelty(
  db: Database,
  artifactId: number,
  noveltyScore: number,
): void {
  try {
    cachedPrepare(db,
      'UPDATE artifacts SET novelty_score = ? WHERE id = ?'
    ).run(Math.max(0, Math.min(1, noveltyScore)), artifactId);
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// V9: Artifact linking — Zettelkasten / A-MEM (4.1) + Active Forgetting (4.2)
// ---------------------------------------------------------------------------

/** Valid link types for artifact_links. */
export type ArtifactLinkType = 'related' | 'supports' | 'contradicts' | 'supersedes' | 'caused_by';

/** Row shape for artifact_links queries. */
export interface ArtifactLinkRow {
  source_id: number;
  target_id: number;
  link_type: ArtifactLinkType;
  strength: number;
  created_at_epoch: number;
}

/**
 * Cosine similarity between two Float32Array or number[] vectors.
 * Returns 0.0 for zero-length or zero-norm vectors.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Insert an artifact link. Ignores conflicts (duplicate source_id+target_id).
 * Non-throwing.
 */
export function insertArtifactLink(
  db: Database,
  sourceId: number,
  targetId: number,
  linkType: ArtifactLinkType,
  strength: number,
): void {
  try {
    cachedPrepare(db,
      `INSERT OR IGNORE INTO artifact_links (source_id, target_id, link_type, strength)
       VALUES (?, ?, ?, ?)`
    ).run(sourceId, targetId, linkType, Math.max(0, Math.min(1, strength)));
  } catch {
    // Non-throwing
  }
}

/**
 * Get linked artifacts for a given artifact.
 * Returns links where the given artifact is either source or target.
 * Non-throwing.
 */
export function getArtifactLinks(
  db: Database,
  artifactId: number,
): ArtifactLinkRow[] {
  try {
    return cachedPrepare(db,
      `SELECT * FROM artifact_links
       WHERE source_id = ? OR target_id = ?
       ORDER BY strength DESC
       LIMIT 20`
    ).all(artifactId, artifactId) as ArtifactLinkRow[];
  } catch {
    return [];
  }
}

/**
 * Detect if two artifacts contradict each other.
 * Heuristic: same artifact_ref (file/concept reference) but differing conclusions.
 * Uses keyword opposition detection on content.
 */
function detectContradiction(
  newArtifact: { artifact_ref: string | null; content: string | null; summary: string },
  oldArtifact: { artifact_ref: string | null; content: string | null; summary: string },
): boolean {
  // Must reference the same entity
  if (!newArtifact.artifact_ref || !oldArtifact.artifact_ref) return false;
  if (newArtifact.artifact_ref !== oldArtifact.artifact_ref) return false;

  const newText = `${newArtifact.summary} ${newArtifact.content ?? ''}`.toLowerCase();
  const oldText = `${oldArtifact.summary} ${oldArtifact.content ?? ''}`.toLowerCase();

  // Opposing conclusion patterns
  const oppositions = [
    [/\bshould\b/, /\bshould not\b/],
    [/\bcorrect\b/, /\bincorrect\b/],
    [/\bworks\b/, /\bdoes not work\b/],
    [/\bfixed\b/, /\bbroken\b/],
    [/\btrue\b/, /\bfalse\b/],
    [/\benabled?\b/, /\bdisabled?\b/],
    [/\bvalid\b/, /\binvalid\b/],
    [/\bpasses?\b/, /\bfails?\b/],
  ];

  for (const [pos, neg] of oppositions) {
    if ((pos.test(newText) && neg.test(oldText)) || (neg.test(newText) && pos.test(oldText))) {
      return true;
    }
  }

  return false;
}

/**
 * Apply active forgetting when a contradiction is detected.
 * Deprioritizes the older artifact: halves activation_score, sets valid_until.
 * Non-throwing.
 */
function applyActiveForgetting(
  db: Database,
  olderArtifactId: number,
): void {
  try {
    const now = Math.floor(Date.now() / 1000);
    cachedPrepare(db,
      `UPDATE artifacts
       SET activation_score = activation_score * 0.5,
           valid_until = ?
       WHERE id = ? AND valid_until IS NULL`
    ).run(now, olderArtifactId);
  } catch {
    // Non-throwing
  }
}

/**
 * Link a newly created artifact to semantically related existing artifacts.
 * Uses Qdrant KNN search (top-5, same project) to find related artifacts.
 *
 * Link types are determined by cosine similarity thresholds:
 * - cosine > 0.85 + same entity → 'supersedes' link
 * - cosine > 0.6 → 'related' link
 *
 * Also performs contradiction detection (4.2 Active Forgetting):
 * When two artifacts reference the same entity with opposing conclusions,
 * a 'contradicts' link is created and the older artifact is deprioritized.
 *
 * Async, fire-and-forget after artifact creation. Non-throwing.
 */
export async function linkArtifactToRelated(
  db: Database,
  artifactId: number,
  project: string,
): Promise<number> {
  try {
    // Load the new artifact
    const newArtifact = cachedPrepare(db,
      'SELECT id, artifact_ref, summary, content, embedding, timestamp_epoch_ms FROM artifacts WHERE id = ?'
    ).get(artifactId) as {
      id: number;
      artifact_ref: string | null;
      summary: string;
      content: string | null;
      embedding: Buffer | null;
      timestamp_epoch_ms: number;
    } | undefined;

    if (!newArtifact) return 0;

    // Get the embedding — either from SQLite BLOB or generate fresh
    let embedding: number[] | null = null;
    if (newArtifact.embedding) {
      embedding = Array.from(new Float32Array(
        newArtifact.embedding.buffer,
        newArtifact.embedding.byteOffset,
        newArtifact.embedding.byteLength / 4,
      ));
    }

    if (!embedding) {
      // Try to embed on the fly
      try {
        const { embedText } = await import('../embeddings/embed-pipeline.js');
        embedding = await embedText(`${newArtifact.summary} ${newArtifact.content ?? ''}`);
      } catch {
        return 0; // No embedding available — can't link
      }
    }

    if (!embedding) return 0;

    // KNN search — try Qdrant first, fall back to SQLite BLOB cosine
    let candidates: Array<{ id: number; score: number; payload: Record<string, unknown> }> = [];

    // Qdrant acceleration path
    try {
      const { searchArtifacts: qdrantSearch } = await import('../embeddings/qdrant-client.js');
      const results = await qdrantSearch(embedding, project, 6, {
        excludeSuperseded: true,
      });
      candidates = results
        .filter(r => Number(r.id) !== artifactId)
        .slice(0, 5)
        .map(r => ({ id: Number(r.id), score: r.score, payload: r.payload }));
    } catch {
      // Qdrant import/search failed — fall through to SQLite
    }

    // SQLite BLOB fallback — always runs if Qdrant returned no results
    if (candidates.length === 0) {
      try {
        const rows = cachedPrepare(db,
          `SELECT id, artifact_ref, summary, content, embedding, timestamp_epoch_ms
           FROM artifacts
           WHERE project = ? AND id != ? AND embedding IS NOT NULL
           ORDER BY timestamp_epoch_ms DESC
           LIMIT 20`
        ).all(project, artifactId) as Array<{
          id: number;
          artifact_ref: string | null;
          summary: string;
          content: string | null;
          embedding: Buffer;
          timestamp_epoch_ms: number;
        }>;

        for (const row of rows) {
          const vec = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4,
          );
          const score = cosineSimilarity(embedding, vec);
          if (score > 0.6) {
            candidates.push({ id: row.id, score, payload: {} });
          }
        }
        // Sort by score descending, take top 5
        candidates.sort((a, b) => b.score - a.score);
        candidates = candidates.slice(0, 5);
      } catch {
        return 0;
      }
    }

    let linkedCount = 0;

    for (const candidate of candidates) {
      if (candidate.score < 0.6) continue;

      // Load candidate artifact for contradiction/supersedes detection
      const oldArtifact = cachedPrepare(db,
        'SELECT id, artifact_ref, summary, content, timestamp_epoch_ms FROM artifacts WHERE id = ?'
      ).get(candidate.id) as {
        id: number;
        artifact_ref: string | null;
        summary: string;
        content: string | null;
        timestamp_epoch_ms: number;
      } | undefined;

      if (!oldArtifact) continue;

      // Determine link type — contradiction takes priority over supersedes.
      // If artifacts contradict each other, active forgetting applies instead of superseding.
      let linkType: ArtifactLinkType = 'related';

      // Check for contradiction FIRST (same entity + opposing conclusions)
      if (detectContradiction(newArtifact, oldArtifact)) {
        linkType = 'contradicts';
        // Active forgetting: deprioritize the older artifact (4.2)
        const newerIsNew = newArtifact.timestamp_epoch_ms >= oldArtifact.timestamp_epoch_ms;
        if (newerIsNew) {
          applyActiveForgetting(db, oldArtifact.id);
        } else {
          applyActiveForgetting(db, newArtifact.id);
        }
      }
      // Check for supersedes (cosine > 0.85 + same entity, no contradiction)
      else if (candidate.score > 0.85 && newArtifact.artifact_ref && newArtifact.artifact_ref === oldArtifact.artifact_ref) {
        linkType = 'supersedes';
        // Flag the older artifact as superseded
        flagSupersededByCosine(db, oldArtifact.id, newArtifact.id, candidate.score, 0.85);
      }

      insertArtifactLink(db, newArtifact.id, candidate.id, linkType, candidate.score);
      linkedCount++;
    }

    return linkedCount;
  } catch {
    return 0;
  }
}

