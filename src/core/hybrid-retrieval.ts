/**
 * Hybrid Retrieval — multi-signal search combining FTS5, vector KNN, recency, and graph walk.
 *
 * Retrieval channels (async path):
 *   1. FTS5 keyword match (SQLite) → ranked list A
 *   2. Qdrant KNN with metadata filters → ranked list B
 *   3. Recency-sorted (newest first) → ranked list C
 *   4. Graph walk via artifact_links (2-hop) → ranked list D
 *   5. Temporal expression match ("yesterday"/"last week") → ranked list E
 *
 * Sync path uses channels 1+3 only (no vector, no graph walk, no temporal).
 *
 * Fusion: Reciprocal Rank Fusion (RRF): RRF_score(d) = Σ 1/(60 + rank_i(d))
 *
 * Scoring (Phase 6 consolidation): one canonical function `computeArtifactScore`
 * walks both the inner three-factor sum and the four outer multipliers.
 * Sync and async paths now produce identical scores from identical inputs.
 *
 *   hybrid_score = rrfScore
 *                * (1 + α·recency + β·importance + γ·relevance)
 *                * retrievalMultiplier
 *                * noveltyMultiplier
 *                * activationFactor
 *
 * Each of the six multipliers has a single home (helper function) and
 * one ablation flag (multiplierFlags[name]). See `computeArtifactScore`
 * and `06-03-CONSOLIDATION-NOTE.md` for the documented weight vector.
 *
 * Graceful degradation:
 *   All 4 channels → full RRF (4 channels)
 *   Graph walk fails → 3-channel RRF
 *   Qdrant down → FTS5 + recency only (2 channels)
 *   Embeddings unavailable → FTS5 only (1 channel, current behavior)
 *
 * All public functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';
import { tokenizeQuery } from '../shared/search-utils.js';
import { getRetrievalScoreMultiplier } from '../intelligence/retrieval-feedback.js';
import { graphWalkFromSeeds } from './graph-walk.js';
import { getPolicy } from '../intelligence/policy-registry.js';
import {
  incrementRerankerFallbackCounter,
  type RerankerFallbackReason,
} from './telemetry-counters.js';
import type { ArtifactRow } from './artifacts.js';
import { isSubstantive, substantiveSqlClause } from './artifact-filters.js';

// ---------------------------------------------------------------------------
// 14-07b: V17 migration helpers
// ---------------------------------------------------------------------------

/**
 * SQL SELECT expression that projects V17 `artifact` columns into the legacy
 * `ArtifactRow` shape so callers see an unchanged interface post-migration.
 *
 * Key mappings (per RCA-3 loss-map in 14-07-VERIFICATION-PASS.md Section A3):
 *   id                TEXT  → rowid INTEGER  (stable within query lifetime)
 *   title             TEXT  → summary TEXT
 *   body              TEXT  → content TEXT
 *   confidence        REAL  → importance REAL (×5 reverse-scales to legacy 0-5 range)
 *   status            TEXT  → state TEXT      (active→fresh, stale→packed, superseded→materialized)
 *   data.activation_score   → activation_score REAL
 *   data.retrieval_score    → retrieval_score REAL
 *   data.novelty_score      → novelty_score REAL
 *   supersedes_id     TEXT  → superseded_by NULL (direction-flip; integer not reconstructable)
 *   created_at_epoch_ms INTEGER → timestamp_epoch_ms (same unit)
 *   embedding_ref     → embedding NULL (sidecar; not inlined in row)
 */
const V17_TO_ARTIFACT_ROW_SELECT = `
  a.rowid AS id,
  a.kind AS artifact_type,
  NULL AS artifact_ref,
  a.title AS summary,
  a.body AS content,
  CASE a.status
    WHEN 'active' THEN 'fresh'
    WHEN 'stale' THEN 'packed'
    WHEN 'superseded' THEN 'materialized'
    ELSE 'fresh'
  END AS state,
  a.project,
  a.session_id,
  a.created_at_epoch_ms AS timestamp_epoch_ms,
  COALESCE(json_extract(a.data, '$.last_materialized_epoch'), a.created_at_epoch_ms) AS last_materialized_epoch_ms,
  COALESCE(a.confidence * 5.0, 3.0) AS importance,
  COALESCE(json_extract(a.data, '$.retrieval_score'), 1.0) AS retrieval_score,
  COALESCE(json_extract(a.data, '$.activation_score'), 1.0) AS activation_score,
  COALESCE(json_extract(a.data, '$.novelty_score'), 0.5) AS novelty_score,
  COALESCE(json_extract(a.data, '$.ttl'), 3) AS ttl,
  a.confidence AS confidence,
  NULL AS superseded_by,
  NULL AS valid_until,
  NULL AS embedding
`.trim();

/**
 * V17-aware substantive filter clause for the `artifact` table (kind column).
 * Mirrors substantiveSqlClause() but targets V17's `kind` + `title`/`body`.
 * Note: uses `title` as the summary column and `confidence*5` for the importance gate.
 */
function v17SubstantiveSqlClause(tableAlias: string): string {
  const a = tableAlias;
  const v17Kinds = [
    "'learning'", "'decision'", "'memory_file'", "'flow'", "'milestone'",
    "'entity_summary'", "'handoff'", "'mental_model'", "'directive_rule'",
    "'critical_rule'", "'angel_opinion'", "'experience_pattern'",
  ].join(', ');
  const noiseGlob = [
    `${a}.title GLOB 'Read: *'`, `${a}.title GLOB 'Edit: *'`,
    `${a}.title GLOB 'Write: *'`, `${a}.title GLOB 'Bash: *'`,
    `${a}.title GLOB 'MultiEdit: *'`, `${a}.title GLOB 'Glob: *'`,
    `${a}.title GLOB 'Grep: *'`, `${a}.title GLOB 'NotebookEdit: *'`,
    `${a}.title GLOB 'TodoWrite: *'`,
  ].join(' OR ');
  return (
    `NOT (${noiseGlob})` +
    ` AND (` +
      `${a}.kind IN (${v17Kinds})` +
      ` OR (` +
        `${a}.kind = 'observation'` +
        ` AND COALESCE(${a}.confidence * 5.0, 0) >= 4` +
        ` AND LENGTH(COALESCE(${a}.title, '')) >= 60` +
      `)` +
    `)`
  );
}

/** V17 status field equivalent of legacy `state != 'packed'`. */
const V17_NOT_STALE = `a.status != 'stale'`;

/** V17 equivalent of legacy `superseded_by IS NULL`. */
const V17_NOT_SUPERSEDED = `a.status != 'superseded'`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Names of the seven scoring multipliers exposed by hybrid retrieval.
 *
 * Inner three (consumed by `computeThreeFactorScore`):
 *   recency, importance, relevance — three-factor base.
 *
 * Outer three (applied as multiplicative scaling on `rrfScore * (1 + threeFactor)`):
 *   retrieval — feedback-driven retrieval_score multiplier.
 *   novelty   — novelty_score-based boost / demote.
 *   activation— activation_score gating (RIF surface).
 *
 * Used by the Phase 6 ablation harness via `HybridSearchOptions.multiplierFlags`.
 */
export type MultiplierName =
  | 'recency'
  | 'importance'
  | 'relevance'
  | 'retrieval'
  | 'novelty'
  | 'activation';

