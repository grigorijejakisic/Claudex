/**
 * Phase 2.1 — pure renderer for `.planning/aggregates/multi-handle.md`.
 *
 * Layout:
 *   1. Question header (constant from aggregator.ts).
 *   2. Chronological bound-experience table (rebuilt from JSON event log
 *      every render — idempotent).
 *   3. Verdict-grouping summary (recomputed every render).
 *   4. Append-evolving dated interpretive paragraph history. Each phase
 *      that closes PREPENDS a new dated section; prior content is
 *      byte-identical (CONTEXT.md decision 4c rule 3 binding).
 *
 * Density-language only (decision 4c rule 1):
 *   Permitted: "N bound experiences, M with verdict V"; "density of
 *     consistent X / mixed"; "no abstraction yet at this density of
 *     evidence"; "more measurements needed before milestone-level claim".
 *   Forbidden: "the thesis works/doesn't work"; "fusion is/isn't
 *     justified"; any single-experience generalization; "Phase 3 ships /
 *     does not ship".
 *
 * NO action-conditional language (decision 4c rule 2): no "if N=200 lands
 * GREEN then Phase 3 ships". The paragraph describes; it does not
 * prescribe.
 */

import type { AggregatorFile, BoundExperience } from './aggregator.js';

export interface NewParagraphFragment {
  /** ISO date (YYYY-MM-DD) — heading of the new dated section. */
  date: string;
  /** The phase this paragraph closes (e.g. '2.1'). */
  phase_closing: string;
  /** Density-language descriptive prose. */
  body: string;
}

const INTERPRETIVE_HISTORY_HEADING = '## Interpretive History';

/* ------------------------------------------------------------------ */
/* Density-language template selection                                  */
/* ------------------------------------------------------------------ */

interface VerdictGrouping {
  GREEN_LIGHT: number;
  SCOPE_DOWN: number;
  KILL: number;
  BLOCKED: number;
}

function groupVerdicts(experiences: BoundExperience[]): VerdictGrouping {
  const out: VerdictGrouping = { GREEN_LIGHT: 0, SCOPE_DOWN: 0, KILL: 0, BLOCKED: 0 };
  for (const e of experiences) out[e.verdict] += 1;
  return out;
}

/**
 * Pre-written density-language paragraph templates. Branched on the
 * verdict-grouping count tuple of the FULL aggregator (not just the
 * closing phase). All branches use permitted phrasings only; the
 * density-language lint test enforces this.
 */
export function pickDensityLanguageTemplate(
  aggregator: AggregatorFile,
  closing_phase: string,
): string {
  const total = aggregator.bound_experiences.length;
  const g = groupVerdicts(aggregator.bound_experiences);
  const closingExperiences = aggregator.bound_experiences.filter(e =>
    e.phase === closing_phase ||
    (closing_phase === '2.1' && (e.phase === '2.1-strict' || e.phase === '2.1-relaxed')),
  );
  const closingKinds = new Set(closingExperiences.map(e => e.verdict));

  const breakdown = Object.entries(g)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');

  const lines: string[] = [];
  lines.push(`At phase ${closing_phase} close, the aggregator contains ${total} bound experiences (${breakdown}).`);
  if (closingExperiences.length > 0) {
    const closingBreakdown = closingExperiences.map(e => `${e.phase}=${e.verdict}`).join(', ');
    lines.push(`Phase ${closing_phase} contributed: ${closingBreakdown}.`);
  }

  // Density-of-consistency descriptions
  const dominantKills = g.KILL >= total - g.BLOCKED && total - g.BLOCKED > 0;
  const dominantGreens = g.GREEN_LIGHT >= total - g.BLOCKED && total - g.BLOCKED > 0;
  const allBlocked = g.BLOCKED === total && total > 0;

  if (allBlocked) {
    lines.push('Every bound experience to date is BLOCKED — corpus-too-sparse across all conditions. More measurements may be needed before any milestone-level claim is warranted; the corpus-sparsity finding is itself a density signal.');
  } else if (dominantKills && total >= 2) {
    lines.push('Density at this evidence level is consistent failure across conditions. More measurements may be needed before any milestone-level claim is warranted; emerging density of consistent KILL is much stronger evidence to escalate at milestone level than any single measurement.');
  } else if (dominantGreens && total >= 2) {
    lines.push('Density at this evidence level is consistent success across conditions. More measurements may be needed before any milestone-level claim is warranted; the emerging density of consistent GREEN_LIGHT is itself a finding.');
  } else if (closingKinds.size > 1) {
    lines.push('The closing phase produced mixed verdicts — itself a finding about methodology sensitivity. Density at this evidence level is mixed; more measurements may be needed before any milestone-level claim is warranted.');
  } else {
    lines.push('Density at this evidence level is mixed across conditions. More measurements may be needed before any milestone-level claim is warranted; the aggregator preserves each bound experience for cross-time density measurement.');
  }

  return lines.join(' ');
}

