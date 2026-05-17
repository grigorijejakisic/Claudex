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
import { listPendingHardLinks, getDecayCount, DECAY_THRESHOLD } from '../../core/link-writer.js';
import { estimateTokens } from '../../shared/text-utils.js';

// ─── 14-07f: P2.8 Pending Review Links ───────────────────────────────────────

export interface PendingReviewSectionParams {
  db: Database;
  project: string;
  /** Token budget for this section. Rows truncated if over budget. Default: 600. */
  budget_tokens: number;
}

/**
 * Phase 14-07f — "Inferred Links Pending Review" assembly section (P2.8).
 *
 * Renders the list of PENDING hard links for the current project so the
 * operator can review and confirm/reject LLM proposals.
 *
 * Design:
 * - Decayed tuples (decay_count >= DECAY_THRESHOLD) excluded — operator
 *   already rejected them enough times; proposer should stop suggesting them.
 * - Token budget cap (default 600): renders rows until budget is consumed,
 *   then appends a truncation summary line.
 * - Returns null when no pending rows remain after filtering.
 *
 * Per Good Child policy: READ-ONLY. Never confirms or rejects links.
 * Non-throwing: any error returns null (section absent, no crash).
 */
export function formatPendingReviewLinksSection(
  p: PendingReviewSectionParams,
): string | null {
  try {
    const { db, project, budget_tokens } = p;

    // Fetch all pending hard links for this project (newest-first via listPendingHardLinks).
    const pending = listPendingHardLinks(db, project);

    // Filter out decayed tuples (operator rejected >= DECAY_THRESHOLD times).
    const filtered = pending.filter(row => {
      const decayCount = getDecayCount(db, row.src, row.dst, row.type);
      return decayCount < DECAY_THRESHOLD;
    });

    if (filtered.length === 0) return null;

    // Artifact title lookup for src/dst summaries.
    const getArtifactSummary = (id: string): string => {
      try {
        const row = db.prepare(
          `SELECT title, kind, SUBSTR(body, 1, 80) AS body_preview FROM artifact WHERE id = ? LIMIT 1`
        ).get(id) as { title: string | null; kind: string; body_preview: string } | undefined;
        if (!row) return `(artifact ${id.slice(0, 8)})`;
        return row.title
          ? `${row.kind}: ${row.title}`
          : `${row.kind}: ${row.body_preview.replace(/\n/g, ' ')}`;
      } catch {
        return `(artifact ${id.slice(0, 8)})`;
      }
    };

    const header =
      `## Inferred Links Pending Review\n` +
      `LLM-proposed hard links awaiting operator confirm/reject. ` +
      `(${filtered.length} pending)\n`;

    const lines: string[] = [header];
    let remainingBudget = budget_tokens - estimateTokens(header);
    let renderedCount = 0;
    const totalCount = filtered.length;

    for (const row of filtered) {
      const srcSummary = getArtifactSummary(row.src);
      const dstSummary = getArtifactSummary(row.dst);
      const confidencePct = Math.round(row.proposed_confidence * 100);
      const proposedDate = new Date(row.proposed_at_epoch_ms).toISOString().slice(0, 10);

      const entry =
        `- [${row.type}] ${srcSummary} → ${dstSummary}\n` +
        `  Confidence: ${confidencePct}%. Rationale: ${row.proposer_rationale}\n` +
        `  ID: ${row.id} · Proposed: ${proposedDate}\n`;

      const entryCost = estimateTokens(entry);
      if (entryCost > remainingBudget) break;

      lines.push(entry);
      remainingBudget -= entryCost;
      renderedCount += 1;
    }

    // Truncation notice when not all rows fit.
    if (renderedCount < totalCount) {
      const overflow = totalCount - renderedCount;
      lines.push(
        `... and ${overflow} more pending. ` +
        `Review via claudex_trace or direct DB query on hard_link.\n`,
      );
    }

    // Operator guidance.
    lines.push(
      `To confirm or reject: call confirmHardLink(id) or rejectHardLink(id) ` +
      `via the future MCP tool, or update via direct DB.\n`,
    );

    return lines.join('\n');
  } catch {
    // Non-throwing: section is advisory; never blocks assembly.
    return null;
  }
}

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