export interface HybridSearchOptions {
  /** Maximum results to return. Default: 10 */
  limit?: number;
  /** Minimum importance filter. Default: none */
  minImportance?: number;
  /** Filter by artifact types. Default: all types */
  artifactTypes?: string[];
  /** Exclude superseded artifacts. Default: true */
  excludeSuperseded?: boolean;
  /** Include cross-project results. Default: true */
  globalScope?: boolean;
  /** Three-factor scoring weights */
  weights?: ScoringWeights;
  /**
   * Intent-driven recency weight override.
   * Applied as alpha in three-factor scoring.
   * Higher values favor recent artifacts, 0 ignores recency.
   * When set, overrides weights.alpha.
   */
  recencyWeight?: number;
  /**
   * Token budget for greedy packing. When set, retrieval stops adding results
   * when the next result would exceed this budget. Maximizes context utilization.
   * If omitted, returns up to `limit` results regardless of token cost.
   */
  budgetTokens?: number;
  /**
   * Per-multiplier ablation flags (Phase 6 P5).
   *
   * Undefined or empty = all multipliers enabled (production behavior).
   * Setting a flag to `false` disables that multiplier:
   *   - inner factors (recency/importance/relevance) collapse to 0 inside
   *     `computeThreeFactorScore`,
   *   - outer multipliers (retrieval/novelty/activation) collapse to 1.0.
   *
   * With every flag set to `false`, the formula reduces to RRF-only:
   *   hybrid_score = rrfScore * (1 + 0) * 1 * 1 * 1 = rrfScore.
   *
   * Production callers MUST leave this undefined. Only the ablation harness
   * (`src/tests/integration/phase-6-multiplier-ablation.test.ts`) sets it.
   */
  multiplierFlags?: Partial<Record<MultiplierName, boolean>>;
  /**
   * Session ID for telemetry attribution (Phase 6 Plan 04 — RETR-08).
   *
   * Used by `hybridSearchAsync` when recording cross-encoder→bi-encoder
   * fallback events. If unset (e.g. an old caller), the fallback counter
   * still records the event but with a placeholder session_id. Production
   * callers (recall-server, hooks) thread their session_id through.
   */
  sessionId?: string;
  /**
   * Phase 14 Plan 14-04 — P2.7 substantive-only filter.
   *
   * When true, restricts candidate selection to substantive artifacts only,
   * using `substantiveSqlClause` (Plan 14-03) at the DB-layer for legacy
   * `artifacts` table queries, and `isSubstantive` (Plan 14-03) as a
   * post-fetch JS predicate for hydrated results that may not have a
   * `artifact_type` SQL filter applied (e.g. vector channel).
   *
   * Default: false — existing callers are unaffected.
   *
   * P2.7 Project Knowledge is the only production caller that sets this flag.
   */
  substantiveOnly?: boolean;
}

export interface ScoringWeights {
  /** Recency weight. Default: 1.0 */
  alpha?: number;
  /** Importance weight. Default: 1.0 */
  beta?: number;
  /** Relevance weight. Default: 1.0 */
  gamma?: number;
}

export interface ScoredArtifact extends ArtifactRow {
  /** Final hybrid score (RRF + three-factor) */
  hybrid_score: number;
  /** Individual channel contributions for debugging */
  score_breakdown?: {
    rrf_fts5: number;
    rrf_vector: number;
    rrf_recency: number;
    three_factor: number;
  };
}

