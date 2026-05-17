/**
 * Graph Walk — 2-hop traversal of artifact_links for relationship-based retrieval.
 *
 * Given seed artifact IDs (from initial RRF results), walks the artifact_links
 * graph to find related artifacts that weren't surfaced by keyword/vector/recency
 * channels. Acts as a 4th RRF channel in hybridSearchAsync().
 *
 * Design:
 *   - Recursive CTE with cycle detection (visited ID tracking)
 *   - Max depth: 2 hops
 *   - Dampening: 0.5 per hop (score halves at each step)
 *   - Min walk score: 0.05 (prune low-signal paths)
 *   - Link-type multipliers: caused_by=2.0, supports=1.5, related=1.0, contradicts=0
 *   - Excludes invalidated links (invalid_at_epoch IS NOT NULL)
 *   - Returns walked artifacts sorted by walk_score DESC
 *
 * All public functions are non-throwing with safe defaults.
 */

import type { Database } from 'better-sqlite3';
import { cachedPrepare } from './stmt-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphWalkOptions {
  /** Maximum walk depth. Default: 2 */
  maxDepth?: number;
  /** Minimum score to continue walking. Default: 0.05 */
  minScore?: number;
  /** Dampening factor per hop. Default: 0.5 */
  dampening?: number;
  /** Maximum results to return. Default: 10 */
  limit?: number;
}

