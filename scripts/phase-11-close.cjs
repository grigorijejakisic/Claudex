#!/usr/bin/env node
/**
 * POLISH-15/16 — Phase 11 close-out applier.
 *
 * Reads q1-verdict.json + (q2-verdict.json | q2-skipped.json) +
 * (q3-verdict.json | q3-skipped.json | absent) from
 * `.planning/phases/11-polish-land-v6-properly/`, applies the spec's
 * pre-committed conditional outcomes table via runner.ts's
 * `loadAndClassifyPhase11`, and produces:
 *
 *   - `.planning/phases/11-polish-land-v6-properly/11-RESULTS.md`
 *     (consolidated results document with Q1+Q2+Q3 verdict triple,
 *     applied branch identifier, recommended v6.0.0 retag annotation)
 *   - operator-runnable retag command (does NOT execute it; print only)
 *   - STATE.md / ROADMAP.md / REQUIREMENTS.md update suggestions (operator
 *     reviews + applies)
 *
 * **Tasks 2 + 5 of Plan 11-08 are checkpoint:human** — this script does
 * NOT auto-author Q3 probes (Task 2; user-pair work) and does NOT execute
 * the v6.0.0 retag (Task 5; operator-approval required). Those operator
 * actions are print-only suggestions.
 *
 * Usage:
 *   node scripts/phase-11-close.cjs [--dry-run]
 *   node scripts/phase-11-close.cjs --print-retag-cmd-only
 */

const fs = require('node:fs');
const path = require('node:path');

const argMap = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (!next || next.startsWith('--')) argMap[key] = true;
    else { argMap[key] = next; i++; }
  }
}

const dryRun = !!argMap['dry-run'];
const printRetagOnly = !!argMap['print-retag-cmd-only'];

// Resolve PHASE_DIR relative to process.cwd() (the project root) so test
// scaffolding can swap the cwd into a tmpdir. Falls back to __dirname/..
// when run from outside a project dir, but the production invocation is
// always `node scripts/phase-11-close.cjs` from the project root.
const cwdPhaseDir = path.resolve(process.cwd(), '.planning', 'phases', '11-polish-land-v6-properly');
const fallbackPhaseDir = path.resolve(__dirname, '..', '.planning', 'phases', '11-polish-land-v6-properly');
const PHASE_DIR = fs.existsSync(cwdPhaseDir) ? cwdPhaseDir : fallbackPhaseDir;
const RESULTS_PATH = path.join(PHASE_DIR, '11-RESULTS.md');

function loadJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) {
    console.error(`[phase-11-close] parse error on ${p}: ${err.message}`);
    return null;
  }
}

const q1 = loadJsonIfExists(path.join(PHASE_DIR, 'q1-verdict.json'));
const q2v = loadJsonIfExists(path.join(PHASE_DIR, 'q2-verdict.json'));
const q2s = loadJsonIfExists(path.join(PHASE_DIR, 'q2-skipped.json'));
const q3v = loadJsonIfExists(path.join(PHASE_DIR, 'q3-verdict.json'));
const q3s = loadJsonIfExists(path.join(PHASE_DIR, 'q3-skipped.json'));

if (!q1) {
  console.error(`[phase-11-close] q1-verdict.json missing — Q1 (Plan 11-06) has not run.`);
  console.error('Cannot author 11-RESULTS.md until Q1 produces a verdict.');
  process.exit(2);
}

