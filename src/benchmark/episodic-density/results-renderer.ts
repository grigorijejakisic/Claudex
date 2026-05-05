/**
 * Phase 2.1 — pure renderer for the per-phase RESULTS markdown.
 *
 * Outcomes-language discipline (CONTEXT.md decision 6 binding): every
 * narrative phrase is descriptive of conditions, not thesis-claims.
 * Forbidden phrasings (linted in Plan 02.1-05 Task 6 density-language-lint
 * test): "fusion works", "fusion doesn't work", "the multi-handle thesis
 * is validated/invalidated", "Phase 3 should/should not ship", "this
 * proves/disproves".
 *
 * Permitted phrasings used by the renderer:
 *   - "verdict V at tier T (≥X frames), n=N, with auto-labeler precision P/N"
 *   - "Combined with Phase 2 we now have N bound experiences with breakdown ..."
 *   - "more measurements may be needed before any milestone-level claim is warranted"
 *
 * Pure: no fs, no DB, no clock dependency (opts.now is the only injectable
 * time so the test fixtures can pin output).
 */

import type { TieredHarnessResult, HarnessRunResult } from './harness.js';
import type { Verdict } from './verdict.js';

export interface PerTierAuditSummary {
  tier: 'strict_3frame' | 'relaxed_2frame';
  sample_size: number;
  per_stratum_precision: {
    v4_backfill?: { valid: number; sampled: number };
    phase1_organic_pre_phase2_close?: { valid: number; sampled: number };
    phase1_organic_post_phase2_close?: { valid: number; sampled: number };
  };
  tier_total_precision: { valid: number; sampled: number };
}

const TIER_LABEL: Record<'strict_3frame' | 'relaxed_2frame', string> = {
  strict_3frame: 'Strict tier (≥3 frames overlap)',
  relaxed_2frame: 'Relaxed tier (≥2 frames overlap)',
};

function fmt4(n: number): string {
  return n.toFixed(4);
}

function metricRow(
  variant: string,
  m: HarnessRunResult['metrics']['pooled']['A'],
): string {
  const p5 = `${fmt4(m.precision_at_5.point)} [${fmt4(m.precision_at_5.lower)}, ${fmt4(m.precision_at_5.upper)}]`;
  const r10 = `${fmt4(m.recall_at_10.point)} [${fmt4(m.recall_at_10.lower)}, ${fmt4(m.recall_at_10.upper)}]`;
  const mrr = `${fmt4(m.mrr.mean)} [${fmt4(m.mrr.ci_lower)}, ${fmt4(m.mrr.ci_upper)}]`;
  return `| ${variant} | ${p5} | ${r10} | ${mrr} | ${m.n} |`;
}

function deltaRow(
  label: string,
  d: HarnessRunResult['deltas']['pooled']['C_vs_A'],
  split: string,
): string {
  const dp5 = `${fmt4(d.delta_precision_at_5.point)} [${fmt4(d.delta_precision_at_5.lower)}, ${fmt4(d.delta_precision_at_5.upper)}]`;
  const dr10 = `${fmt4(d.delta_recall_at_10.point)} [${fmt4(d.delta_recall_at_10.lower)}, ${fmt4(d.delta_recall_at_10.upper)}]`;
  return `| ${label} | ${dp5} | ${dr10} | ${split} |`;
}

function metricsTable(label: string, set: HarnessRunResult['metrics']['pooled']): string {
  return [
    `#### ${label}`,
    `| Variant | precision@5 (Wilson 95% CI) | recall@10 (Wilson 95% CI) | MRR (mean ± bootstrap CI) | n |`,
    `|---------|------------------------------|----------------------------|----------------------------|---|`,
    metricRow('A semantic-only', set.A),
    metricRow('B fingerprint-only', set.B),
    metricRow('C RRF-fused (k=60)', set.C),
  ].join('\n');
}

