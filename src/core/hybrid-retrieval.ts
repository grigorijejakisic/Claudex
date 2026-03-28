/**
 * Hybrid Retrieval — multi-signal search combining FTS5, vector KNN, recency, and graph walk.
 *
 * Four retrieval channels (async path):
 *   1. FTS5 keyword match (SQLite) → ranked list A
 *   2. Qdrant KNN with metadata filters → ranked list B
 *   3. Recency-sorted (newest first) → ranked list C
 *   4. Graph walk via artifact_links (2-hop) → ranked list D
 *
 * Sync path uses channels 1+3 only (no vector, no graph walk).
 *
 * Fusion: Reciprocal Rank Fusion (RRF): RRF_score(d) = Σ 1/(60 + rank_i(d))
 * Scoring: Three-factor per-artifact: α·recency + β·importance + γ·relevance
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
import type { ArtifactRow } from './artifacts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  const now = Math.floor(Date.now() / 1000);
  const lastAccess = artifact.last_materialized_epoch ?? artifact.timestamp_epoch;
  const hoursSinceAccess = Math.max(0, (now - lastAccess) / 3600);
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
 * Compute three-factor score for an artifact.
 * score = α·recency + β·importance + γ·relevance
 *
 * When no relevance score is available (no embedding match), uses
 * the artifact's retrieval_score as a proxy (normalized to [0, 1]).
 */
