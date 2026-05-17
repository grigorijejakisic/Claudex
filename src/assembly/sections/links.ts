/**
 * Link-related section formatters for the assembly pipeline.
 *
 * This file is a Wave 2/3 landing zone. Wave 0 creates it as a placeholder
 * to eliminate cross-plan collision risk (five plans in Waves 2 and 3 touch
 * sections.ts; with modular files, F/G/J each own their file).
 *
 * Wave 2 additions:
 *   - 14-07f: formatPendingReviewLinksSection — "Inferred Links Pending Review"
 *     section for the Good Child hard-link propose-confirm UX.
 *   - 14-07g: formatProvenanceChainSection — walks links from a checkpoint
 *     decision back to source observations.
 *
 * All functions are pure, non-throwing (return null on error), and take
 * pre-fetched data.
 */

// Wave 2 (14-07f) populates formatPendingReviewLinksSection.
// Wave 3 (14-07j) may extend the lessons surface but owns lessons.ts, not this file.

import type { Database } from 'better-sqlite3';
import { walkProvenance } from '../../intelligence/provenance-walker.js';
import { estimateTokens } from '../../shared/text-utils.js';

// ─── 14-07g: P2.9 Provenance Chain ───────────────────────────────────────────

/**
 * Token budget for the Provenance Chain section.
 * Slightly larger than Pending Review's 600 because Provenance includes
 * multi-hop summaries.
 */
export const PROVENANCE_CHAIN_BUDGET_TOKENS = 800;

export interface ProvenanceChainSectionParams {
  db: Database;
  project: string;
  session_id: string;
  /** Current session pivot topic (from assembler context). */
  pivot_topic: string;
  /** Optional explicit decision artifact ID — renders unconditionally when supplied. */
  pivot_decision_artifact_id?: string;
  /** Token budget. Defaults to PROVENANCE_CHAIN_BUDGET_TOKENS (800). */
  budget_tokens?: number;
}

/**
 * P2.9 — Provenance Chain assembly section.
 *
 * Heuristic-gated: renders only when the pivot topic implies a decision context,
 * OR when an explicit decision artifact ID is supplied.
 *
 * Heuristic: pivot_topic (case-insensitive) contains 'decision', 'checkpoint',
 * or 'we decided'.
 *
 * Walks INCOMING links via walkProvenance (MAX_PROVENANCE_HOPS = 4).
 * Returns null when:
 *   - No decision artifact found / heuristic not triggered.
 *   - Chain length <= 1 (no upstream provenance to show).
 *   - Budget would be exceeded before any content.
 *
 * Non-throwing — all errors return null.
 */
export function formatProvenanceChainSection(
  p: ProvenanceChainSectionParams,
): string | null {
  try {
    const budget = p.budget_tokens ?? PROVENANCE_CHAIN_BUDGET_TOKENS;

    // ── Step 1: Heuristic gate ─────────────────────────────────────────────
    let start_artifact_id: string | undefined = p.pivot_decision_artifact_id;

    if (!start_artifact_id) {
      // Check pivot_topic for decision-like signals.
      const lower = p.pivot_topic.toLowerCase();
      const isDecisionPivot =
        lower.includes('decision') ||
        lower.includes('checkpoint') ||
        lower.includes('we decided');

      if (!isDecisionPivot) {
        return null;
      }

      // Find the most recent decision or checkpoint artifact for this project.
      const row = _findMostRecentDecisionArtifact(p.db, p.project);
      if (!row) {
        // No decision artifact exists — section omitted.
        return null;
      }
      start_artifact_id = row.id;
    }

    // ── Step 2: Walk the provenance graph ─────────────────────────────────
    const result = walkProvenance({
      db: p.db,
      start_artifact_id,
      session_id: p.session_id,
    });

    // chain[0] is the start artifact itself (hop 0).
    // Only render when there is upstream provenance (chain.length > 1).
    if (result.chain.length <= 1) {
      return null;
    }

    // ── Step 3: Render ─────────────────────────────────────────────────────
    // Skip the start artifact (hop 0) in the bullet list — it's the pivot.
    const upstream = result.chain.filter(e => e.hop_distance > 0);

    const header = `## Provenance Chain\n\nThis decision traces back to ${upstream.length} upstream artifact${upstream.length === 1 ? '' : 's'}:\n`;

    // Check total cost before truncating individual entries.
    const lines: string[] = [];
    let tokensSoFar = estimateTokens(header);

    for (const entry of upstream) {
      const viaClause = entry.via_link_type ? ` *(via ${entry.via_link_type}, hop ${entry.hop_distance})*` : '';
      const bullet = `- **${entry.kind}**: ${entry.summary}${viaClause}`;
      const bulletCost = estimateTokens(bullet + '\n');

      if (tokensSoFar + bulletCost > budget) {
        // Budget exhausted — append a truncation note if we have at least one bullet.
        if (lines.length > 0) {
          const remaining = upstream.length - lines.length;
          lines.push(`- *(${remaining} more artifact${remaining === 1 ? '' : 's'} not shown — budget cap)*`);
        }
        break;
      }

      lines.push(bullet);
      tokensSoFar += bulletCost;
    }

    if (lines.length === 0) {
      return null;
    }

    return header + lines.join('\n') + '\n';
  } catch {
    return null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface DecisionArtifactRow {
  id: string;
}

/**
 * Find the most recently created decision or checkpoint artifact for a project.
 * Returns undefined if none found.
 */
function _findMostRecentDecisionArtifact(
  db: Database,
  project: string,
): DecisionArtifactRow | undefined {
  try {
    return db.prepare(`
      SELECT id FROM artifact
      WHERE project = ?
        AND kind IN ('decision', 'checkpoint')
        AND status = 'active'
      ORDER BY created_at_epoch_ms DESC
      LIMIT 1
    `).get(project) as DecisionArtifactRow | undefined;
  } catch {
    return undefined;
  }
}