// Mirror runner.ts:applyConditionalOutcomes
function classify() {
  if (!q1) return 'incomplete';
  if (q1.verdict === 'BIND_NEGATIVE') return 'kill_receipt_q1_negative';
  if (q1.verdict === 'INCONCLUSIVE') return 'kill_receipt_q1_inconclusive';
  if (q2s) return 'kill_receipt_q1_negative_or_inconclusive';
  if (!q2v) return 'incomplete';
  if (q2v.verdict === 'BIND_NEGATIVE') return 'kill_receipt_q2_negative';
  if (q2v.verdict === 'INCONCLUSIVE') return 'p11_1_corpus_expansion';
  if (q3s) return 'engineering_close_within_corpus_bind';
  if (!q3v) return 'engineering_close_within_corpus_bind';
  if (q3v.verdict === 'BIND_POSITIVE') return 'engineering_close_strong_bind';
  if (q3v.verdict === 'BIND_NEGATIVE') return 'engineering_close_recursive_echo';
  return 'engineering_close_within_corpus_bind';
}

const branch = classify();

// Branch → recommended v6.0.0 annotation + STATE/ROADMAP narrative.
const BRANCH_ANNOTATIONS = {
  engineering_close_strong_bind: {
    title: 'v6.0.0 — Deliberation surfacing (cross-corpus generalization confirmed)',
    body: [
      'Within-corpus paired-McNemar BIND_POSITIVE (Q1) + disjoint-probe rebind BIND_POSITIVE (Q2) + cross-corpus BIND_POSITIVE on big-mozzy-v2 (Q3).',
      'Substrate value generalizes beyond P9 fixture and beyond claudex-v3 corpus.',
      'Empirical methodology corrected from v6.0.0 first-tag (production routing parity, paired-McNemar, 4-judge ensemble, parametric-knowledge avoidance in Q2 probe authoring).',
    ].join('\n'),
  },
  engineering_close_within_corpus_bind: {
    title: 'v6.0.0 — Deliberation surfacing (within-corpus bind; cross-corpus deferred)',
    body: [
      'Within-corpus paired-McNemar BIND_POSITIVE (Q1) + disjoint-probe rebind BIND_POSITIVE (Q2). Cross-corpus (Q3) inconclusive or skipped.',
      'Substrate value generalizes beyond P9 fixture; cross-corpus generalization deferred to v6.x.',
    ].join('\n'),
  },
  engineering_close_recursive_echo: {
    title: 'v6.0.0 — Substrate-only ship (within-corpus bind + cross-corpus echo confirmed)',
    body: [
      'Q1+Q2 BIND_POSITIVE within claudex-v3; Q3 BIND_NEGATIVE on big-mozzy-v2.',
      'Recursive-corpus echo-chamber risk confirmed: within-corpus bind reflects fixture-set / corpus structure, not transferable substrate value.',
      'Substrate-only ship of v6 transcript ingestion + retrieval; routing-surface engagement claim retracted.',
    ].join('\n'),
  },
  kill_receipt_q2_negative: {
    title: 'v6.0.0 — KILL receipt (within-corpus bind was probe-set artifact)',
    body: [
      'Q1 BIND_POSITIVE on locked 30-probe set; Q2 BIND_NEGATIVE on 60-probe disjoint pool.',
      'Original bind was P9-fixture-specific; substrate value does not transfer to fresh probes within the same corpus.',
      'Substrate-only ship of v6 transcript ingestion. Routing-surface engagement claim retracted.',
    ].join('\n'),
  },
  p11_1_corpus_expansion: {
    title: 'v6.0.0 — NOT TAGGED (Q2 inconclusive; P11.1 corpus expansion required)',
    body: [
      'Q1 BIND_POSITIVE on locked 30-probe set; Q2 INCONCLUSIVE on 60-probe disjoint pool.',
      'Power gap on the disjoint-probe rebind. Phase 11.1 (corpus expansion) must run before v6.0.0 can be tagged.',
      '**Do NOT retag v6.0.0 in this branch.**',
    ].join('\n'),
  },
  kill_receipt_q1_negative: {
    title: 'v6.0.0 — KILL receipt (within-corpus did not bind)',
    body: [
      'Q1 BIND_NEGATIVE on locked 30-probe set under corrected methodology.',
      'The Phase 9 bind was a methodology artifact (harness B-arm dense-KNN ≠ production routing; pseudoreplication pooling).',
      'Substrate-only ship of v6 transcript ingestion. Routing + assembly engagement claim retracted.',
    ].join('\n'),
  },
  kill_receipt_q1_inconclusive: {
    title: 'v6.0.0 — KILL receipt (within-corpus inconclusive)',
    body: [
      'Q1 INCONCLUSIVE under corrected methodology — paired-McNemar discordant_pairs below threshold OR fallback rate above threshold OR ensemble integrity compromised.',
      'No bind to ship under engagement claim. Substrate-only ship of v6 transcript ingestion.',
    ].join('\n'),
  },
  kill_receipt_q1_negative_or_inconclusive: {
    title: 'v6.0.0 — KILL receipt (Q1 not BIND_POSITIVE; Q2 skipped per conditional outcomes table)',
    body: [
      'Q1 produced a non-BIND_POSITIVE verdict; Plan 11-07 short-circuited Q2 per the pre-committed conditional outcomes table.',
      'Substrate-only ship of v6 transcript ingestion.',
    ].join('\n'),
  },
  incomplete: {
    title: 'v6.0.0 — INCOMPLETE (W3 has not produced a final verdict triple)',
    body: 'W3 measurement runs have not completed. Do NOT retag v6.0.0 until Q1+Q2+Q3 verdicts are on disk.',
  },
};

