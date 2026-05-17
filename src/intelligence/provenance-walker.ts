/**
 * Phase 14-07g — Provenance walker.
 *
 * BFS over INCOMING links from a starting artifact (typically a
 * decision or checkpoint). Returns the upstream chain — what led to
 * this artifact existing.
 *
 * Bounded by MAX_PROVENANCE_HOPS. Cycle-aware via visited set.
 * Walker direction is INCOMING only: "what led to this artifact?"
 *
 * Included link types:
 *   Soft: extracted_from, references
 *   Hard (confirmed only): triggered_by, evidence_for
 *
 * Excluded: 'contradicts' — conflict signal, not derivation.
 * Excluded: PENDING hard links — only operator-confirmed links count.
 */

import type { Database } from 'better-sqlite3';
import { listSoftLinks, listConfirmedHardLinks } from '../core/link-writer.js';
import { emitTelemetry } from '../observability/telemetry.js';
import type { SoftLinkType } from '../core/link-writer.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Hard hop cap per Phase 14-07-CONTEXT Locked Decision 3.
 * Deeper chains become noise; provenance is typically 2–4 hops.
 * Not tunable via env var in this plan — locked constant.
 */
export const MAX_PROVENANCE_HOPS = 4;

/**
 * Soft link types that carry provenance semantics.
 * 'supersedes' and 'promoted_to' are progression links, not provenance.
 */
const PROVENANCE_SOFT_TYPES: SoftLinkType[] = ['extracted_from', 'references'];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProvenanceChainEntry {
  artifact_id: string;
  kind: string;
  summary: string;
  hop_distance: number;       // 0 = the starting artifact; >=1 = upstream
  via_link_type: string | null;  // null for starting artifact; otherwise the link type used to reach this entry
  created_at_epoch_ms: number;
}

export interface WalkProvenanceParams {
  db: Database;
  start_artifact_id: string;
  session_id: string;
  /** Caps the walk depth. Defaults to MAX_PROVENANCE_HOPS; values above MAX_PROVENANCE_HOPS are clamped. */
  max_hops?: number;
}

export interface WalkProvenanceResult {
  start_artifact_id: string;
  chain: ProvenanceChainEntry[];
  total_reached: number;
  cycle_detected: boolean;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface ArtifactMetaRow {
  id: string;
  kind: string;
  title: string | null;
  body: string;
  created_at_epoch_ms: number;
}

// ─── Walker ───────────────────────────────────────────────────────────────────

/**
 * BFS walk over INCOMING links from `start_artifact_id`.
 *
 * Returns an ordered provenance chain:
 *   hop 0 = start artifact
 *   hop 1 = direct upstream (artifacts that have outgoing links pointing TO start)
 *   ...
 *
 * Sorted by hop_distance ASC, then created_at_epoch_ms DESC within each hop level.
 * Cycle-aware: visited set prevents revisiting; emits telemetry on detection.
 *
 * Non-throwing: on any DB error for an individual artifact, that entry is silently
 * skipped. Missing start artifact returns empty chain (total_reached=0).
 */
export function walkProvenance(p: WalkProvenanceParams): WalkProvenanceResult {
  const { db, start_artifact_id, session_id } = p;

  // Clamp max_hops to MAX_PROVENANCE_HOPS.
  const maxHops = Math.min(p.max_hops ?? MAX_PROVENANCE_HOPS, MAX_PROVENANCE_HOPS);

  // Resolve start artifact.
  const startRow = _fetchArtifactMeta(db, start_artifact_id);
  if (!startRow) {
    // Missing start: return empty result.
    return {
      start_artifact_id,
      chain: [],
      total_reached: 0,
      cycle_detected: false,
    };
  }

  const chain: ProvenanceChainEntry[] = [];
  // Map of artifact_id → ProvenanceChainEntry (shortest-hop-distance wins).
  const visited = new Map<string, ProvenanceChainEntry>();
  let cycleDetected = false;

  // BFS queue: [artifact_id, hop_distance, via_link_type].
  type QueueEntry = { id: string; hop: number; via: string | null };
  const queue: QueueEntry[] = [{ id: start_artifact_id, hop: 0, via: null }];

  // Seed visited with start artifact.
  const startEntry: ProvenanceChainEntry = {
    artifact_id: start_artifact_id,
    kind: startRow.kind,
    summary: _summarize(startRow),
    hop_distance: 0,
    via_link_type: null,
    created_at_epoch_ms: startRow.created_at_epoch_ms,
  };
  visited.set(start_artifact_id, startEntry);
  chain.push(startEntry);

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Do not expand beyond max_hops.
    if (current.hop >= maxHops) continue;

    // Gather incoming links for this artifact.
    const incomingLinks = _gatherIncomingLinks(db, current.id);

    for (const link of incomingLinks) {
      // The SRC of an incoming link is the upstream artifact.
      const upstreamId = link.src;

      if (visited.has(upstreamId)) {
        // Cycle: upstream already in the visited set.
        cycleDetected = true;
        emitTelemetry(
          db,
          session_id,
          'error',
          {
            subsystem: 'provenance_walker',
            error: 'cycle_detected',
            fallback: `skipped re-traversal of ${upstreamId} (already at hop ${visited.get(upstreamId)!.hop_distance})`,
          },
        );
        continue;
      }

      const upstreamRow = _fetchArtifactMeta(db, upstreamId);
      if (!upstreamRow) {
        // Dead reference — artifact deleted. Skip silently.
        continue;
      }

      const newHop = current.hop + 1;
      const entry: ProvenanceChainEntry = {
        artifact_id: upstreamId,
        kind: upstreamRow.kind,
        summary: _summarize(upstreamRow),
        hop_distance: newHop,
        via_link_type: link.type,
        created_at_epoch_ms: upstreamRow.created_at_epoch_ms,
      };

      visited.set(upstreamId, entry);
      chain.push(entry);
      queue.push({ id: upstreamId, hop: newHop, via: link.type });
    }
  }

