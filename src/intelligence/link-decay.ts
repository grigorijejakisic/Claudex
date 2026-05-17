/**
 * Phase 14-07f — anti-link decay helpers.
 *
 * Thin wrapper around LINKS-SCHEMA's getDecayCount with proposer-side
 * ergonomics. After DECAY_THRESHOLD rejections per (src, dst, type) tuple,
 * the proposer should stop re-suggesting that tuple.
 *
 * Callers: hard-link-proposer.ts uses isDecayed/skipDecayedProposals to
 * filter proposal candidates before calling proposeHardLink.
 */

import type { Database } from 'better-sqlite3';
import { getDecayCount, DECAY_THRESHOLD } from '../core/link-writer.js';
import type { HardLinkType } from '../core/link-writer.js';

// Re-export for testability.
export type { HardLinkType };

export interface ProposalCandidate {
  src: string;
  dst: string;
  type: HardLinkType;
}

export interface SkipResult {
  kept: ProposalCandidate[];
  skipped: ProposalCandidate[];
}

/**
 * Returns true if the (src, dst, type) tuple has reached or exceeded
 * DECAY_THRESHOLD rejections and the proposer should not re-suggest it.
 */
export function isDecayed(
  db: Database,
  src: string,
  dst: string,
  type: HardLinkType,
): boolean {
  return getDecayCount(db, src, dst, type) >= DECAY_THRESHOLD;
}

/**
 * Partitions a list of proposal candidates into kept (non-decayed) and
 * skipped (decayed). Emits a raw telemetry row per skipped tuple so
 * operators can monitor how many proposals are silenced by decay.
 *
 * Non-throwing — individual telemetry inserts are wrapped in try/catch.
 */
export function skipDecayedProposals(
  db: Database,
  proposals: ProposalCandidate[],
  session_id?: string,
): SkipResult {
  const kept: ProposalCandidate[] = [];
  const skipped: ProposalCandidate[] = [];

  for (const p of proposals) {
    if (isDecayed(db, p.src, p.dst, p.type)) {
      skipped.push(p);
      // Telemetry per skip (fire-and-forget, non-throwing).
      if (session_id) {
        try {
          db.prepare(`
            INSERT INTO telemetry (session_id, event_kind, detail, adapter)
            VALUES (?, 'session_end_action', ?, 'angel-boundary')
          `).run(
            session_id,
            JSON.stringify({
              action: 'hard_link_proposer_decay_skip',
              outcome: 'skipped',
              duration_ms: 0,
              src: p.src,
              dst: p.dst,
              type: p.type,
              skip_reason: 'decayed',
            }),
          );
        } catch { /* non-fatal */ }
      }
    } else {
      kept.push(p);
    }
  }

  return { kept, skipped };
}

/**
 * Returns the DECAY_THRESHOLD constant for testability.
 * This lets tests assert against the threshold without importing link-writer directly.
 */
export function getDecayThreshold(): number {
  return DECAY_THRESHOLD;
}