const annotation = BRANCH_ANNOTATIONS[branch] ?? BRANCH_ANNOTATIONS.incomplete;

// ---------------------------------------------------------------------------
// 11-RESULTS.md authoring
// ---------------------------------------------------------------------------

function fmtVerdict(v) {
  if (!v) return '_(missing)_';
  if (v.skipped) return `${v.verdict ?? 'INCONCLUSIVE'} _(skipped: ${v.skip_reason ?? 'no reason recorded'})_`;
  return v.verdict;
}

const md = [];
md.push('# Phase 11 — RESULTS\n');
md.push(`**Generated:** ${new Date().toISOString()}\n`);
md.push(`**Phase:** 11 (Polish — land v6 properly)\n`);
md.push(`**Branch (per pre-committed conditional outcomes table):** \`${branch}\`\n`);
md.push('');
md.push('## Verdict triple\n');
md.push('| Question | Verdict | Notes |');
md.push('|---|---|---|');
md.push(`| Q1 (within-corpus paired-McNemar, locked 30 probes) | ${q1.verdict} | ${q1.reason ?? ''} |`);
md.push(`| Q2 (disjoint-probe rebind, 60 fresh probes) | ${q2v ? q2v.verdict : (q2s ? 'INCONCLUSIVE (skipped)' : '_(missing)_')} | ${q2s?.skip_reason ?? q2v?.reason ?? ''} |`);
md.push(`| Q3 (cross-corpus on big-mozzy-v2) | ${q3v ? q3v.verdict : (q3s ? 'INCONCLUSIVE (skipped)' : '_(missing)_')} | ${q3s?.skip_reason ?? q3v?.reason ?? ''} |`);
md.push('');

md.push('## Q1 detail\n');
if (q1.paired_mcnemar) {
  md.push('| metric | value |');
  md.push('|---|---|');
  md.push(`| discordant_pairs | ${q1.paired_mcnemar.discordant_pairs} |`);
  md.push(`| a_only | ${q1.paired_mcnemar.a_only} |`);
  md.push(`| b_only | ${q1.paired_mcnemar.b_only} |`);
  md.push(`| McNemar p-value | ${q1.paired_mcnemar.p_value.toFixed(4)} |`);
  md.push(`| min_discordant_threshold | ${q1.paired_mcnemar.min_discordant_threshold} |`);
  md.push(`| fallback_rate_pct | ${q1.fallback_rate_pct.toFixed(2)}% |`);
  if (q1.dropped_judge) {
    md.push(`| dropped_judge | ${q1.dropped_judge} (3-of-3 fallback active) |`);
  }
  md.push('');
}
md.push('### Per-judge error rates\n');
if (q1.per_judge_errors_pct) {
  md.push('| judge | error rate |');
  md.push('|---|---|');
  for (const [judge, pct] of Object.entries(q1.per_judge_errors_pct)) {
    md.push(`| ${judge} | ${pct.toFixed(2)}% |`);
  }
}
md.push('');