  // Sort: hop_distance ASC, then created_at_epoch_ms DESC within each level.
  chain.sort((a, b) => {
    if (a.hop_distance !== b.hop_distance) return a.hop_distance - b.hop_distance;
    return b.created_at_epoch_ms - a.created_at_epoch_ms;
  });

  return {
    start_artifact_id,
    chain,
    total_reached: chain.length,
    cycle_detected: cycleDetected,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Fetch minimal artifact metadata needed for provenance rendering. Non-throwing; returns undefined on miss. */
function _fetchArtifactMeta(db: Database, artifact_id: string): ArtifactMetaRow | undefined {
  try {
    return db.prepare(
      `SELECT id, kind, title, body, created_at_epoch_ms FROM artifact WHERE id = ?`
    ).get(artifact_id) as ArtifactMetaRow | undefined;
  } catch {
    return undefined;
  }
}

/** Gather incoming provenance links for an artifact (soft + confirmed hard, excluding contradicts). */
function _gatherIncomingLinks(
  db: Database,
  artifact_id: string,
): Array<{ src: string; type: string }> {
  const results: Array<{ src: string; type: string }> = [];

  // Incoming soft links, filtered to provenance types.
  try {
    const softLinks = listSoftLinks(db, artifact_id, 'incoming', PROVENANCE_SOFT_TYPES);
    for (const sl of softLinks) {
      results.push({ src: sl.src, type: sl.type });
    }
  } catch { /* non-fatal — skip soft links on error */ }

  // Incoming confirmed hard links (triggered_by, evidence_for only — contradicts excluded).
  try {
    const hardLinks = listConfirmedHardLinks(db, artifact_id, 'incoming');
    for (const hl of hardLinks) {
      // Exclude 'contradicts' — conflict signal, not derivation; out of scope for v7.0.0.
      if (hl.type === 'contradicts') continue;
      results.push({ src: hl.src, type: hl.type });
    }
  } catch { /* non-fatal — skip hard links on error */ }

  return results;
}

/**
 * Build a readable summary string for an artifact entry.
 * Uses title if present, otherwise first 120 chars of body.
 */
function _summarize(row: ArtifactMetaRow): string {
  if (row.title && row.title.trim().length > 0) {
    return row.title.trim();
  }
  const body = (row.body ?? '').trim();
  return body.length <= 120 ? body : body.slice(0, 117) + '...';
}
