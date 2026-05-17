/**
 * Phase 14-07e — link-distance retrieval boost.
 *
 * Computes per-candidate link distance to a set of query artifacts and applies
 * an additive ranking boost. Behind feature flag CLAUDEX_LINK_DISTANCE_BOOST.
 *
 * Formula (locked in 14-07-CONTEXT):
 *   tier_multiplier = link_tier === 'hard' ? 1.0 : 0.5
 *   boost = boost_weight * tier_multiplier * (1 / hop_distance)
 *   boosted_score = original_score * (1 + boost)
 *
 * Where:
 *   - hop_distance: shortest link-path distance from any query artifact to the candidate
 *   - boost_weight: configurable (CLAUDEX_LINK_DISTANCE_BOOST_WEIGHT env, default 0.1)
 *   - link_tier: 'hard' for operator-confirmed hard links, 'soft' otherwise
 *   - Weakest-link semantics: path tier = weakest tier in path
 *     (a path of soft → hard → soft is 'soft' overall)
 *
 * Anti-scope: Read-only. Does not write links. Does not modify link-writer.ts.
 * Project scoping is enforced by the underlying listSoftLinks / listConfirmedHardLinks
 * queries which filter on the src artifact's project column.
 */

import type { Database } from 'better-sqlite3';
import { handleClaudexTrace } from '../mcp/tools/claudex-trace.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default boost weight. Configurable via CLAUDEX_LINK_DISTANCE_BOOST_WEIGHT env. */
export const BOOST_WEIGHT_DEFAULT = 0.1;

/** Tier weight multipliers — hard links survived operator review; stronger signal. */
export const TIER_MULTIPLIER_HARD = 1.0;
export const TIER_MULTIPLIER_SOFT = 0.5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Candidate {
  artifact_id: string;
  score: number;
  [key: string]: unknown;
}

export interface BoostParams {
  candidates: Candidate[];
  /** Typically the top-K reranked result IDs used as boost seeds. */
  query_artifact_ids: string[];
  project: string;
  /** Max hops for link distance computation. Default 3. */
  max_hops?: number;
  /** Boost weight. Default BOOST_WEIGHT_DEFAULT. */
  boost_weight?: number;
}

export interface LinkDistance {
  hop_distance: number;
  /** Weakest link tier in the shortest path. */
  link_tier: 'soft' | 'hard';
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the shortest link-graph distance between two artifacts.
 *
 * Uses `handleClaudexTrace` to walk outward from `src_id` and checks
 * whether `dst_id` appears in the neighborhood.
 *
 * Weakest-link tier semantics: a path of soft → hard → soft is 'soft'.
 * A path of all-hard is 'hard'. The returned tier is the weakest link
 * in the shortest path as reconstructed from path_via_links.
 *
 * Returns null if `dst_id` is unreachable within `max_hops`.
 * Returns { hop_distance: 0, link_tier: 'hard' } when src === dst (same artifact).
 */
export function computeLinkDistance(
  db: Database,
  src_id: string,
  dst_id: string,
  max_hops: number,
): LinkDistance | null {
  // Same artifact — trivial case
  if (src_id === dst_id) {
    return { hop_distance: 0, link_tier: 'hard' };
  }

  const traceResult = handleClaudexTrace(db, {
    artifact_id: src_id,
    max_hops,
    direction: 'both',
  });

  const found = traceResult.results.find(r => r.artifact_id === dst_id);
  if (!found) return null;

  // Determine tier by inspecting the path.
  // The path records link types in traversal order; we determine the weakest tier.
  const tier = inferPathTier(db, found.path_via_links);

  return { hop_distance: found.hop_distance, link_tier: tier };
}

/**
 * Apply link-distance boost to a candidate list.
 *
 * For each candidate, computes the MINIMUM hop_distance from any query artifact
 * in `query_artifact_ids`. Applies the boost formula. Candidates with no
 * reachable link within max_hops are returned with their original score.
 *
 * Returns a new candidate list, re-sorted by boosted_score descending.
 * Original candidate objects are spread (shallow copy) — original `score`
 * field is replaced by the boosted score; a `boosted_score` field is added.
 */
export function applyLinkDistanceBoost(
  db: Database,
  params: BoostParams,
): Candidate[] {
  const {
    candidates,
    query_artifact_ids,
    max_hops = 3,
    boost_weight = BOOST_WEIGHT_DEFAULT,
  } = params;

  if (candidates.length === 0 || query_artifact_ids.length === 0) {
    return [...candidates];
  }

  // Precompute trace for each query artifact (one BFS per seed, up to max_hops)
  // Trace results are used to look up distances for all candidates efficiently.
  type TraceMap = Map<string, { hop_distance: number; tier: 'soft' | 'hard' }>;
  const tracesByQueryId = new Map<string, TraceMap>();

  for (const qId of query_artifact_ids) {
    const traceResult = handleClaudexTrace(db, {
      artifact_id: qId,
      max_hops,
      direction: 'both',
    });

    const traceMap: TraceMap = new Map();
    for (const row of traceResult.results) {
      const tier = inferPathTier(db, row.path_via_links);
      traceMap.set(row.artifact_id, { hop_distance: row.hop_distance, link_tier: tier });
    }
    tracesByQueryId.set(qId, traceMap);
  }

  // For each candidate, find the minimum distance across all query seeds
  const boosted = candidates.map(candidate => {
    let minDist = Infinity;
    let bestTier: 'soft' | 'hard' = 'soft';

    for (const [, traceMap] of tracesByQueryId) {
      const entry = traceMap.get(candidate.artifact_id);
      if (entry) {
        if (entry.hop_distance < minDist) {
          minDist = entry.hop_distance;
          bestTier = entry.link_tier;
        } else if (entry.hop_distance === minDist && entry.link_tier === 'hard') {
          // Same distance but stronger link tier — prefer hard
          bestTier = 'hard';
        }
      }
    }

    if (minDist === Infinity || minDist === 0) {
      // Unreachable or self: no boost (hop_distance=0 = same artifact, formula becomes boost_weight * 1.0 / 0 = Inf — skip)
      return { ...candidate };
    }

    const tier_mult = bestTier === 'hard' ? TIER_MULTIPLIER_HARD : TIER_MULTIPLIER_SOFT;
    const boost = boost_weight * tier_mult * (1 / minDist);
    const boosted_score = candidate.score * (1 + boost);

    return { ...candidate, score: boosted_score };
  });

  // Re-sort by boosted score descending
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Infer the weakest link tier from a path's step list.
 *
 * Soft link types: 'supersedes', 'promoted_to', 'extracted_from', 'references'
 * Hard link types: 'triggered_by', 'evidence_for', 'contradicts'
 *
 * A path is 'hard' only if all links in the path are hard-link types.
 * Any soft link in the path makes the entire path 'soft' (weakest-link).
 *
 * Empty path (hop_distance = 0, same artifact): treated as 'hard'.
 */
function inferPathTier(
  _db: Database,
  path: Array<{ type: string; via_artifact_id: string }>,
): 'soft' | 'hard' {
  if (path.length === 0) return 'hard';

  const HARD_LINK_TYPES = new Set(['triggered_by', 'evidence_for', 'contradicts']);

  for (const step of path) {
    if (!HARD_LINK_TYPES.has(step.type)) {
      return 'soft';
    }
  }
  return 'hard';
}