/** Result from a single retrieval channel, pre-merge. */
interface ChannelResult {
  artifactId: number;
  rank: number;
  artifact?: ArtifactRow;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RRF smoothing constant (standard value from the Cormack et al. paper). */
const RRF_K = 60;

/** Default scoring weights — equal weight on all three factors. */
const DEFAULT_WEIGHTS: Required<ScoringWeights> = {
  alpha: 1.0,
  beta: 1.0,
  gamma: 1.0,
};

// ---------------------------------------------------------------------------
// Three-factor scoring
// ---------------------------------------------------------------------------

/**
 * Compute recency score using exponential decay.
 * recency = exp(-0.995 * hours_since_last_access)
 *
 * Uses last_materialized_epoch if available, otherwise timestamp_epoch.
 * Returns value in [0, 1] range.
 */
export function computeRecencyScore(artifact: ArtifactRow): number {
  const nowMs = Date.now();
  const lastAccessMs = artifact.last_materialized_epoch_ms ?? artifact.timestamp_epoch_ms;
  const hoursSinceAccess = Math.max(0, (nowMs - lastAccessMs) / 3600000);
  return Math.exp(-0.995 * hoursSinceAccess);
}

/**
 * Compute importance score, normalized to [0, 1].
 * importance_norm = artifact.importance / 5
 */
export function computeImportanceScore(artifact: ArtifactRow): number {
  return Math.min(1, Math.max(0, artifact.importance / 5));
}

/**
 * Per-inner-factor enable flags (Phase 6 ablation harness).
 *
 * Undefined fields and the default-`{}` argument mean "all enabled" — production
 * behavior. Setting a field to `false` zeroes that inner factor for ablation.
 */
export interface ThreeFactorFlags {
  recency?: boolean;
  importance?: boolean;
  relevance?: boolean;
}

/**
 * Compute three-factor score for an artifact.
 * score = α·recency + β·importance + γ·relevance
 *
 * When no relevance score is available (no embedding match), uses
 * the artifact's retrieval_score as a proxy (normalized to [0, 1]).
 *
 * Phase 6: optional `flags` argument lets the ablation harness disable
 * individual inner factors. Production callers omit `flags` (or pass `{}`)
 * for unchanged behavior.
 */
export function computeThreeFactorScore(
  artifact: ArtifactRow,
  relevance: number,
  weights: Required<ScoringWeights> = DEFAULT_WEIGHTS,
  flags: ThreeFactorFlags = {},
): number {
  const recency = flags.recency === false ? 0 : computeRecencyScore(artifact);
  const importance = flags.importance === false ? 0 : computeImportanceScore(artifact);
  const relevanceTerm = flags.relevance === false ? 0 : relevance;
  return weights.alpha * recency + weights.beta * importance + weights.gamma * relevanceTerm;
}

// ---------------------------------------------------------------------------
// Consolidated scoring (Phase 6 Plan 03 — path A: simplify-by-consolidation)
// ---------------------------------------------------------------------------
//
// Single canonical scoring function consumed by both `hybridSearchSync` and
// `hybridSearchAsync`. Replaces the duplicated inline scoring blocks at the
// two callsites and closes the latent qMultiplier mismatch (sync had 7,
// async had 6 outer multipliers; consolidation gives both 7 from one source).
//
// The flat weight vector is documented in
// `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-03-CONSOLIDATION-NOTE.md`.
// Future ablation can target any individual weight by passing a flag in
// `multiplierFlags`.

/**
 * Per-multiplier helper: novelty.
 *
 * Returns 0.5 + (novelty_score ?? 0.5), so a neutral artifact (novelty_score
 * = 0.5) yields 1.0; novel artifacts (>0.5) get boosted up to 1.5; redundant
 * ones (<0.5) get demoted down to 0.5. Range: [0.5, 1.5].
 */
function computeNoveltyMultiplier(artifact: ArtifactRow): number {
  return 0.5 + (artifact.novelty_score ?? 0.5);
}

/**
 * Per-multiplier helper: activation.
 *
 * Returns max(0.1, activation_score ?? 1.0). Decayed-activation artifacts
 * get demoted; the 0.1 floor prevents zero-suppress so an RIF-decayed
 * artifact can still surface if other signals are strong. Range: [0.1, 1.0+].
 */
function computeActivationFactor(artifact: ArtifactRow): number {
  return Math.max(0.1, artifact.activation_score ?? 1.0);
}

/**
 * Context passed to `computeArtifactScore` from each retrieval pipeline.
 *
 * Carries everything needed to compute the score without leaking pipeline
 * internals (rank maps, channel results, etc.) into the scoring layer.
 */
export interface ArtifactScoringContext {
  /** Database handle for retrieval-feedback lookups. */
  db: Database;
  /** Artifact ID — used by `getRetrievalScoreMultiplier`. */
  artifactId: number;
  /** Relevance proxy in [0, 1] (vector cosine, or 1/fts5_rank). */
  relevance: number;
  /** Three-factor weights (defaults if undefined). */
  weights?: Required<ScoringWeights>;
  /** Per-multiplier ablation flags (undefined = all enabled). */
  multiplierFlags?: Partial<Record<MultiplierName, boolean>>;
}

/**
 * Compute the consolidated hybrid score for a single artifact.
 *
 * Formula:
 *   hybrid_score = rrfScore
 *                * (1 + α·recency + β·importance + γ·relevance)
 *                * retrievalMultiplier
 *                * noveltyMultiplier
 *                * activationFactor
 *
 * Each multiplier honors its ablation flag — disabled inner factors zero,
 * disabled outer multipliers collapse to 1.0. With every flag set to false
 * the formula reduces to `hybrid_score = rrfScore`.
 *
 * Production callers leave `multiplierFlags` undefined for the full formula.
 * Both `hybridSearchSync` and `hybridSearchAsync` route through this single
 * function — sync↔async paths produce identical scores from identical inputs.
 */
export function computeArtifactScore(
  artifact: ArtifactRow,
  rrfScore: number,
  ctx: ArtifactScoringContext,
): number {
  const weights = ctx.weights ?? DEFAULT_WEIGHTS;
  const flags = ctx.multiplierFlags ?? {};
  const enabled = (n: MultiplierName): boolean => flags[n] !== false;

  const innerFlags: ThreeFactorFlags = {
    recency: enabled('recency'),
    importance: enabled('importance'),
    relevance: enabled('relevance'),
  };
  const threeFactor = computeThreeFactorScore(artifact, ctx.relevance, weights, innerFlags);

  const retrievalMultiplier = enabled('retrieval')
    ? getRetrievalScoreMultiplier(ctx.db, ctx.artifactId)
    : 1.0;
  const noveltyMultiplier = enabled('novelty')
    ? computeNoveltyMultiplier(artifact)
    : 1.0;
  const activationFactor = enabled('activation')
    ? computeActivationFactor(artifact)
    : 1.0;

  const baseScore = rrfScore * (1 + threeFactor);
  return baseScore * retrievalMultiplier * noveltyMultiplier * activationFactor;
}

// ---------------------------------------------------------------------------
// RRF merge
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion across multiple ranked lists.
 * RRF_score(d) = Σ 1/(K + rank_i(d))
 *
 * Each channel contributes equally regardless of how many results it returns.
 */
function rrfMerge(
  channels: ChannelResult[][],
): Map<number, number> {
  const scores = new Map<number, number>();

  for (const channel of channels) {
    for (const result of channel) {
      const existing = scores.get(result.artifactId) ?? 0;
      scores.set(result.artifactId, existing + 1 / (RRF_K + result.rank));
    }
  }

  return scores;
}

// ---------------------------------------------------------------------------
// Channel 1: FTS5 keyword search
// ---------------------------------------------------------------------------

/**
 * FTS5 keyword search on artifacts_fts (summary + content).
 * Returns artifacts ranked by BM25 relevance.
 * Non-throwing — returns empty on FTS errors.
 */
function searchFts5Channel(
  db: Database,
  project: string,
  query: string,
  limit: number,
  globalScope: boolean,
  excludeSuperseded: boolean,
  substantiveOnly: boolean = false,
): ArtifactRow[] {
  try {
    const keywords = tokenizeQuery(query, 10);
    if (keywords.length === 0) return [];

    // Extract proper nouns (capitalized words) from original query for priority matching
    const properNouns = query.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    const uniqueProperNouns = [...new Set(properNouns.map(n => n.toLowerCase()))];

    // Build FTS5 query (deduped — FTS5 can't boost individual terms)
    const ftsQuery = [...new Set(keywords)].join(' OR ');
    // 14-07b: migrated from legacy artifacts — V17 uses status instead of superseded_by
    const supersededFilter = excludeSuperseded ? `AND ${V17_NOT_SUPERSEDED}` : '';
    const projectFilter = globalScope ? '' : 'AND a.project = ?';
    // 14-07b: migrated from legacy artifacts — use v17SubstantiveSqlClause for artifact table
    const substantiveFilter = substantiveOnly ? `AND ${v17SubstantiveSqlClause('a')}` : '';
    const orderPrefix = globalScope
      ? 'CASE WHEN a.project = ? THEN 0 ELSE 1 END,'
      : '';

    // Fetch extra results so post-boost re-ranking has room to promote proper noun matches
    const fetchLimit = uniqueProperNouns.length > 0 ? limit * 2 : limit;

    // 14-07b: migrated from legacy artifacts — artifact_fts is the V17 FTS5 table (title+body)
    const sql = `SELECT ${V17_TO_ARTIFACT_ROW_SELECT} FROM artifact a
       JOIN artifact_fts fts ON fts.rowid = a.rowid
       WHERE artifact_fts MATCH ?
         ${projectFilter}
         ${supersededFilter}
         ${substantiveFilter}
       ORDER BY ${orderPrefix}
         bm25(artifact_fts, 2.0, 1.0),
         a.confidence DESC
       LIMIT ?`;

    const params = globalScope
      ? [ftsQuery, project, fetchLimit]
      : [ftsQuery, project, fetchLimit];

    let results = cachedPrepare(db, sql).all(...params) as ArtifactRow[];

    // Post-FTS5 proper noun boosting: promote results containing proper nouns to the top
    if (uniqueProperNouns.length > 0 && results.length > 1) {
      const boosted: ArtifactRow[] = [];
      const rest: ArtifactRow[] = [];
      for (const r of results) {
        const summaryLower = (r.summary ?? '').toLowerCase();
        const hasProperNoun = uniqueProperNouns.some(n => summaryLower.includes(n));
        (hasProperNoun ? boosted : rest).push(r);
      }
      results = [...boosted, ...rest].slice(0, limit);
    } else {
      results = results.slice(0, limit);
    }

    return results;
  } catch {
    // FTS may fail — fall back to LIKE search
    try {
      return searchLikeFallback(db, project, query, limit, globalScope, excludeSuperseded, substantiveOnly);
    } catch {
      return [];
    }
  }
}

/**
 * LIKE-based fallback when FTS5 is unavailable.
 * Non-throwing.
 */
function searchLikeFallback(
  db: Database,
  project: string,
  query: string,
  limit: number,
  globalScope: boolean,
  excludeSuperseded: boolean,
  substantiveOnly: boolean = false,
): ArtifactRow[] {
  const keywords = tokenizeQuery(query, 5);
  if (keywords.length === 0) return [];

  // 14-07b: migrated from legacy artifacts — V17 uses title/body instead of summary/content
  const conditions = keywords.map(() => '(LOWER(a.title) LIKE ? OR LOWER(a.body) LIKE ?)').join(' OR ');
  const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
  // 14-07b: migrated from legacy artifacts — V17 uses status instead of superseded_by
  const supersededFilter = excludeSuperseded ? `AND ${V17_NOT_SUPERSEDED}` : '';
  const projectFilter = globalScope ? '' : 'AND a.project = ?';
  // 14-07b: migrated from legacy artifacts — use v17SubstantiveSqlClause for artifact table
  const substantiveFilter = substantiveOnly ? `AND ${v17SubstantiveSqlClause('a')}` : '';
  const orderPrefix = globalScope
    ? 'CASE WHEN a.project = ? THEN 0 ELSE 1 END,'
    : '';

  // 14-07b: migrated from legacy artifacts
  const sql = `SELECT ${V17_TO_ARTIFACT_ROW_SELECT} FROM artifact a
     WHERE (${conditions})
       ${projectFilter}
       ${supersededFilter}
       ${substantiveFilter}
     ORDER BY ${orderPrefix}
       a.confidence DESC, a.created_at_epoch_ms DESC
     LIMIT ?`;

  const params = globalScope
    ? [...likeParams, project, limit]
    : [...likeParams, project, limit];

  return cachedPrepare(db, sql).all(...params) as ArtifactRow[];
}

// ---------------------------------------------------------------------------
// Channel 2: Vector KNN (Qdrant)
// ---------------------------------------------------------------------------

/**
 * Qdrant vector search channel.
 * Returns artifacts with cosine similarity scores.
 * Non-throwing — returns empty when Qdrant is unavailable.
 *
 * This is async because Qdrant is an external service, but the caller
 * handles the async boundary.
 */
async function searchVectorChannel(
  db: Database,
  project: string,
  queryEmbedding: number[],
  limit: number,
  options: HybridSearchOptions,
): Promise<{ artifact: ArtifactRow; score: number }[]> {
  try {
    // Dynamic import to avoid circular dependencies and keep Qdrant optional
    const { searchArtifacts } = await import('../embeddings/qdrant-client.js');

    const qdrantResults = await searchArtifacts(
      queryEmbedding,
      project,
      limit,
      {
        minImportance: options.minImportance,
        artifactTypes: options.artifactTypes,
        excludeSuperseded: options.excludeSuperseded ?? true,
      },
    );

    if (qdrantResults.length === 0) return [];

    // Hydrate full artifact rows from SQLite (Qdrant payload has metadata, not full row)
    const results: { artifact: ArtifactRow; score: number }[] = [];
    for (const r of qdrantResults) {
      const artifactId = typeof r.id === 'number' ? r.id : (r.payload?.artifact_id as number);
      if (!artifactId) continue;

      try {
        // 14-07b: migrated from legacy artifacts — hydrate from V17 artifact via rowid
      const row = cachedPrepare(db,
          `SELECT ${V17_TO_ARTIFACT_ROW_SELECT} FROM artifact a WHERE a.rowid = ?`
        ).get(artifactId) as ArtifactRow | undefined;

        if (row) {
          results.push({ artifact: row, score: r.score });
        }
      } catch {
        // Individual row fetch failure — skip this result
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Channel 3: Recency-sorted
// ---------------------------------------------------------------------------

/**
 * Recency channel — returns the most recent non-packed artifacts.
 * Provides temporal context regardless of query relevance.
 * Non-throwing.
 */
function searchRecencyChannel(
  db: Database,
  project: string,
  limit: number,
  globalScope: boolean,
  excludeSuperseded: boolean,
  substantiveOnly: boolean = false,
): ArtifactRow[] {
  try {
    // 14-07b: migrated from legacy artifacts — V17 uses status field
    const supersededFilter = excludeSuperseded ? `AND ${V17_NOT_SUPERSEDED}` : '';
    const projectFilter = globalScope ? '' : 'AND a.project = ?';
    // 14-07b: migrated from legacy artifacts — V17 substantive clause
    const substantiveFilter = substantiveOnly
      ? `AND ${v17SubstantiveSqlClause('a')}`
      : '';
    const orderPrefix = globalScope
      ? 'CASE WHEN a.project = ? THEN 0 ELSE 1 END,'
      : '';

    // 14-07b: migrated from legacy artifacts — uses V17_NOT_STALE (status != 'stale') instead of state != 'packed'
    const sql = `SELECT ${V17_TO_ARTIFACT_ROW_SELECT} FROM artifact a
       WHERE ${V17_NOT_STALE}
         ${projectFilter}
         ${supersededFilter}
         ${substantiveFilter}
       ORDER BY ${orderPrefix}
         a.created_at_epoch_ms DESC
       LIMIT ?`;

    const params = globalScope
      ? [project, limit]
      : [project, limit];

    return cachedPrepare(db, sql).all(...params) as ArtifactRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Retrieval-Induced Suppression (RIF) — Phase 14
// ---------------------------------------------------------------------------

/** RIF activation decrement per non-selected candidate. */
const RIF_DECREMENT = 0.03;

/** Minimum RRF score for a candidate to be subject to RIF.
 * With RRF_K=60 and 4 channels, max possible score is 4*(1/60)=0.067.
 * Threshold must be below this to be reachable.
 * @deprecated Use getPolicy().shouldSuppressCandidate() instead. Kept for reference. */
export const RIF_MIN_RRF = 0.01;

/** Minimum activation score floor after RIF. */
const RIF_ACTIVATION_FLOOR = 0.1;

/**
 * Apply retrieval-induced suppression to non-selected candidates.
 *
 * Candidates that scored above RIF_MIN_RRF in RRF but were not selected
 * (below the top-K cutoff) get a small activation_score decrement.
 * Suppression decision delegated to MemoryPolicy.shouldSuppressCandidate().
 *
 * Based on psychology's retrieval-induced forgetting: non-selected
 * candidates are actively suppressed when competitors are retrieved.
 *
 * Non-throwing.
 */
export function applyRetrievalInducedSuppression(
  db: Database,
  rrfScores: Map<number, number>,
  selectedIds: Set<number>,
): void {
  try {
    const policy = getPolicy();

    for (const [artifactId, rrfScore] of rrfScores) {
      // Delegate suppression decision to memory policy
      if (policy.shouldSuppressCandidate(rrfScore) && !selectedIds.has(artifactId)) {
        // 14-07b: migrated from legacy artifacts — activation_score lives in data JSON on V17
        cachedPrepare(db,
          `UPDATE artifact
           SET data = json_set(data, '$.activation_score',
             MAX(?, COALESCE(json_extract(data, '$.activation_score'), 1.0) - ?))
           WHERE rowid = ? AND json_extract(data, '$.activation_score') IS NOT NULL`
        ).run(RIF_ACTIVATION_FLOOR, RIF_DECREMENT, artifactId);
      }
    }
  } catch {
    // Non-throwing — RIF is a best-effort side-effect
  }
}

// ---------------------------------------------------------------------------
// Main hybrid search (sync)
// ---------------------------------------------------------------------------

/**
 * Synchronous hybrid search — FTS5 + recency channels only.
 * Used when vector search is unavailable or when async is not possible.
 *
 * Applies RRF merge across FTS5 and recency channels, then re-scores
 * with the three-factor formula (using FTS5 rank as relevance proxy).
 *
 * Non-throwing — returns empty array on any error.
 */
export function hybridSearchSync(
  db: Database,
  query: string,
  project: string,
  options: HybridSearchOptions = {},
): ScoredArtifact[] {
  try {
    const limit = options.limit ?? 10;
    const excludeSuperseded = options.excludeSuperseded ?? true;
    const globalScope = options.globalScope ?? true;
    const weights = {
      ...DEFAULT_WEIGHTS,
      ...options.weights,
      // Intent-driven recency override takes precedence over weights.alpha
      ...(options.recencyWeight != null ? { alpha: options.recencyWeight } : {}),
    } as Required<ScoringWeights>;

    if (!query || query.length < 3) return [];

    const substantiveOnly = options.substantiveOnly ?? false;

    // Channel 1: FTS5
    const fts5Results = searchFts5Channel(db, project, query, limit * 2, globalScope, excludeSuperseded, substantiveOnly);

    // Channel 3: Recency
    const recencyResults = searchRecencyChannel(db, project, limit, globalScope, excludeSuperseded, substantiveOnly);

    // Convert to channel results for RRF
    const fts5Channel: ChannelResult[] = fts5Results.map((a, i) => ({
      artifactId: a.id,
      rank: i + 1,
      artifact: a,
    }));

    const recencyChannel: ChannelResult[] = recencyResults.map((a, i) => ({
      artifactId: a.id,
      rank: i + 1,
      artifact: a,
    }));

    // RRF merge
    const rrfScores = rrfMerge([fts5Channel, recencyChannel]);

    // Build artifact map for hydration
    const artifactMap = new Map<number, ArtifactRow>();
    for (const a of fts5Results) artifactMap.set(a.id, a);
    for (const a of recencyResults) artifactMap.set(a.id, a);

    // Build RRF breakdown per artifact
    const fts5RankMap = new Map<number, number>();
    const recencyRankMap = new Map<number, number>();
    for (const r of fts5Channel) fts5RankMap.set(r.artifactId, r.rank);
    for (const r of recencyChannel) recencyRankMap.set(r.artifactId, r.rank);

    // Score and rank
    const scored: ScoredArtifact[] = [];
    for (const [artifactId, rrfScore] of rrfScores) {
      const artifact = artifactMap.get(artifactId);
      if (!artifact) continue;

      // Use FTS5 rank position as relevance proxy (normalized: 1.0 for rank 1, decaying)
      const fts5Rank = fts5RankMap.get(artifactId);
      const relevance = fts5Rank != null ? 1.0 / fts5Rank : 0.1;

      // Phase 6 consolidation: single canonical scoring function for both
      // sync and async paths. See computeArtifactScore + 06-03-CONSOLIDATION-NOTE.md.
      const hybridScore = computeArtifactScore(artifact, rrfScore, {
        db,
        artifactId,
        relevance: Math.min(1, relevance),
        weights,
        multiplierFlags: options.multiplierFlags,
      });

      // Three-factor reported in score_breakdown for debugging — recompute
      // inline (cheap; doesn't duplicate the multiplier chain). The
      // breakdown's `three_factor` field reflects what the production
      // formula would produce given options.multiplierFlags.
      const innerFlags: ThreeFactorFlags = {
        recency: options.multiplierFlags?.recency !== false,
        importance: options.multiplierFlags?.importance !== false,
        relevance: options.multiplierFlags?.relevance !== false,
      };
      const threeFactor = computeThreeFactorScore(artifact, Math.min(1, relevance), weights, innerFlags);

      scored.push({
        ...artifact,
        hybrid_score: hybridScore,
        score_breakdown: {
          rrf_fts5: fts5RankMap.has(artifactId) ? 1 / (RRF_K + (fts5RankMap.get(artifactId) ?? RRF_K)) : 0,
          rrf_vector: 0,
          rrf_recency: recencyRankMap.has(artifactId) ? 1 / (RRF_K + (recencyRankMap.get(artifactId) ?? RRF_K)) : 0,
          three_factor: threeFactor,
        },
      });
    }

    // Sort by hybrid_score descending, take top-K
    scored.sort((a, b) => b.hybrid_score - a.hybrid_score);
    const selected = scored.slice(0, limit);

    // Phase 14: RIF — suppress non-selected candidates that scored above threshold
    const selectedIds = new Set(selected.map(s => s.id));
    applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

    return selected;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main hybrid search (async, full pipeline)
// ---------------------------------------------------------------------------

/**
 * Full async hybrid search — FTS5 + Qdrant KNN + recency + graph walk channels.
 * Uses up to 4 channels via RRF for best retrieval quality.
 *
 * Channel 4 (graph walk) uses top-K seeds from channels 1-3 to discover
 * related artifacts via artifact_links (2-hop traversal). Non-throwing:
 * graph walk failure falls back to 3-channel RRF.
 *
 * Graceful degradation: if Qdrant/embeddings unavailable, falls back to
 * FTS5 + recency (equivalent to hybridSearchSync).
 *
 * Non-throwing — returns empty array on any error.
 */
export async function hybridSearchAsync(
  db: Database,
  query: string,
  project: string,
  options: HybridSearchOptions = {},
): Promise<ScoredArtifact[]> {
  try {
    const limit = options.limit ?? 10;
    const excludeSuperseded = options.excludeSuperseded ?? true;
    const globalScope = options.globalScope ?? true;
    const weights = {
      ...DEFAULT_WEIGHTS,
      ...options.weights,
      // Intent-driven recency override takes precedence over weights.alpha
      ...(options.recencyWeight != null ? { alpha: options.recencyWeight } : {}),
    } as Required<ScoringWeights>;

    if (!query || query.length < 3) return [];

    const substantiveOnly = options.substantiveOnly ?? false;

    // Channel 1: FTS5 (sync)
    const fts5Results = searchFts5Channel(db, project, query, limit * 2, globalScope, excludeSuperseded, substantiveOnly);

    // Channel 2: Qdrant vector search (async, graceful degradation)
    let vectorResults: { artifact: ArtifactRow; score: number }[] = [];
    try {
      const { embedQuery } = await import('../embeddings/embed-pipeline.js');
      const queryEmbedding = await embedQuery(query);
      if (queryEmbedding) {
        vectorResults = await searchVectorChannel(db, project, queryEmbedding, limit, options);
        // Phase 14 Plan 14-04: P2.7 substantive-only filter applied post-fetch for
        // vector results (they're hydrated from artifacts by ID; SQL filter not applicable here).
        if (substantiveOnly) {
          vectorResults = vectorResults.filter(r => isSubstantive(r.artifact));
        }
      }
    } catch { /* Qdrant/embeddings unavailable — degrade to 2-channel */ }

    // Channel 3: Recency (sync)
    const recencyResults = searchRecencyChannel(db, project, limit, globalScope, excludeSuperseded, substantiveOnly);

    // Channel 5: Temporal (sync) — time-range search when query contains temporal expressions
    let temporalResults: ArtifactRow[] = [];
    try {
      const timeRange = parseTemporalExpression(query);
      if (timeRange) {
        // 14-07b: migrated from legacy artifacts — V17 uses status/created_at_epoch_ms
        const temporalSuperseded = excludeSuperseded ? `AND ${V17_NOT_SUPERSEDED}` : '';
        const temporalProject = globalScope ? '' : 'AND a.project = ?';
        const temporalSql = `SELECT ${V17_TO_ARTIFACT_ROW_SELECT} FROM artifact a
           WHERE 1=1 ${temporalProject} ${temporalSuperseded}
             AND a.created_at_epoch_ms >= ? AND a.created_at_epoch_ms <= ?
           ORDER BY a.confidence DESC, a.created_at_epoch_ms DESC
           LIMIT ?`;
        const temporalParams = globalScope
          ? [timeRange.start, timeRange.end, limit]
          : [project, timeRange.start, timeRange.end, limit];
        temporalResults = cachedPrepare(db, temporalSql).all(...temporalParams) as ArtifactRow[];
      }
    } catch { /* temporal parse failure — skip channel */ }

    // Convert to channel results for RRF
    const fts5Channel: ChannelResult[] = fts5Results.map((a, i) => ({ artifactId: a.id, rank: i + 1, artifact: a }));
    const vectorChannel: ChannelResult[] = vectorResults.map((r, i) => ({ artifactId: r.artifact.id, rank: i + 1, artifact: r.artifact }));
    const recencyChannel: ChannelResult[] = recencyResults.map((a, i) => ({ artifactId: a.id, rank: i + 1, artifact: a }));
    const temporalChannel: ChannelResult[] = temporalResults.map((a, i) => ({ artifactId: a.id, rank: i + 1, artifact: a }));

    // Channel 4: Graph walk — discover related artifacts via artifact_links (Phase 17)
    // Uses top-K seeds from initial 3-channel results, non-throwing
    let graphChannel: ChannelResult[] = [];
    try {
      // Pre-merge to get seed IDs (top candidates from FTS5 + vector + recency)
      const seedChannels = [fts5Channel, recencyChannel];
      if (vectorChannel.length > 0) seedChannels.push(vectorChannel);
      const seedScores = rrfMerge(seedChannels);

      // Extract top-K artifact IDs as seeds for graph walk
      const seedEntries = [...seedScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      const seedIds = seedEntries.map(([id]) => id);

      if (seedIds.length > 0) {
        const walked = graphWalkFromSeeds(db, seedIds, { limit: 10 });

        if (walked.length > 0) {
          // Hydrate walked artifact rows from SQLite
          for (let i = 0; i < walked.length; i++) {
            try {
              // 14-07b: migrated from legacy artifacts — hydrate from V17 artifact via rowid
              const row = cachedPrepare(db,
                `SELECT ${V17_TO_ARTIFACT_ROW_SELECT} FROM artifact a WHERE a.rowid = ?`
              ).get(walked[i].artifactId) as ArtifactRow | undefined;

              if (row) {
                graphChannel.push({
                  artifactId: walked[i].artifactId,
                  rank: i + 1,
                  artifact: row,
                });
              }
            } catch { /* individual hydration failure — skip */ }
          }
        }
      }
    } catch { /* Graph walk failure — fall back to 3-channel RRF */ }

    // RRF merge (all available channels, including graph walk as 4th)
    const channels = [fts5Channel, recencyChannel];
    if (vectorChannel.length > 0) channels.push(vectorChannel);
    if (graphChannel.length > 0) channels.push(graphChannel);
    if (temporalChannel.length > 0) channels.push(temporalChannel);
    const rrfScores = rrfMerge(channels);

    // Build artifact map (include graph walk hydrated artifacts)
    const artifactMap = new Map<number, ArtifactRow>();
    for (const a of fts5Results) artifactMap.set(a.id, a);
    for (const r of vectorResults) artifactMap.set(r.artifact.id, r.artifact);
    for (const a of recencyResults) artifactMap.set(a.id, a);
    for (const a of temporalResults) artifactMap.set(a.id, a);
    for (const g of graphChannel) {
      if (g.artifact) artifactMap.set(g.artifactId, g.artifact);
    }

    // Score and rank — all lookups via O(1) maps
    const fts5RankMap = new Map(fts5Channel.map(r => [r.artifactId, r.rank]));
    const vectorScoreMap = new Map(vectorResults.map(r => [r.artifact.id, r.score]));
    const vectorRankMap = new Map(vectorChannel.map(r => [r.artifactId, r.rank]));
    const recencyRankMap = new Map(recencyChannel.map(r => [r.artifactId, r.rank]));

    const scored: ScoredArtifact[] = [];
    for (const [artifactId, rrfScore] of rrfScores) {
      const artifact = artifactMap.get(artifactId);
      if (!artifact) continue;

      // Use vector score as relevance when available, FTS5 rank as fallback
      const vectorScore = vectorScoreMap.get(artifactId);
      const fts5Rank = fts5RankMap.get(artifactId);
      const relevance = vectorScore ?? (fts5Rank != null ? 1.0 / fts5Rank : 0.1);

      // Phase 6 consolidation: single canonical scoring function for both
      // sync and async paths. Closes the prior sync↔async qMultiplier
      // mismatch — async now applies all 7 multipliers via the same helper
      // the sync path uses. See computeArtifactScore + 06-03-CONSOLIDATION-NOTE.md.
      const hybridScore = computeArtifactScore(artifact, rrfScore, {
        db,
        artifactId,
        relevance: Math.min(1, relevance),
        weights,
        multiplierFlags: options.multiplierFlags,
      });

      // Three-factor reported in score_breakdown for debugging.
      const innerFlags: ThreeFactorFlags = {
        recency: options.multiplierFlags?.recency !== false,
        importance: options.multiplierFlags?.importance !== false,
        relevance: options.multiplierFlags?.relevance !== false,
      };
      const threeFactor = computeThreeFactorScore(artifact, Math.min(1, relevance), weights, innerFlags);

      const vRank = vectorRankMap.get(artifactId);
      const rRank = recencyRankMap.get(artifactId);
      scored.push({
        ...artifact,
        hybrid_score: hybridScore,
        score_breakdown: {
          rrf_fts5: fts5RankMap.has(artifactId) ? 1 / (RRF_K + (fts5RankMap.get(artifactId) ?? RRF_K)) : 0,
          rrf_vector: vRank != null ? 1 / (RRF_K + vRank) : 0,
          rrf_recency: rRank != null ? 1 / (RRF_K + rRank) : 0,
          three_factor: threeFactor,
        },
      });
    }

    scored.sort((a, b) => b.hybrid_score - a.hybrid_score);

    // Cross-encoder reranking: BAAI/bge-reranker-v2-m3 (~568M params) via the
    // local Python microservice supervised by Angel's RerankerSupervisor.
    // True neural cross-encoder that jointly scores (query, document) pairs —
    // materially more precise than bi-encoder cosine on reranking tasks. Runs
    // on GPU (CUDA/ROCm). The cross-encoder is **load-bearing infrastructure
    // (RETR-08)** — bi-encoder fallback below is a degraded mode, recorded
    // in telemetry as `event_kind='reranker_fallback'`. Non-blocking: 3s
    // timeout per call. Skips if < 2 candidates.
    try {
      const topCandidates = scored.slice(0, Math.min(20, scored.length));
      if (topCandidates.length > 1) {
        const documents = topCandidates.map(c =>
          ((c.summary ?? '') + ' ' + (c.content ?? '')).substring(0, 300)
        );

        // Try cross-encoder reranker service (port 7439, CUDA)
        let reranked = false;
        // Capture WHY the cross-encoder failed so the bi-encoder branch can
        // record an attributed fallback event (Phase 6 P5 — RETR-08).
        let ceFailureReason: RerankerFallbackReason | null = null;
        try {
          const ceResponse = await fetch('http://127.0.0.1:7439/rerank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query.substring(0, 500), documents }),
            signal: AbortSignal.timeout(3000),
          });
          if (!ceResponse.ok) {
            ceFailureReason = 'non_2xx';
          } else {
            const ceData = await ceResponse.json() as { scores: number[]; indices: number[] };
            if (ceData.scores && ceData.scores.length > 0) {
              // Map scores back to candidates by index
              const scoreMap = new Map<number, number>();
              for (let i = 0; i < ceData.indices.length; i++) {
                scoreMap.set(ceData.indices[i], ceData.scores[i]);
              }
              // Normalize CE scores to 0-1 range
              const maxCE = Math.max(...ceData.scores, 0.001);
              for (let i = 0; i < topCandidates.length; i++) {
                const ceNorm = (scoreMap.get(i) ?? 0) / maxCE;
                // Blend: 40% cross-encoder, 60% hybrid (CE gets more weight than bi-encoder)
                topCandidates[i].hybrid_score = topCandidates[i].hybrid_score * 0.6 + ceNorm * 0.4;
              }
              topCandidates.sort((a, b) => b.hybrid_score - a.hybrid_score);
              scored.splice(0, topCandidates.length, ...topCandidates);
              reranked = true;
            } else {
              ceFailureReason = 'empty_response';
            }
          }
        } catch (e) {
          // AbortSignal.timeout fires AbortError; fetch network failure throws TypeError.
          const name = (e as { name?: string } | null)?.name;
          ceFailureReason = (name === 'TimeoutError' || name === 'AbortError') ? 'timeout' : 'unreachable';
        }

        // Bi-encoder fallback: snowflake-arctic-embed2 cosine similarity.
        // RETR-08: this branch is degraded mode — record one telemetry row
        // per fallback event with the captured reason. Non-throwing.
        if (!reranked) {
          if (ceFailureReason !== null) {
            incrementRerankerFallbackCounter(
              db,
              options.sessionId ?? 'unknown-session',
              ceFailureReason,
            );
          }
          try {
            const texts = [
              query.substring(0, 500),
              ...documents,
            ];
            const response = await fetch('http://localhost:11434/api/embed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'snowflake-arctic-embed2', input: texts }),
              signal: AbortSignal.timeout(3000),
            });
            if (response.ok) {
              const data = await response.json() as { embeddings: number[][] };
              if (data.embeddings && data.embeddings.length === texts.length) {
                const queryEmb = data.embeddings[0];
                const queryNorm = Math.sqrt(queryEmb.reduce((s, v) => s + v * v, 0)) || 1;
                for (let i = 0; i < topCandidates.length; i++) {
                  const docEmb = data.embeddings[i + 1];
                  const docNorm = Math.sqrt(docEmb.reduce((s, v) => s + v * v, 0)) || 1;
                  let dot = 0;
                  for (let d = 0; d < queryEmb.length; d++) dot += queryEmb[d] * docEmb[d];
                  const cosine = dot / (queryNorm * docNorm);
                  topCandidates[i].hybrid_score = topCandidates[i].hybrid_score * 0.7 + cosine * 0.3;
                }
                topCandidates.sort((a, b) => b.hybrid_score - a.hybrid_score);
                scored.splice(0, topCandidates.length, ...topCandidates);
              }
            }
          } catch { /* bi-encoder also unavailable */ }
        }
      }
    } catch { /* Reranking unavailable — proceed with RRF-only scores */ }

    // Token budget-aware greedy packing: stop adding results when budget is full.
    let selected: ScoredArtifact[];
    if (options.budgetTokens && options.budgetTokens > 0) {
      selected = [];
      let usedTokens = 0;
      for (const item of scored) {
        const itemTokens = Math.ceil((item.content?.length ?? 100) / 4);
        if (usedTokens + itemTokens > options.budgetTokens && selected.length > 0) break;
        selected.push(item);
        usedTokens += itemTokens;
        if (selected.length >= limit) break;
      }
    } else {
      selected = scored.slice(0, limit);
    }

    // Phase 14: RIF — suppress non-selected candidates that scored above threshold
    const selectedIds = new Set(selected.map(s => s.id));
    applyRetrievalInducedSuppression(db, rrfScores, selectedIds);

    return selected;
  } catch {
    // Full async pipeline failed — fall back to sync (FTS5 + recency, no vector)
    return hybridSearchSync(db, query, project, options);
  }
}

// ---------------------------------------------------------------------------
// ACT-R Activation Decay
// ---------------------------------------------------------------------------

/**
 * Compute ACT-R activation score for an artifact.
 *
 * activation = ln(access_count + 1) - 0.5 * ln(hours_since_last_access + 1) + importance_boost
 * importance_boost = (importance - 3) * 0.3
 *
 * Since artifacts don't track access_count directly, we use materialization
 * count as a proxy (each materialization = 1 access). The number of times
 * an artifact has been materialized is approximated by the difference between
 * initial TTL and current TTL plus materialization events.
 *
 * For simplicity and correctness, we compute activation from the available data:
 * - Uses last_materialized_epoch or timestamp_epoch as last access time
 * - Uses a base access count of 1 (creation = 1 access)
 */
export function computeActivation(artifact: ArtifactRow): number {
  const nowMs = Date.now();
  const lastAccessMs = artifact.last_materialized_epoch_ms ?? artifact.timestamp_epoch_ms;
  const hoursSinceAccess = Math.max(0, (nowMs - lastAccessMs) / 3600000);

  // Approximate access count: 1 (creation) + materializations
  // Materialized artifacts were accessed at least once more
  const accessBonus = artifact.state === 'materialized' ? 1 : 0;
  const accessCount = 1 + accessBonus;

  const importanceBoost = (artifact.importance - 3) * 0.3;

  return Math.log(accessCount + 1) - 0.5 * Math.log(hoursSinceAccess + 1) + importanceBoost;
}

/**
 * Decay activation scores for all non-packed artifacts in a project.
 * Replaces tickArtifactTTL with ACT-R cognitive decay.
 *
 * Artifacts with activation_score < 0.1 become eligible for pruning
 * (set to packed state).
 *
 * Returns count of newly packed artifacts and total updated.
 * Non-throwing.
 */
export function decayActivationScores(
  db: Database,
  project: string,
): { packed: number; total: number } {
  try {
    // 14-07b: migrated from legacy artifacts — read from V17 artifact table
    // Batch read + JS compute (SQLite doesn't have LN())
    const artifacts = cachedPrepare(db,
      `SELECT
         a.rowid AS id,
         COALESCE(a.confidence * 5.0, 3.0) AS importance,
         a.created_at_epoch_ms AS timestamp_epoch_ms,
         COALESCE(json_extract(a.data, '$.last_materialized_epoch'), a.created_at_epoch_ms) AS last_materialized_epoch_ms,
         a.status AS state
       FROM artifact a
       WHERE a.project = ? AND ${V17_NOT_STALE}`
    ).all(project) as Array<{
      id: number;
      importance: number;
      timestamp_epoch_ms: number;
      last_materialized_epoch_ms: number | null;
      state: string;
    }>;

    if (artifacts.length === 0) return { packed: 0, total: 0 };

    // 14-07b: migrated from legacy artifacts — activation_score and status in V17 data/status
    const updateStmt = cachedPrepare(db,
      `UPDATE artifact SET data = json_set(data, '$.activation_score', ?) WHERE rowid = ?`
    );

    const packStmt = cachedPrepare(db,
      `UPDATE artifact SET status = 'stale', data = json_set(data, '$.activation_score', ?) WHERE rowid = ?`
    );

    let packed = 0;
    let total = 0;

    for (const art of artifacts) {
      // Use the shared computeActivation formula — single source of truth
      const activation = computeActivation(art as unknown as ArtifactRow);

      if (activation < 0.1) {
        packStmt.run(activation, art.id);
        packed++;
      } else {
        updateStmt.run(activation, art.id);
      }
      total++;
    }

    return { packed, total };
  } catch {
    return { packed: 0, total: 0 };
  }
}

/**
 * Record an access event for an artifact — increments its activation.
 * Called when an artifact is retrieved (materialized, included in assembly, MCP recall).
 * Updates last_materialized_epoch as access timestamp.
 * Non-throwing.
 */
export function recordArtifactAccess(
  db: Database,
  artifactId: number,
): void {
  try {
    // 14-07b: migrated from legacy artifacts — read from V17 artifact table via rowid
    const art = cachedPrepare(db,
      `SELECT
         COALESCE(confidence * 5.0, 3.0) AS importance,
         created_at_epoch_ms AS timestamp_epoch_ms,
         COALESCE(json_extract(data, '$.last_materialized_epoch'), created_at_epoch_ms) AS last_materialized_epoch_ms
       FROM artifact WHERE rowid = ?`
    ).get(artifactId) as {
      importance: number;
      timestamp_epoch_ms: number;
      last_materialized_epoch_ms: number | null;
    } | undefined;

    if (!art) return;

    // Access count gets +1, hours_since resets to 0
    const importanceBoost = (art.importance - 3) * 0.3;
    // Fresh access: hours_since = 0, ln(0+1) = 0, so activation = ln(accessCount+1) + boost
    // We don't know exact access_count, but refreshing to a high value is appropriate
    const activation = Math.log(3) + importanceBoost; // ~1.1 + boost

    // 14-07b: migrated from legacy artifacts — activation in data JSON, last_materialized in data sidecar
    cachedPrepare(db,
      `UPDATE artifact
       SET data = json_set(data,
         '$.activation_score', ?,
         '$.last_materialized_epoch', ?)
       WHERE rowid = ?`
    ).run(activation, Date.now(), artifactId);
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Part 5.3: Spreading Activation
// ---------------------------------------------------------------------------

/** Spreading activation decay factor — controls how much activation spreads. */
const SPREAD_FACTOR = 0.3;

/**
 * After materializing artifact A, boost activation scores of linked artifacts.
 * Formula: linked_artifact.activation += 0.3 * link_strength * source_artifact.activation
 *
 * This surfaces related context without explicit search — when artifact A is
 * retrieved, its linked neighbors become more likely to surface in subsequent
 * retrievals via their boosted activation scores.
 *
 * Queries artifact_links WHERE source_id = A.id, applies boost to each target.
 * Unidirectional: source → targets only. Reverse links not processed.
 *
 * Non-throwing.
 */
export function spreadActivation(
  db: Database,
  artifactId: number,
): void {
  try {
    // 14-07b: migrated from legacy artifacts — activation_score is in data JSON on V17
    const source = cachedPrepare(db,
      `SELECT COALESCE(json_extract(data, '$.activation_score'), 1.0) AS activation_score
       FROM artifact WHERE rowid = ?`
    ).get(artifactId) as { activation_score: number | null } | undefined;

    if (!source) return;
    const sourceActivation = source.activation_score ?? 1.0;

    // Get all links where this artifact is the source (artifact_links uses rowid-based IDs)
    const links = cachedPrepare(db,
      `SELECT target_id, strength FROM artifact_links WHERE source_id = ?`
    ).all(artifactId) as Array<{ target_id: number; strength: number }>;

    for (const link of links) {
      const boost = SPREAD_FACTOR * link.strength * sourceActivation;
      if (boost <= 0) continue;

      // 14-07b: migrated from legacy artifacts — read status + activation from V17 data JSON
      const target = cachedPrepare(db,
        `SELECT COALESCE(json_extract(data, '$.activation_score'), 0) AS activation_score,
                status AS state FROM artifact WHERE rowid = ?`
      ).get(link.target_id) as { activation_score: number | null; state: string } | undefined;

      if (!target || target.state === 'stale') continue;
      const currentActivation = target.activation_score ?? 0;
      const newActivation = Math.min(currentActivation + boost, 10.0); // Cap to prevent unbounded growth

      // 14-07b: migrated from legacy artifacts — write activation to data JSON
      cachedPrepare(db,
        `UPDATE artifact SET data = json_set(data, '$.activation_score', ?) WHERE rowid = ?`
      ).run(newActivation, link.target_id);
    }
  } catch {
    // Non-throwing
  }
}

// ---------------------------------------------------------------------------
// Temporal expression parser (Channel 5)
// ---------------------------------------------------------------------------

/**
 * Parse natural language temporal expressions into epoch time ranges.
 * Rule-based — no LLM needed. Handles common patterns:
 *   "yesterday", "last week", "3 days ago", "today", "this week",
 *   "last month", "past hour", "recent", etc.
 *
 * Returns null if no temporal expression detected.
 */
function parseTemporalExpression(query: string): { start: number; end: number } | null {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const HOUR = 3600;
  const lower = query.toLowerCase();

  // "yesterday"
  if (/\byesterday\b/.test(lower)) {
    const todayStart = now - (now % DAY);
    return { start: todayStart - DAY, end: todayStart };
  }

  // "today"
  if (/\btoday\b/.test(lower)) {
    const todayStart = now - (now % DAY);
    return { start: todayStart, end: now };
  }

  // "N days ago" / "last N days" / "past N days"
  const daysMatch = lower.match(/(\d+)\s*days?\s*ago|(?:last|past)\s*(\d+)\s*days?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1] ?? daysMatch[2], 10);
    if (days > 0 && days <= 365) return { start: now - days * DAY, end: now };
  }

  // "N hours ago" / "last N hours" / "past N hours"
  const hoursMatch = lower.match(/(\d+)\s*hours?\s*ago|(?:last|past)\s*(\d+)\s*hours?/);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1] ?? hoursMatch[2], 10);
    if (hours > 0 && hours <= 168) return { start: now - hours * HOUR, end: now };
  }

  // "last week" / "this week" / "past week"
  if (/\b(?:last|past)\s*week\b/.test(lower)) return { start: now - 7 * DAY, end: now };
  if (/\bthis\s*week\b/.test(lower)) {
    const dayOfWeek = new Date().getDay();
    return { start: now - dayOfWeek * DAY, end: now };
  }

  // "last month" / "past month"
  if (/\b(?:last|past)\s*month\b/.test(lower)) return { start: now - 30 * DAY, end: now };

  // "recent" / "recently" / "latest"
  if (/\b(?:recent(?:ly)?|latest)\b/.test(lower)) return { start: now - 3 * DAY, end: now };

  // "last session" / "previous session"
  if (/\b(?:last|previous)\s*session\b/.test(lower)) return { start: now - DAY, end: now };

  return null;
}
