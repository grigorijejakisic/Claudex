#!/usr/bin/env node
/**
 * POLISH-11 — P9 probes a/c parametric-knowledge confound audit.
 *
 * Per 11-CONTEXT.md § Implementation Decisions § W2 (Q3): the original 30
 * P9 probes stay byte-immutable for Q1 paired-McNemar. This script audits
 * + DOCUMENTS the parametric-knowledge confound finding from Gemini Harness
 * Finding #5; it does NOT rewrite any probe.
 *
 * Heuristic: classify each probe as:
 *   - 'parametric-likely':   probe asks about widely-known facts that frontier
 *                            LLMs likely encountered in training (canonical
 *                            algorithms, popular APIs, libraries)
 *   - 'parametric-unlikely': probe asks about project-internal decisions, novel
 *                            approaches, custom architectures, or specific
 *                            session-anchored deliberation traces
 *   - 'mixed':               probe blends both
 *
 * The heuristic is visible-not-perfect (matching the lint discipline from
 * Plan 11-03). Misclassification is acceptable — output is methodology
 * footnote, not measurement input.
 *
 * Usage:
 *   node scripts/audit-probes-parametric.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const PROBES_DIR = path.resolve(__dirname, '..', '.planning', 'phases', '09-empirical-measurement', 'probes');
const AUDIT_OUT = path.resolve(__dirname, '..', '.planning', 'phases', '11-polish-land-v6-properly', '11-PROBE-AUDIT.md');

// Heuristic markers. Visible, not perfect.
const PARAMETRIC_MARKERS = [
  /\b(react|vue|angular|express|django|flask|spring)\b/i,
  /\b(http|https|tcp|udp|json|yaml|xml)\b/i,
  /\b(github|stackoverflow|npm|pypi)\b/i,
  /\b(algorithm|big-o|sorting|hashing|binary search)\b/i,
  /\b(ssl|tls|oauth|jwt|saml)\b/i,
  /\b(kubernetes|docker|terraform|aws|gcp|azure)\b/i,
];
const PROJECT_INTERNAL_MARKERS = [
  /\b(claudex|vesna|angel|hybrid-retrieval|sqlite-vec|episodic_events|reranker)\b/i,
  /\bV\d{2}\b/,                  // V25, V32 schema versions
  /\bphase\s+\d+(\.\d+)?\b/i,    // Phase 8, Phase 10.1
  /\bp\d+(\.\d+)?\b/i,           // P9, P11.1
  /\bsession[_-]?id\b/i,
  /\bturn[_-]?index\b/i,
  /\b(KILL|BIND|verdict|wilson|McNemar|paired)\b/i,
  /\b(deliberation|surfacing|drift|kind-[a-e])\b/i,
];

if (!fs.existsSync(PROBES_DIR)) {
  console.error(`[probe-audit] Probes directory not found: ${PROBES_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(PROBES_DIR)
  .filter((f) => /^drift-[a-e]-\d+\.json$/.test(f))
  .sort();

if (files.length === 0) {
  console.error(`[probe-audit] No probes found in ${PROBES_DIR}`);
  process.exit(1);
}

const classified = [];
for (const f of files) {
  const probe = JSON.parse(fs.readFileSync(path.join(PROBES_DIR, f), 'utf8'));
  const text = JSON.stringify(probe).toLowerCase();
  const paramScore = PARAMETRIC_MARKERS.reduce((s, r) => s + (r.test(text) ? 1 : 0), 0);
  const internalScore = PROJECT_INTERNAL_MARKERS.reduce((s, r) => s + (r.test(text) ? 1 : 0), 0);
  let classification;
  if (internalScore >= 2 && paramScore === 0) classification = 'parametric-unlikely';
  else if (paramScore >= 2 && internalScore === 0) classification = 'parametric-likely';
  else classification = 'mixed';
  classified.push({
    id: probe.id,
    kind: probe.kind,
    classification,
    paramScore,
    internalScore,
  });
}

// Group by P9 kind
const byKind = {};
for (const c of classified) {
  byKind[c.kind] = byKind[c.kind] || { 'parametric-likely': 0, 'parametric-unlikely': 0, mixed: 0, total: 0 };
  byKind[c.kind][c.classification]++;
  byKind[c.kind].total++;
}

let md = '# P9 Probes — Parametric-Knowledge Confound Audit\n\n';
md += `**Audit date:** ${new Date().toISOString().slice(0, 10)}\n`;
md += '**Reference:** Gemini Harness Finding #5; 11-CONTEXT.md § Implementation Decisions § W2 (Q3) — descriptive, no rewrite.\n';
md += `**Probes audited:** ${classified.length}\n`;
md += `**Probes directory:** \`.planning/phases/09-empirical-measurement/probes/\`\n\n`;
md += '## Heuristic\n\n';
md += '- **parametric-likely**: probe text mentions ≥ 2 markers from a list of widely-known frontier-LLM-training-data terms (popular frameworks, protocols, OS/cloud providers, canonical algorithms) AND zero project-internal markers.\n';
md += '- **parametric-unlikely**: probe text mentions ≥ 2 project-internal markers (claudex / vesna / V32 schema / Phase X / KILL/BIND verdicts / kind-a..e drift taxonomy) AND zero parametric markers.\n';
md += '- **mixed**: probe blends both, or neither score reaches the threshold.\n\n';
md += '_The heuristic is visible-not-perfect. False positives / negatives are acceptable — the output is methodology footnote, not measurement input._\n\n';
md += '## Summary by P9 kind\n\n';
md += '| Kind | parametric-likely | parametric-unlikely | mixed | total |\n';
md += '|------|-------------------|---------------------|-------|-------|\n';
for (const k of Object.keys(byKind).sort()) {
  const r = byKind[k];
  md += `| ${k} | ${r['parametric-likely']} | ${r['parametric-unlikely']} | ${r.mixed} | ${r.total} |\n`;
}
md += '\n## Per-probe classification\n\n';
md += '| Probe ID | P9 kind | Classification | Param markers | Internal markers |\n';
md += '|----------|---------|----------------|---------------|------------------|\n';
for (const c of classified) {
  md += `| ${c.id} | ${c.kind} | ${c.classification} | ${c.paramScore} | ${c.internalScore} |\n`;
}
md += '\n## Interpretation\n\n';
md += 'Per 11-CONTEXT.md § Implementation Decisions § W2 (Q3), the original 30 probes remain byte-immutable for Q1 paired-McNemar. This audit is a methodology footnote, not a fixture rewrite:\n\n';
md += '- **If Q1 + Q2 both bind (W3 outcome A):** the parametric-likely classifications listed above are documented context; the rebind is methodology-clean by Q2 design (the 60-probe disjoint pool authored in Plan 11-07 structurally avoids the parametric-knowledge confound).\n';
md += '- **If Q1 binds but Q2 doesn\'t (W3 outcome B):** the parametric-likely classifications above may be cited as one possible explanation in the kill receipt — the original-probe-set bind was probe-set-specific artifact rather than substrate value.\n';
md += '- **If Q1 doesn\'t bind (W3 outcome C):** Q2/Q3 are skipped per the conditional outcomes table. The audit becomes part of the kill receipt narrative.\n\n';
md += '_Q2 (Plan 11-07) authors a fresh 60-probe disjoint pool with parametric-knowledge confound structurally avoided by design — that\'s where methodology-clean rebind happens._\n';

fs.writeFileSync(AUDIT_OUT, md);
console.log(`[probe-audit] Wrote ${AUDIT_OUT}`);
console.log(`[probe-audit] Classified ${classified.length} probes:`);
for (const k of Object.keys(byKind).sort()) {
  const r = byKind[k];
  console.log(`  kind ${k}: parametric-likely=${r['parametric-likely']} parametric-unlikely=${r['parametric-unlikely']} mixed=${r.mixed}`);
}
