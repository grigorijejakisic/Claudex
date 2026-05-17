/**
 * Phase 14-07e — claudex_trace MCP tool handler.
 *
 * Walks the link graph via BFS from a starting artifact.
 * Returns the N-hop neighborhood with hop distance + path.
 * Reads soft_link + CONFIRMED hard_link (PENDING hard links are NOT exposed).
 *
 * Anti-scope: Read-only. Does not write any links. Does not expose pending
 * hard links. Does not modify link-writer.ts.
 */

import type { Database } from 'better-sqlite3';
import { listSoftLinks, listConfirmedHardLinks } from '../../core/link-writer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TraceParams {
  artifact_id: string;
  /** Default 3, capped at MAX_HOPS_CAP (5). */
  max_hops?: number;
  /** Optional filter on link types. null / undefined = all types. */
  types?: string[];
  /** Default 'both'. */
  direction?: 'outgoing' | 'incoming' | 'both';
}

export interface TracePathStep {
  type: string;
  via_artifact_id: string;
}

export interface TraceResultRow {
  artifact_id: string;
  kind: string;
  summary: string;
  hop_distance: number;
  /** Ordered list of link hops from the start artifact to this artifact. */
  path_via_links: TracePathStep[];
}

export interface TraceResult {
  start_artifact_id: string;
  total_reached: number;
  max_hops_used: number;
  /** Sorted: hop_distance asc, artifact_id asc. Start artifact at hop=0. */
  results: TraceResultRow[];
}

/** Hard cap on max_hops parameter. Per Locked Decision in 14-07-CONTEXT. */
export const MAX_HOPS_CAP = 5;

// ─── BFS implementation ───────────────────────────────────────────────────────

/**
 * Walk the link graph from `params.artifact_id` via BFS.
 *
 * Deduplication: if an artifact is reachable via multiple paths, only the
 * SHORTEST path is recorded (BFS naturally guarantees this — the first time
 * a node is dequeued is via the shortest path).
 *
 * Dead references (artifact deleted but link row still exists) are skipped
 * silently — `lookupArtifact` returns null and the node is not added to results.
 *
 * Pending hard links are excluded: `listConfirmedHardLinks` only returns
 * rows where `confirmed_by_session IS NOT NULL`.
 */
export function handleClaudexTrace(db: Database, params: TraceParams): TraceResult {
  const max_hops = Math.min(params.max_hops ?? 3, MAX_HOPS_CAP);
  const direction = params.direction ?? 'both';
  const type_filter: string[] | null = params.types && params.types.length > 0
    ? params.types
    : null;

  // BFS state: map from artifact_id → recorded row (first-visit wins = shortest path)
  const visited = new Map<string, TraceResultRow>();

  interface QueueEntry {
    id: string;
    distance: number;
    path: TracePathStep[];
  }

  const queue: QueueEntry[] = [
    { id: params.artifact_id, distance: 0, path: [] },
  ];

  while (queue.length > 0) {
    const node = queue.shift()!;

    if (visited.has(node.id)) continue;

    // Lookup artifact — skip dead references silently
    const artifact = lookupArtifact(db, node.id);
    if (!artifact) {
      // Still mark as visited to avoid re-queuing via other paths
      visited.set(node.id, {
        artifact_id: node.id,
        kind: 'unknown',
        summary: '',
        hop_distance: node.distance,
        path_via_links: node.path,
      });
      continue;
    }

    visited.set(node.id, {
      artifact_id: node.id,
      kind: artifact.kind,
      summary: artifact.summary,
      hop_distance: node.distance,
      path_via_links: node.path,
    });

    // Do not expand beyond max_hops
    if (node.distance >= max_hops) continue;

    // Gather neighbors
    if (direction === 'outgoing' || direction === 'both') {
      const softOut = listSoftLinks(db, node.id, 'outgoing');
      const hardOut = listConfirmedHardLinks(db, node.id, 'outgoing');

      for (const link of [...softOut, ...hardOut]) {
        if (type_filter && !type_filter.includes(link.type)) continue;
        const neighbor = link.dst;
        if (!visited.has(neighbor)) {
          queue.push({
            id: neighbor,
            distance: node.distance + 1,
            path: [...node.path, { type: link.type, via_artifact_id: node.id }],
          });
        }
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const softIn = listSoftLinks(db, node.id, 'incoming');
      const hardIn = listConfirmedHardLinks(db, node.id, 'incoming');

      for (const link of [...softIn, ...hardIn]) {
        if (type_filter && !type_filter.includes(link.type)) continue;
        const neighbor = link.src;
        if (!visited.has(neighbor)) {
          queue.push({
            id: neighbor,
            distance: node.distance + 1,
            path: [...node.path, { type: link.type, via_artifact_id: node.id }],
          });
        }
      }
    }
  }

  // Filter out dead-reference placeholders from results (kind='unknown', summary='')
  // but keep them if they are the start artifact (i.e. start artifact not found)
  const deadIds = new Set<string>();
  for (const [id, row] of visited) {
    if (row.kind === 'unknown' && row.summary === '' && id !== params.artifact_id) {
      deadIds.add(id);
    }
  }

  // Build sorted result list
  const results = Array.from(visited.values())
    .filter(row => !deadIds.has(row.artifact_id))
    .sort((a, b) => {
      if (a.hop_distance !== b.hop_distance) return a.hop_distance - b.hop_distance;
      return a.artifact_id.localeCompare(b.artifact_id);
    });

  // If start artifact was not found in DB, return empty results
  const startNotFound = visited.has(params.artifact_id) &&
    visited.get(params.artifact_id)!.kind === 'unknown' &&
    visited.get(params.artifact_id)!.summary === '';

  return {
    start_artifact_id: params.artifact_id,
    total_reached: startNotFound ? 0 : results.length,
    max_hops_used: max_hops,
    results: startNotFound ? [] : results,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function lookupArtifact(db: Database, id: string): { kind: string; summary: string } | null {
  try {
    const row = db.prepare(
      `SELECT kind, COALESCE(title, body, '') AS summary FROM artifact WHERE id = ?`
    ).get(id) as { kind: string; summary: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}