function renderTierSection(
  tier: 'strict_3frame' | 'relaxed_2frame',
  harness: HarnessRunResult,
  verdict: Verdict,
  auditSummary: PerTierAuditSummary | null,
): string {
  const c1 = verdict.criteria.criterion_1;
  const c2 = verdict.criteria.criterion_2;
  const c3 = verdict.criteria.criterion_3;
  const audit =
    auditSummary != null
      ? `${auditSummary.tier_total_precision.valid}/${auditSummary.tier_total_precision.sampled} pooled; per-stratum: ${(['v4_backfill', 'phase1_organic_pre_phase2_close', 'phase1_organic_post_phase2_close'] as const)
          .map(o => {
            const s = auditSummary.per_stratum_precision[o];
            if (!s || s.sampled === 0) return `${o}=N/A`;
            return `${o}=${s.valid}/${s.sampled}`;
          })
          .join(', ')}`
      : 'audit pending — re-render after audit completes';

  const lines: string[] = [];
  lines.push(`### ${TIER_LABEL[tier]}`);
  lines.push('');
  lines.push(`**Verdict:** **${verdict.kind}**`);
  lines.push(`**Reasoning:** ${verdict.reasoning}`);
  lines.push('');
  lines.push('| # | Criterion | Threshold | Observed | Passed | Evidence |');
  lines.push('|---|-----------|-----------|----------|--------|----------|');
  lines.push(`| 1 | Fusion improvement (max(Δp@5,Δr@10) ≥ +5pp AND CI lower ≥ 0 on the same metric) | ${c1.threshold} / CI≥0 | ${fmt4(c1.observed)} | ${c1.passed ? 'YES' : 'NO'} | ${c1.evidence} |`);
  lines.push(`| 2 | Density signal (intra-project share ≥ 30%) | ${c2.threshold} | ${fmt4(c2.observed)} | ${c2.passed ? 'YES' : 'NO'} | ${c2.evidence} |`);
  lines.push(`| 3 | Latency budget (p99 fused / p99 semantic < 2.0) | ${c3.threshold} | ${fmt4(c3.observed)} | ${c3.passed ? 'YES' : 'NO'} | ${c3.evidence} |`);
  lines.push('');
  lines.push('**Bound-experience conditions:**');
  lines.push(`- n (held-out test set): ${harness.decision_rule_inputs.held_out_test_n}`);
  lines.push(`- pair set total: ${harness.pairs.total} (after ${tier} labeling, frame≥${tier === 'strict_3frame' ? 3 : 2})`);
  lines.push(`- auto-labeler precision (CONTEXT.md decision 3b descriptive): ${audit}`);
  lines.push('');
  lines.push('**Quality metrics — held-out test set:**');
  lines.push('');
  lines.push(metricsTable('Pooled', harness.metrics.pooled));
  lines.push('');
  lines.push(metricsTable('v4_backfill only', harness.metrics.v4_backfill));
  lines.push('');
  lines.push(metricsTable('phase1_organic_pre_phase2_close only', harness.metrics.phase1_organic_pre_phase2_close));
  lines.push('');
  lines.push(metricsTable('phase1_organic_post_phase2_close only', harness.metrics.phase1_organic_post_phase2_close));
  lines.push('');
  lines.push('**Deltas vs A (Newcombe 95% CI):**');
  lines.push('');
  lines.push('| Comparison | Δ precision@5 (CI) | Δ recall@10 (CI) | Origin split |');
  lines.push('|------------|--------------------|------------------|--------------|');
  lines.push(deltaRow('C - A', harness.deltas.pooled.C_vs_A, 'pooled'));
  lines.push(deltaRow('C - A', harness.deltas.v4_backfill.C_vs_A, 'v4_backfill'));
  lines.push(deltaRow('C - A', harness.deltas.phase1_organic_pre_phase2_close.C_vs_A, 'phase1_organic_pre_phase2_close'));
  lines.push(deltaRow('C - A', harness.deltas.phase1_organic_post_phase2_close.C_vs_A, 'phase1_organic_post_phase2_close'));
  lines.push(deltaRow('B - A', harness.deltas.pooled.B_vs_A, 'pooled'));
  lines.push('');
  lines.push('**Latency:**');
  lines.push('');
  lines.push('| Variant | p50 (ms) | p95 (ms) | p99 (ms) |');
  lines.push('|---------|----------|----------|----------|');
  lines.push(`| A | ${harness.metrics.pooled.A.latency_ms.p50.toFixed(3)} | ${harness.metrics.pooled.A.latency_ms.p95.toFixed(3)} | ${harness.metrics.pooled.A.latency_ms.p99.toFixed(3)} |`);
  lines.push(`| B | ${harness.metrics.pooled.B.latency_ms.p50.toFixed(3)} | ${harness.metrics.pooled.B.latency_ms.p95.toFixed(3)} | ${harness.metrics.pooled.B.latency_ms.p99.toFixed(3)} |`);
  lines.push(`| C | ${harness.metrics.pooled.C.latency_ms.p50.toFixed(3)} | ${harness.metrics.pooled.C.latency_ms.p95.toFixed(3)} | ${harness.metrics.pooled.C.latency_ms.p99.toFixed(3)} |`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Pre-written templates for the bound-experience description block. Branch
 * on the (strict.kind, relaxed.kind) tuple. CONTEXT.md decision 6
 * outcomes-language only — descriptive of conditions, NOT thesis claims.
 */
function renderBoundExperienceDescription(
  strict: Verdict,
  relaxed: Verdict,
): string {
  const sk = strict.kind;
  const rk = relaxed.kind;
  // BLOCKED tier (corpus-too-sparse)
  if (sk === 'BLOCKED' || rk === 'BLOCKED') {
    const blocked = sk === 'BLOCKED' ? 'strict' : 'relaxed';
    const other = blocked === 'strict' ? 'relaxed' : 'strict';
    const otherKind = blocked === 'strict' ? rk : sk;
    return `The ${blocked} tier produced n=0 (corpus-too-sparse sentinel); the ${other} tier landed verdict ${otherKind}. The corpus-sparsity finding is the primary bound-experience condition for the ${blocked} tier; the ${other} tier ships its verdict + conditions independently. More measurements may be needed before any milestone-level claim is warranted.`;
  }
  if (sk === 'GREEN_LIGHT' && rk === 'GREEN_LIGHT') {
    return `Both tiers cleared the locked decision rule's bar at strict and relaxed labeling. Combined with Phase 2's KILL at n=20, the aggregator now contains 3 bound experiences with mixed verdicts (1 KILL, 2 GREEN_LIGHT) under different conditions. Density at this evidence level is mixed; more measurements may be needed before any milestone-level claim is warranted.`;
  }
  if (sk === 'KILL' && rk === 'KILL') {
    return `Both tiers failed the locked decision rule. Combined with Phase 2's KILL at n=20, the aggregator contains 3 bound experiences all with KILL verdicts under different labeler-strictness and corpus-size conditions — emerging density of consistent failure. This is much stronger evidence to escalate at milestone level than any single measurement, but no single phase's verdict alone determines milestone-level conclusions.`;
  }
  if (sk === 'SCOPE_DOWN' && rk === 'SCOPE_DOWN') {
    return `Both tiers landed SCOPE_DOWN: improvement exists but cost discipline blocks full multi-handle cutover. Combined with Phase 2's KILL at n=20, the aggregator contains 3 bound experiences with mixed verdicts. Density at this evidence level is mixed; more measurements may be needed before any milestone-level claim is warranted.`;
  }
  // Mixed
  return `Verdict is sensitive to labeler strictness — strict landed ${sk}, relaxed landed ${rk}. Itself a finding about the methodology. Aggregator contains 3 bound experiences with mixed verdicts; the strict-vs-relaxed asymmetry is itself a bound-experience condition.`;
}

export function renderTieredResultsMarkdown(
  tiered: TieredHarnessResult,
  verdicts: { strict_3frame: Verdict; relaxed_2frame: Verdict },
  auditSummaries: { strict_3frame: PerTierAuditSummary | null; relaxed_2frame: PerTierAuditSummary | null },
  opts: { seed: number; generatedIso?: string },
): string {
  const generated = opts.generatedIso ?? new Date(tiered.ts_epoch * 1000).toISOString();
  const lines: string[] = [];
  lines.push('# Phase 2.1 Results: Corpus-expansion rerun (second bound measurement)');
  lines.push('');
  lines.push(`**Generated:** ${generated}`);
  lines.push(`**Harness seed:** ${opts.seed}`);
  lines.push(`**Tiers:** strict_3frame, relaxed_2frame (parallel — no combined verdict per CONTEXT.md decision 2a)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Decision rule (Phase 2 CONTEXT.md item 5 — REUSED VERBATIM, no goalpost shift)');
  lines.push('');
  // Quote the locked rule verbatim as a blockquote — the lint test
  // exempts blockquoted text (decision_rule_quote contains the words
  // "Phase 3 plan is rewritten" which are forbidden phrasings outside
  // blockquotes).
  for (const ln of verdicts.strict_3frame.decision_rule_quote.split('\n')) {
    lines.push(`> ${ln}`);
  }
  lines.push('');
  lines.push('The same locked rule is applied INDEPENDENTLY to each tier (CONTEXT.md decision 2a + 5).');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Per-tier verdicts');
  lines.push('');
  lines.push(renderTierSection('strict_3frame', tiered.strict_3frame, verdicts.strict_3frame, auditSummaries.strict_3frame));
  lines.push('');
  lines.push(renderTierSection('relaxed_2frame', tiered.relaxed_2frame, verdicts.relaxed_2frame, auditSummaries.relaxed_2frame));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Density signal (CONTEXT.md item 4)');
  lines.push('');
  // Density is corpus-wide (same on both tiers); render once from strict.
  const d = tiered.strict_3frame.density;
  lines.push(`- Random-pair sample size: ${d.random_pair_sample_size}`);
  lines.push(`- Noise floor (95th percentile): ${fmt4(d.noise_floor)}`);
  lines.push(`- σ: ${fmt4(d.noise_sigma)}`);
  lines.push(`- Cluster threshold: ${fmt4(d.cluster_threshold)}`);
  lines.push(`- Weak clusters (K=2..4): ${d.cluster_count.weak_K2}`);
  lines.push(`- Strong clusters (K≥5): ${d.cluster_count.strong_K5}`);
  lines.push(`- Intra-project share: ${fmt4(d.intra_project_share)} (CONTEXT.md item 4 threshold=0.30)`);
  lines.push(`- Density meaningful: ${d.density_meaningful ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Corpus');
  lines.push('');
  const cs = tiered.strict_3frame.corpus_size;
  lines.push(`- Total fingerprinted episodes: ${cs.total}`);
  lines.push(`- v4_backfill: ${cs.v4_backfill}`);
  lines.push(`- phase1_organic_pre_phase2_close: ${cs.phase1_organic_pre_phase2_close}`);
  lines.push(`- phase1_organic_post_phase2_close: ${cs.phase1_organic_post_phase2_close}`);
  lines.push(`- Projects covered: ${cs.projects.join(', ')}`);
  lines.push('');
  lines.push(`Pair counts per tier:`);
  lines.push(`- Strict (≥3 frames): ${tiered.strict_3frame.pairs.total} total, ${tiered.strict_3frame.pairs.test} held-out`);
  lines.push(`- Relaxed (≥2 frames): ${tiered.relaxed_2frame.pairs.total} total, ${tiered.relaxed_2frame.pairs.test} held-out`);
  lines.push('');
  lines.push('See:');
  lines.push('- 02.1-03-strict-audit.md (auto-labeler precision per stratum, descriptive)');
  lines.push('- 02.1-03-relaxed-audit.md (same, relaxed tier)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Bound-experience description');
  lines.push('');
  lines.push(renderBoundExperienceDescription(verdicts.strict_3frame, verdicts.relaxed_2frame));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Notes for the orchestrator + user (next user-approval gate)');
  lines.push('');
  lines.push('This phase produced TWO bound experiences (strict + relaxed). Combined with Phase 2\'s earlier bound experience, the aggregator at `.planning/aggregates/multi-handle.json` now contains 3 entries. Whether more bound experiences are needed before considering Phase 3 (or any milestone-level conclusion) is owned by the user-approval gate, NOT by this RESULTS.md.');
  lines.push('');
  lines.push('The aggregator\'s interpretive paragraph at 2.1 close describes what the density of evidence looks like at this point — see `.planning/aggregates/multi-handle.md`.');
  lines.push('');
  return lines.join('\n');
}