/* ------------------------------------------------------------------ */
/* Markdown layout helpers                                              */
/* ------------------------------------------------------------------ */

function fmt4(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return n.toFixed(4);
}

function rowFor(e: BoundExperience): string {
  type DeltaShape = { delta?: number; ci_lower?: number; ci_upper?: number };
  const dp5 = (e.metrics?.delta_precision_at_5 as DeltaShape | undefined) ?? {};
  const dr10 = (e.metrics?.delta_recall_at_10 as DeltaShape | undefined) ?? {};
  const intra = (e.metrics?.intra_project_share as number | undefined) ?? null;
  const p99 = (e.metrics?.p99_fused_over_p99_semantic as number | undefined) ?? null;
  return `| ${e.phase} | ${e.date} | ${e.labeler} | ${e.n} | ${fmt4(dp5.delta)} [${fmt4(dp5.ci_lower)}, ${fmt4(dp5.ci_upper)}] | ${fmt4(dr10.delta)} [${fmt4(dr10.ci_lower)}, ${fmt4(dr10.ci_upper)}] | ${fmt4(p99)} | ${fmt4(intra)} | ${e.verdict} | see results files |`;
}

/**
 * Extract the prior dated interpretive paragraphs from the existing
 * markdown file. Sections live below `## Interpretive History`. Returns
 * the prior history block VERBATIM (preserving bytes); empty string if
 * the heading does not exist.
 */
export function extractPriorInterpretiveHistory(priorMarkdown: string): string {
  const idx = priorMarkdown.indexOf(INTERPRETIVE_HISTORY_HEADING);
  if (idx < 0) return '';
  // Take everything from the heading onwards, inclusive of trailing
  // sections — the renderer rebuilds everything ABOVE this heading
  // fresh from the JSON.
  const rest = priorMarkdown.slice(idx);
  // Strip the heading line itself so the renderer can re-add it.
  const newlineIdx = rest.indexOf('\n');
  if (newlineIdx < 0) return '';
  return rest.slice(newlineIdx + 1);
}

/**
 * Detect whether a `### {date} — phase {phase} close` section already
 * exists in the prior markdown's interpretive history.
 */
function hasDatedSection(priorMarkdown: string, date: string, phase: string): boolean {
  const heading = `### ${date} — phase ${phase} close`;
  return priorMarkdown.includes(heading);
}

export function renderAggregatorMarkdown(
  aggregator: AggregatorFile,
  priorMarkdown: string,
  newParagraph: NewParagraphFragment | null,
): string {
  const groups = groupVerdicts(aggregator.bound_experiences);
  const total = aggregator.bound_experiences.length;

  const lines: string[] = [];
  lines.push('# Multi-handle aggregator');
  lines.push('');
  lines.push(`**Question:** ${aggregator.question}`);
  lines.push('');
  lines.push(`**Bound experiences:** ${total} (rebuilt from \`.planning/aggregates/multi-handle.json\` event log)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Chronological table');
  lines.push('');
  lines.push('| Phase | Date | Labeler | n | Δp@5 (Wilson CI) | Δr@10 (Wilson CI) | latency p99 ratio | intra-project share | Verdict | Conditions |');
  lines.push('|-------|------|---------|---|------------------|-------------------|-------------------|---------------------|---------|------------|');
  for (const e of aggregator.bound_experiences) {
    lines.push(rowFor(e));
  }
  lines.push('');
  lines.push('(rows added at the bottom by future empirical phases; never modified.)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Verdict-grouping summary');
  lines.push('');
  lines.push(`- GREEN_LIGHT: ${groups.GREEN_LIGHT}`);
  lines.push(`- SCOPE_DOWN: ${groups.SCOPE_DOWN}`);
  lines.push(`- KILL: ${groups.KILL}`);
  lines.push(`- BLOCKED: ${groups.BLOCKED}`);
  lines.push('');
  lines.push(`Total bound experiences: ${total}.`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(INTERPRETIVE_HISTORY_HEADING);
  lines.push('');
  lines.push('(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)');
  lines.push('');

  // Prepend new dated section ABOVE all prior dated sections under the
  // `## Interpretive History` heading. Idempotency: skip if heading
  // already present.
  const priorHistory = extractPriorInterpretiveHistory(priorMarkdown);
  const wantsNew =
    newParagraph != null &&
    !hasDatedSection(priorMarkdown, newParagraph.date, newParagraph.phase_closing);

  if (wantsNew) {
    lines.push(`### ${newParagraph!.date} — phase ${newParagraph!.phase_closing} close`);
    lines.push('');
    lines.push(newParagraph!.body);
    lines.push('');
  }

  // Append prior history verbatim (preserving its byte content).
  if (priorHistory.length > 0) {
    lines.push(priorHistory.trimEnd());
    lines.push('');
  }

  return lines.join('\n');
}