export interface WalkedArtifact {
  /** Artifact ID discovered via graph walk */
  artifactId: number;
  /** Walk score (dampened by hop distance and link strength) */
  walkScore: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Link-type multipliers — controls how much different edge types propagate activation. */
const LINK_TYPE_MULTIPLIERS: Record<string, number> = {
  caused_by: 2.0,
  supports: 1.5,
  related: 1.0,
  supersedes: 1.0,
  contradicts: 0, // Exclude contradicted artifacts
};

/** Temporal decay sigma — 30 days in milliseconds. Links older than this are heavily decayed. */
const TEMPORAL_DECAY_SIGMA = 30 * 24 * 3600 * 1000;

const DEFAULT_OPTIONS: Required<GraphWalkOptions> = {
  maxDepth: 2,
  minScore: 0.05,
  dampening: 0.5,
  limit: 10,
};

// ---------------------------------------------------------------------------
// Graph walk
// ---------------------------------------------------------------------------

/** Predefined meta-path patterns for MPFP traversal (Hindsight-inspired). */
const META_PATHS: Array<{ name: string; edgeTypes: string[] }> = [
  { name: 'direct_related', edgeTypes: ['related'] },
  { name: 'direct_supports', edgeTypes: ['supports'] },
  { name: 'direct_causal', edgeTypes: ['caused_by'] },
  { name: 'topic_expansion', edgeTypes: ['related', 'related'] },
  { name: 'evidence_chain', edgeTypes: ['supports', 'related'] },
  { name: 'causal_context', edgeTypes: ['caused_by', 'related'] },
  { name: 'version_chain', edgeTypes: ['supersedes'] },
  { name: 'context_evidence', edgeTypes: ['related', 'supports'] },
];

/**
 * MPFP meta-path graph traversal from seed IDs.
 * Runs multiple typed path patterns in parallel and fuses results via RRF.
 * Each pattern follows a specific sequence of edge types through the graph.
 *
 * Hindsight-inspired upgrade from simple 2-hop BFS:
 * - Predefined semantic patterns (topic expansion, evidence chain, causal, etc.)
 * - Each pattern independently traverses the graph
 * - Results fused across all patterns — artifacts found by multiple patterns score higher
 * - Temporal decay applied to link weights
 * - Lazy edge loading (per-depth-level batch queries)
 *
 * Falls back to generic BFS if no typed links exist.
 * Non-throwing — returns empty array on any error.
 */
export function graphWalkFromSeeds(
  db: Database,
  seedIds: number[],
  options?: GraphWalkOptions,
): WalkedArtifact[] {
  try {
    if (seedIds.length === 0) return [];

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const seedSet = new Set(seedIds);
    const now = Date.now();

    // Run each meta-path pattern independently, collect results per pattern
    const patternResults: Array<Map<number, number>> = [];

    for (const metaPath of META_PATHS) {
      const scores = new Map<number, number>();
      let currentIds = [...seedIds];
      let currentScores = new Map<number, number>(seedIds.map(id => [id, 1.0]));

      // Walk each hop in the meta-path
      for (let hop = 0; hop < metaPath.edgeTypes.length; hop++) {
        const edgeType = metaPath.edgeTypes[hop];
        if (currentIds.length === 0) break;

        const placeholders = currentIds.map(() => '?').join(',');
        const links = cachedPrepare(db,
          `SELECT source_id, target_id, link_type, strength, valid_at_epoch_ms
           FROM artifact_links
           WHERE source_id IN (${placeholders})
             AND link_type = ?
             AND invalid_at_epoch_ms IS NULL`
        ).all(...currentIds, edgeType) as Array<{
          source_id: number;
          target_id: number;
          link_type: string;
          strength: number;
          valid_at_epoch_ms: number | null;
        }>;

        const nextScores = new Map<number, number>();
        for (const link of links) {
          const sourceScore = currentScores.get(link.source_id) ?? 0;
          const linkAge = link.valid_at_epoch_ms ? Math.max(0, now - link.valid_at_epoch_ms) : 0;
          const temporalDecay = linkAge > 0 ? Math.exp(-linkAge / TEMPORAL_DECAY_SIGMA) : 1.0;
          // Apply link-type multiplier even in MPFP — preserves caused_by(2x), supports(1.5x) advantage
          const typeMultiplier = LINK_TYPE_MULTIPLIERS[link.link_type] ?? 1.0;
          const walkScore = sourceScore * opts.dampening * link.strength * temporalDecay * typeMultiplier;

          if (walkScore < opts.minScore) continue;

          const existing = nextScores.get(link.target_id) ?? 0;
          if (walkScore > existing) nextScores.set(link.target_id, walkScore);

          // Record non-seed discoveries
          if (!seedSet.has(link.target_id)) {
            const prev = scores.get(link.target_id) ?? 0;
            if (walkScore > prev) scores.set(link.target_id, walkScore);
          }
        }

        currentIds = [...nextScores.keys()];
        currentScores = nextScores;
      }

      if (scores.size > 0) patternResults.push(scores);
    }

    // Fallback: if no typed patterns produced results, run generic BFS (any edge type)
    if (patternResults.length === 0) {
      const genericScores = new Map<number, number>();
      let currentIds = [...seedIds];
      let currentScores = new Map<number, number>(seedIds.map(id => [id, 1.0]));
      const visited = new Set<number>(seedIds);

      for (let depth = 0; depth < opts.maxDepth; depth++) {
        if (currentIds.length === 0) break;
        const placeholders = currentIds.map(() => '?').join(',');
        const links = cachedPrepare(db,
          `SELECT source_id, target_id, link_type, strength, valid_at_epoch_ms
           FROM artifact_links
           WHERE source_id IN (${placeholders})
             AND invalid_at_epoch_ms IS NULL`
        ).all(...currentIds) as Array<{
          source_id: number; target_id: number; link_type: string;
          strength: number; valid_at_epoch_ms: number | null;
        }>;

        const nextScores = new Map<number, number>();
        for (const link of links) {
          const typeMultiplier = LINK_TYPE_MULTIPLIERS[link.link_type] ?? 1.0;
          if (typeMultiplier === 0) continue;
          const sourceScore = currentScores.get(link.source_id) ?? 0;
          const linkAge = link.valid_at_epoch ? Math.max(0, now - link.valid_at_epoch) : 0;
          const temporalDecay = linkAge > 0 ? Math.exp(-linkAge / TEMPORAL_DECAY_SIGMA) : 1.0;
          const walkScore = sourceScore * opts.dampening * link.strength * typeMultiplier * temporalDecay;
          if (walkScore < opts.minScore) continue;
          if (!seedSet.has(link.target_id)) {
            const prev = genericScores.get(link.target_id) ?? 0;
            if (walkScore > prev) genericScores.set(link.target_id, walkScore);
          }
          if (!visited.has(link.target_id)) {
            visited.add(link.target_id);
            const ex = nextScores.get(link.target_id) ?? 0;
            if (walkScore > ex) nextScores.set(link.target_id, walkScore);
          }
        }
        currentIds = [...nextScores.keys()];
        currentScores = nextScores;
      }

      if (genericScores.size > 0) patternResults.push(genericScores);
    }

    // RRF fusion across all pattern results
    // Artifacts found by multiple patterns score higher
    const rrfScores = new Map<number, number>();
    // Track the max raw walk score per artifact (preserves link-type multiplier effects)
    const maxRawScores = new Map<number, number>();
    const RRF_K = 60;
    for (const patternScores of patternResults) {
      const ranked = [...patternScores.entries()].sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < ranked.length; i++) {
        const [artifactId, rawScore] = ranked[i];
        const rrfContrib = 1 / (RRF_K + i + 1);
        rrfScores.set(artifactId, (rrfScores.get(artifactId) ?? 0) + rrfContrib);
        const prevMax = maxRawScores.get(artifactId) ?? 0;
        if (rawScore > prevMax) maxRawScores.set(artifactId, rawScore);
      }
    }

    // Final score: blend RRF (multi-pattern discovery) with raw walk score (link-type strength).
    // This ensures caused_by (2x multiplier) still outranks related (1x) even if
    // related is found by more patterns.
    const results: WalkedArtifact[] = [...rrfScores.entries()]
      .map(([artifactId, rrfScore]) => {
        const rawScore = maxRawScores.get(artifactId) ?? 0;
        return { artifactId, walkScore: rrfScore * (1 + rawScore) };
      })
      .sort((a, b) => b.walkScore - a.walkScore)
      .slice(0, opts.limit);

    return results;
  } catch {
    return [];
  }
}