md.push('## Pre-committed conditional outcomes branch\n');
md.push(`Branch: **${branch}**\n`);
md.push(annotation.body);
md.push('');

md.push('## v6.0.0 retag annotation (operator-approval required — Plan 11-08 Task 5)\n');
md.push('```');
md.push(annotation.title);
md.push('');
md.push(annotation.body);
md.push('```\n');
md.push('## Methodology footnotes\n');
md.push('- Paired-McNemar with min_discordant_threshold=5 (CONTEXT § Methodology critique #2)');
md.push('- 4-judge ensemble: gemini-3-flash + claude-opus-4-7 + glm-5.1 + kimi-k2.6');
md.push('- 3-of-4 majority + 3-of-3 fallback if one judge >10% error');
md.push('- Bi-encoder fallback rate threshold = 10% (§ Methodology critique #5)');
md.push('- Reranker pre-flight gate at port 7439');
md.push('- B-arm via `routeFromArtifact` (production routing) — not dense-KNN');
md.push('- A-arm with session_id metadata parity');
md.push('- Q2 probes structurally avoid parametric-knowledge confound (Q3 audit decision per CONTEXT)');
md.push('');

md.push('## Operator actions for Phase 11 close-out\n');
md.push('1. **Review this document.** Confirm verdict triple matches expectations.');
md.push('2. **Approve or reject the v6.0.0 retag annotation** (Plan 11-08 Task 5 — checkpoint:human).');
md.push('3. **If approved:** run the retag command below.');
md.push('4. **Update STATE.md / ROADMAP.md / REQUIREMENTS.md** to mark Phase 11 COMPLETE with this branch.');
md.push('5. **Run external-review-gate** against this Phase 11 artifact set (`node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-codex` if Codex still unreachable).');
md.push('6. **Optional:** run `git push origin master --tags` separately when ready (CLAUDE.md rule 1: NEVER push autonomously).');
md.push('');

md.push('## Recommended v6.0.0 retag command\n');
md.push('```bash');
md.push('# After Plan 11-08 Task 5 operator-approval:');
md.push('git tag -d v6.0.0');
md.push('git tag -a v6.0.0 -m "$(cat <<EOF');
md.push(annotation.title);
md.push('');
md.push(annotation.body);
md.push('EOF');
md.push(')"');
md.push('# DO NOT push autonomously. Operator runs:');
md.push('# git push origin master --tags');
md.push('```\n');

const outputMd = md.join('\n');

if (printRetagOnly) {
  console.log(`# Recommended v6.0.0 retag annotation for branch '${branch}':\n`);
  console.log(annotation.title);
  console.log('');
  console.log(annotation.body);
  console.log('');
  console.log(`# Operator-approval required (Plan 11-08 Task 5 — checkpoint:human) before running:`);
  console.log(`git tag -d v6.0.0`);
  console.log(`git tag -a v6.0.0 -m "<the title and body above, in heredoc form>"`);
  process.exit(0);
}

if (dryRun) {
  console.log(`[phase-11-close] DRY RUN — would write ${RESULTS_PATH} with branch=${branch}.`);
  console.log(outputMd);
  process.exit(0);
}

fs.writeFileSync(RESULTS_PATH, outputMd);
console.log(`[phase-11-close] Wrote ${RESULTS_PATH}`);
console.log(`[phase-11-close] Branch: ${branch}`);
console.log(`[phase-11-close] Operator review required for Tasks 2 + 5 (checkpoint:human) before retag.`);
