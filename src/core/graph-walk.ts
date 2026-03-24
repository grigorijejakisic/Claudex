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

const DEFAULT_OPTIONS: Required<GraphWalkOptions> = {
  maxDepth: 2,
  minScore: 0.05,
  dampening: 0.5,
  limit: 10,
};

// ---------------------------------------------------------------------------
// Graph walk
// ---------------------------------------------------------------------------

/**
 * Walk the artifact_links graph from seed IDs, discovering related artifacts
 * via 2-hop traversal with dampened scores.
 *
 * Algorithm:
 * 1. Start with seed IDs at depth 0, score 1.0
 * 2. For each node, follow outgoing links (WHERE invalid_at_epoch IS NULL)
 * 3. Multiply score by: dampening * link_strength * link_type_multiplier
 * 4. Skip if result score < minScore or depth >= maxDepth
 * 5. Track visited IDs to prevent cycles
 * 6. Return non-seed artifacts sorted by max walk_score
 *
 * Uses iterative BFS instead of SQL recursive CTE because:
 * - Link-type multipliers need JS lookup (not available in SQLite)
 * - Cycle detection is cleaner in JS (no need for string concatenation tricks)
 * - Batch SQL queries per depth level (2 queries max)
 *
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

    // Track best score per artifact ID (across all paths)
    const bestScores = new Map<number, number>();
    const seedSet = new Set(seedIds);

    // Initialize seeds with score 1.0
    const frontier: Array<{ id: number; score: number; depth: number }> = [];
    for (const id of seedIds) {
      frontier.push({ id, score: 1.0, depth: 0 });
    }

    // Visited set for cycle detection
    const visited = new Set<number>(seedIds);

    // BFS by depth level
    let currentDepth = 0;
    let currentLevel = frontier;

    while (currentDepth < opts.maxDepth && currentLevel.length > 0) {
      // Collect all IDs at this level for batch query
      const levelIds = currentLevel.map(n => n.id);
      const scoreMap = new Map<number, number>();
      for (const n of currentLevel) {
        const existing = scoreMap.get(n.id) ?? 0;
        scoreMap.set(n.id, Math.max(existing, n.score));
      }

      // Batch fetch outgoing links for all nodes at this level
      // SQLite doesn't support array params, so we use a placeholder per ID
      const placeholders = levelIds.map(() => '?').join(',');
      const links = cachedPrepare(db,
        `SELECT source_id, target_id, link_type, strength
         FROM artifact_links
         WHERE source_id IN (${placeholders})
           AND invalid_at_epoch IS NULL`
      ).all(...levelIds) as Array<{
        source_id: number;
        target_id: number;
        link_type: string;
        strength: number;
      }>;

      const nextLevel: Array<{ id: number; score: number; depth: number }> = [];

      for (const link of links) {
        const typeMultiplier = LINK_TYPE_MULTIPLIERS[link.link_type] ?? 1.0;

        // Skip contradicts edges (multiplier = 0)
        if (typeMultiplier === 0) continue;

        const sourceScore = scoreMap.get(link.source_id) ?? 0;
        const walkScore = sourceScore * opts.dampening * link.strength * typeMultiplier;

        // Prune low-signal paths
        if (walkScore < opts.minScore) continue;

        const targetId = link.target_id;

        // Track best score for non-seed artifacts
        if (!seedSet.has(targetId)) {
          const existing = bestScores.get(targetId) ?? 0;
          if (walkScore > existing) {
            bestScores.set(targetId, walkScore);
          }
        }

        // Only continue walking if not visited (cycle detection)
        if (!visited.has(targetId)) {
          visited.add(targetId);
          nextLevel.push({ id: targetId, score: walkScore, depth: currentDepth + 1 });
        }
      }

      currentLevel = nextLevel;
      currentDepth++;
    }

    // Convert to sorted results
    const results: WalkedArtifact[] = [];
    for (const [artifactId, walkScore] of bestScores) {
      results.push({ artifactId, walkScore });
    }

    results.sort((a, b) => b.walkScore - a.walkScore);
    return results.slice(0, opts.limit);
  } catch {
    return [];
  }
}
