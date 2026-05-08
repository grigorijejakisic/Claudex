import * as fs from 'node:fs';
import type { AggregatorFile, BoundExperience } from './aggregator.js';

/**
 * Renders the aggregator file into the multi-handle.md-shaped projection.
 *
 * Section structure:
 *   - Title + question + bound-experiences-count
 *   - Chronological table (rows append at the bottom; never modified)
 *   - Verdict-grouping summary
 *   - Interpretive History (preserved verbatim from prior .md when it exists;
 *     closing phases prepend new dated sections)
 */
export function renderAggregatorMarkdown(file: AggregatorFile, existingMdPath?: string): string {
  const header = [
    `# Deliberation-surfacing aggregator`,
    ``,
    `**Question:** ${file.question}`,
    ``,
    `**Bound experiences:** ${file.bound_experiences.length} (rebuilt from \`.planning/aggregates/deliberation-surfacing.json\` event log)`,
    ``,
    `**Verdict mapping (P9 BindVerdict → aggregator):** POSITIVE → GREEN_LIGHT · NEGATIVE → KILL · INCONCLUSIVE → INCONCLUSIVE.`,
    ``,
    `---`,
    ``,
  ].join('\n');

  const tableHeader =
    `| Phase | Date | Labeler | n | Δ pass rate | Δ CI lower | Δ CI upper | Verdict | Retrieval baseline |\n` +
    `|-------|------|---------|---|-------------|------------|------------|---------|---------------------|\n`;
  const rows = file.bound_experiences.map(formatRow).join('\n');

  const grouping = computeGroupingSummary(file.bound_experiences);

  const interpretive = readInterpretiveHistory(existingMdPath);

  return [
    header,
    `## Chronological table`,
    ``,
    tableHeader + rows,
    ``,
    `(rows added at the bottom by future empirical phases; never modified.)`,
    ``,
    `---`,
    ``,
    `## Verdict-grouping summary`,
    ``,
    `- GREEN_LIGHT: ${grouping.GREEN_LIGHT}`,
    `- SCOPE_DOWN: ${grouping.SCOPE_DOWN}`,
    `- KILL: ${grouping.KILL}`,
    `- BLOCKED: ${grouping.BLOCKED}`,
    `- INCONCLUSIVE: ${grouping.INCONCLUSIVE}`,
    ``,
    `Total bound experiences: ${file.bound_experiences.length}.`,
    ``,
    `---`,
    ``,
    `## Interpretive History`,
    ``,
    `(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT additional_locks.)`,
    ``,
    interpretive,
    ``,
  ].join('\n');
}

function formatRow(e: BoundExperience): string {
  const m = e.metrics as Record<string, unknown>;
  const delta = typeof m.delta_pass_rate === 'number' ? (m.delta_pass_rate as number).toFixed(4) : '—';
  const lo = typeof m.delta_ci_lower === 'number' ? (m.delta_ci_lower as number).toFixed(4) : '—';
  const hi = typeof m.delta_ci_upper === 'number' ? (m.delta_ci_upper as number).toFixed(4) : '—';
  const cond = e.conditions as Record<string, unknown>;
  const baseline = (cond.retrieval_baseline as string | undefined) ?? '—';
  return `| ${e.phase} | ${e.date} | ${e.labeler} | ${e.n} | ${delta} | ${lo} | ${hi} | ${e.verdict} | ${baseline} |`;
}

function computeGroupingSummary(es: BoundExperience[]) {
  return es.reduce(
    (acc, e) => {
      acc[e.verdict] = (acc[e.verdict] ?? 0) + 1;
      return acc;
    },
    { GREEN_LIGHT: 0, SCOPE_DOWN: 0, KILL: 0, BLOCKED: 0, INCONCLUSIVE: 0 } as Record<string, number>,
  );
}

/**
 * Reads the Interpretive History section from the existing .md (if present)
 * and returns its body (everything after the placeholder paragraph).
 */
function readInterpretiveHistory(existingMdPath?: string): string {
  if (!existingMdPath || !fs.existsSync(existingMdPath)) {
    return `(no interpretive history yet — this section is populated when phases close)`;
  }
  const raw = fs.readFileSync(existingMdPath, 'utf-8');
  const idx = raw.indexOf('## Interpretive History');
  if (idx < 0) return `(no interpretive history yet — this section is populated when phases close)`;
  const body = raw.slice(idx);
  // Skip the heading and placeholder paragraph; return everything after.
  const headingEnd = body.indexOf('\n');
  const afterHeading = body.slice(headingEnd + 1).replace(/^\s*\n/, '');
  // Skip the first placeholder paragraph (lines until first blank).
  const blankIdx = afterHeading.indexOf('\n\n');
  if (blankIdx < 0) return `(no interpretive history yet — this section is populated when phases close)`;
  const remainder = afterHeading.slice(blankIdx + 2).trim();
  return remainder.length > 0
    ? remainder
    : `(no interpretive history yet — this section is populated when phases close)`;
}