export function computeThreeFactorScore(
  artifact: ArtifactRow,
  relevance: number,
  weights: Required<ScoringWeights> = DEFAULT_WEIGHTS,
): number {
  const recency = computeRecencyScore(artifact);
  const importance = computeImportanceScore(artifact);
  return weights.alpha * recency + weights.beta * importance + weights.gamma * relevance;
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
): ArtifactRow[] {
  try {
    const keywords = tokenizeQuery(query, 5);
    if (keywords.length === 0) return [];

    const ftsQuery = keywords.join(' OR ');
    const supersededFilter = excludeSuperseded ? 'AND a.superseded_by IS NULL' : '';
    const projectFilter = globalScope ? '' : 'AND a.project = ?';
    const orderPrefix = globalScope
      ? 'CASE WHEN a.project = ? THEN 0 ELSE 1 END,'
      : '';

    const sql = `SELECT a.* FROM artifacts a
       JOIN artifacts_fts fts ON fts.rowid = a.id
       WHERE artifacts_fts MATCH ?
         ${projectFilter}
         ${supersededFilter}
       ORDER BY ${orderPrefix}
         bm25(artifacts_fts, 2.0, 1.0),
         a.importance DESC
       LIMIT ?`;

    const params = globalScope
      ? [ftsQuery, project, limit]
      : [ftsQuery, project, limit];

    return cachedPrepare(db, sql).all(...params) as ArtifactRow[];
  } catch {
    // FTS may fail — fall back to LIKE search
    try {
      return searchLikeFallback(db, project, query, limit, globalScope, excludeSuperseded);
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
): ArtifactRow[] {
  const keywords = tokenizeQuery(query, 5);
  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => '(LOWER(a.summary) LIKE ? OR LOWER(a.content) LIKE ?)').join(' OR ');
  const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
  const supersededFilter = excludeSuperseded ? 'AND a.superseded_by IS NULL' : '';
  const projectFilter = globalScope ? '' : 'AND a.project = ?';
  const orderPrefix = globalScope
    ? 'CASE WHEN a.project = ? THEN 0 ELSE 1 END,'
    : '';

  const sql = `SELECT a.* FROM artifacts a
     WHERE (${conditions})
       ${projectFilter}
       ${supersededFilter}
     ORDER BY ${orderPrefix}
       a.importance DESC, a.timestamp_epoch DESC
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
        const row = cachedPrepare(db,
          'SELECT * FROM artifacts WHERE id = ?'
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
): ArtifactRow[] {
  try {
    const supersededFilter = excludeSuperseded ? 'AND superseded_by IS NULL' : '';
    const projectFilter = globalScope ? '' : 'AND project = ?';
    const orderPrefix = globalScope
      ? 'CASE WHEN project = ? THEN 0 ELSE 1 END,'
      : '';

    const sql = `SELECT * FROM artifacts
       WHERE state != 'packed'
         ${projectFilter}
         ${supersededFilter}
       ORDER BY ${orderPrefix}
         timestamp_epoch DESC
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
        cachedPrepare(db,
          `UPDATE artifacts SET activation_score = MAX(?, activation_score - ?)
           WHERE id = ? AND activation_score IS NOT NULL`
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

    // Channel 1: FTS5
    const fts5Results = searchFts5Channel(db, project, query, limit * 2, globalScope, excludeSuperseded);

    // Channel 3: Recency
    const recencyResults = searchRecencyChannel(db, project, limit, globalScope, excludeSuperseded);

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

      const threeFactor = computeThreeFactorScore(artifact, Math.min(1, relevance), weights);

      // 5.2: Apply retrieval_score as multiplier — artifacts that consistently help
      // get boosted, those that don't get demoted. retrieval_score defaults to 1.0.
      const retrievalMultiplier = getRetrievalScoreMultiplier(db, artifactId);

      // Wire novelty_score into scoring — novel artifacts (score > 0.5) get boosted,
      // redundant ones (score < 0.5) get demoted. Default 0.5 = neutral.
      const noveltyMultiplier = 0.5 + (artifact.novelty_score ?? 0.5);

      // Activation factor: artifacts with decayed activation_score get demoted in ranking.
      // This makes RIF suppression (Phase 14) affect ranking directly, not just packing.
      const activationFactor = Math.max(0.1, artifact.activation_score ?? 1.0);

      // Final score: base_score * retrieval_score * novelty * activation
      const baseScore = rrfScore * (1 + threeFactor);
      const hybridScore = baseScore * retrievalMultiplier * noveltyMultiplier * activationFactor;

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

    // Channel 1: FTS5 (sync)
    const fts5Results = searchFts5Channel(db, project, query, limit * 2, globalScope, excludeSuperseded);

    // Channel 2: Qdrant vector search (async, graceful degradation)
    let vectorResults: { artifact: ArtifactRow; score: number }[] = [];
    try {
      const { embedQuery } = await import('../embeddings/embed-pipeline.js');
      const queryEmbedding = await embedQuery(query);
      if (queryEmbedding) {
        vectorResults = await searchVectorChannel(db, project, queryEmbedding, limit, options);
      }
    } catch { /* Qdrant/embeddings unavailable — degrade to 2-channel */ }

    // Channel 3: Recency (sync)
    const recencyResults = searchRecencyChannel(db, project, limit, globalScope, excludeSuperseded);

    // Convert to channel results for RRF
    const fts5Channel: ChannelResult[] = fts5Results.map((a, i) => ({ artifactId: a.id, rank: i + 1, artifact: a }));
    const vectorChannel: ChannelResult[] = vectorResults.map((r, i) => ({ artifactId: r.artifact.id, rank: i + 1, artifact: r.artifact }));
    const recencyChannel: ChannelResult[] = recencyResults.map((a, i) => ({ artifactId: a.id, rank: i + 1, artifact: a }));

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
              const row = cachedPrepare(db,
                'SELECT * FROM artifacts WHERE id = ?'
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
    const rrfScores = rrfMerge(channels);

    // Build artifact map (include graph walk hydrated artifacts)
    const artifactMap = new Map<number, ArtifactRow>();
    for (const a of fts5Results) artifactMap.set(a.id, a);
    for (const r of vectorResults) artifactMap.set(r.artifact.id, r.artifact);
    for (const a of recencyResults) artifactMap.set(a.id, a);
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

      const threeFactor = computeThreeFactorScore(artifact, Math.min(1, relevance), weights);
      const retrievalMultiplier = getRetrievalScoreMultiplier(db, artifactId);
      const noveltyMultiplier = 0.5 + (artifact.novelty_score ?? 0.5);
      const activationFactor = Math.max(0.1, artifact.activation_score ?? 1.0);
      const baseScore = rrfScore * (1 + threeFactor);
      const hybridScore = baseScore * retrievalMultiplier * noveltyMultiplier * activationFactor;

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

    // Cross-encoder reranking (Hindsight-inspired): after RRF + three-factor scoring,
    // run a neural cross-encoder that jointly scores (query, candidate) pairs.
    // Uses Ollama with a reranking model. Non-blocking: skips if unavailable.
    // Only reranks top candidates (not the full set) for performance.
    try {
      const topCandidates = scored.slice(0, Math.min(20, scored.length));
      if (topCandidates.length > 1) {
        const response = await fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'nomic-embed-text',
            prompt: `Rate relevance 0-10 for query "${query.substring(0, 200)}" vs each document. Return only numbers separated by commas.\n` +
              topCandidates.map((c, i) => `${i}: ${(c.content ?? '').substring(0, 150)}`).join('\n'),
            stream: false,
          }),
          signal: AbortSignal.timeout(3000), // 3s max — don't block assembly
        });
        if (response.ok) {
          const data = await response.json() as { response: string };
          const scores = data.response.match(/\d+(\.\d+)?/g)?.map(Number);
          if (scores && scores.length >= topCandidates.length) {
            for (let i = 0; i < topCandidates.length; i++) {
              // Blend cross-encoder score with existing hybrid score (30% CE, 70% hybrid)
              const ceNormalized = (scores[i] ?? 5) / 10;
              topCandidates[i].hybrid_score = topCandidates[i].hybrid_score * 0.7 + ceNormalized * 0.3;
            }
            topCandidates.sort((a, b) => b.hybrid_score - a.hybrid_score);
            // Replace scored top section with reranked version
            scored.splice(0, topCandidates.length, ...topCandidates);
          }
        }
      }
    } catch { /* Cross-encoder unavailable — proceed with RRF-only scores */ }

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
  const now = Math.floor(Date.now() / 1000);
  const lastAccess = artifact.last_materialized_epoch ?? artifact.timestamp_epoch;
  const hoursSinceAccess = Math.max(0, (now - lastAccess) / 3600);

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
    // Batch read + JS compute (SQLite doesn't have LN())
    const artifacts = cachedPrepare(db,
      `SELECT id, importance, timestamp_epoch, last_materialized_epoch, state
       FROM artifacts
       WHERE project = ? AND state != 'packed'`
    ).all(project) as Array<{
      id: number;
      importance: number;
      timestamp_epoch: number;
      last_materialized_epoch: number | null;
      state: string;
    }>;

    if (artifacts.length === 0) return { packed: 0, total: 0 };

    const updateStmt = cachedPrepare(db,
      `UPDATE artifacts SET activation_score = ? WHERE id = ?`
    );

    const packStmt = cachedPrepare(db,
      `UPDATE artifacts SET state = 'packed', activation_score = ? WHERE id = ?`
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
    const now = Math.floor(Date.now() / 1000);

    // Re-compute activation with fresh access data
    const art = cachedPrepare(db,
      'SELECT importance, timestamp_epoch, last_materialized_epoch FROM artifacts WHERE id = ?'
    ).get(artifactId) as {
      importance: number;
      timestamp_epoch: number;
      last_materialized_epoch: number | null;
    } | undefined;

    if (!art) return;

    // Access count gets +1, hours_since resets to 0
    const importanceBoost = (art.importance - 3) * 0.3;
    // Fresh access: hours_since = 0, ln(0+1) = 0, so activation = ln(accessCount+1) + boost
    // We don't know exact access_count, but refreshing to a high value is appropriate
    const activation = Math.log(3) + importanceBoost; // ~1.1 + boost

    cachedPrepare(db,
      `UPDATE artifacts
       SET activation_score = ?, last_materialized_epoch = ?
       WHERE id = ?`
    ).run(activation, now, artifactId);
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
    // Get the source artifact's activation score
    const source = cachedPrepare(db,
      `SELECT activation_score FROM artifacts WHERE id = ?`
    ).get(artifactId) as { activation_score: number | null } | undefined;

    if (!source) return;
    const sourceActivation = source.activation_score ?? 1.0;

    // Get all links where this artifact is the source
    const links = cachedPrepare(db,
      `SELECT target_id, strength FROM artifact_links WHERE source_id = ?`
    ).all(artifactId) as Array<{ target_id: number; strength: number }>;

    for (const link of links) {
      const boost = SPREAD_FACTOR * link.strength * sourceActivation;
      if (boost <= 0) continue;

      // Read current activation, apply boost, write back — skip packed artifacts
      const target = cachedPrepare(db,
        `SELECT activation_score, state FROM artifacts WHERE id = ?`
      ).get(link.target_id) as { activation_score: number | null; state: string } | undefined;

      if (!target || target.state === 'packed') continue;
      const currentActivation = target.activation_score ?? 0;
      const newActivation = Math.min(currentActivation + boost, 10.0); // Cap to prevent unbounded growth

      cachedPrepare(db,
        `UPDATE artifacts SET activation_score = ? WHERE id = ?`
      ).run(newActivation, link.target_id);
    }
  } catch {
    // Non-throwing
  }
}
