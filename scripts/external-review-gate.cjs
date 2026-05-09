#!/usr/bin/env node
/**
 * POLISH-12 — External-review gate.
 *
 * Mandatory-default close-out hook for engineering + empirical phase plans
 * across every project. Per 11-CONTEXT.md § Locked Decisions #6 + § Implementation
 * Decisions § W2 (Q1) — bake the external-reviewer pass into auto-orchestrate
 * + auto-execute-phase skills as the gate every phase passes through before
 * phase-complete declaration.
 *
 * Reviewers:
 *   - Gemini (single reviewer for code review, NOT the 4-judge ensemble — that's reserved
 *     for empirical adjudication). Default endpoint: `ollama run gemini-3-flash-preview:cloud`.
 *   - Codex CLI (optional). Skipped gracefully when unreachable / usage-limited.
 *
 * Verdict classification (pre-committed):
 *   - Any `severity: critical` → BLOCK; signoff false; exit 1
 *   - Any `severity: high` (no critical) → LOG; signoff true; exit 0 (recommendations only)
 *   - Otherwise → SIGNOFF; signoff true; exit 0
 *
 * Output:
 *   - {phase-dir}/{phase}-EXTERNAL-REVIEW.md (markdown render)
 *   - JSON to stdout: { signoff, verdict, review_path, degraded, findings_summary }
 *
 * Exit codes:
 *   0 — signoff (incl. LOG)
 *   1 — BLOCK (operator action required)
 *   2 — script-internal error (resolve failure, etc.)
 *
 * Operator override:
 *   --skip-external-review — emergency bypass; logs to `.planning/external-review-overrides.log`
 *     and exits 0 with verdict=OVERRIDE.
 *
 * Usage:
 *   node scripts/external-review-gate.cjs --phase 11 --project claudex-v3
 *   node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-codex
 *   node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-external-review
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------- argparse ----------
const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) argMap[key] = true;
    else { argMap[key] = next; i++; }
  }
}

const phase = argMap.phase;
const project = argMap.project;
const skipCodex = !!argMap['skip-codex'];
const skipReview = !!argMap['skip-external-review'];

if (!phase || !project) {
  console.error('Usage: external-review-gate.cjs --phase <N> --project <name> [--phase-dir <path>] [--skip-codex] [--skip-external-review] [--out <path>]');
  process.exit(2);
}

// ---------- emergency override ----------
if (skipReview) {
  const logPath = '.planning/external-review-overrides.log';
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()}\tphase=${phase}\tproject=${project}\n`);
  console.log(JSON.stringify({
    signoff: true,
    verdict: 'OVERRIDE',
    review_path: null,
    degraded: false,
    findings_summary: { critical: 0, high: 0, medium: 0, low: 0 },
  }));
  process.exit(0);
}

// ---------- locate phase dir ----------
function findPhaseDir(phaseId) {
  if (argMap['phase-dir']) return argMap['phase-dir'];
  const phasesRoot = '.planning/phases';
  if (!fs.existsSync(phasesRoot)) {
    console.error(`[external-review-gate] No .planning/phases/ in ${process.cwd()}`);
    process.exit(2);
  }
  const padded = String(phaseId).padStart(2, '0');
  const matches = fs
    .readdirSync(phasesRoot)
    .filter((d) => d.startsWith(`${padded}-`))
    .map((d) => path.join(phasesRoot, d))
    .filter((p) => fs.statSync(p).isDirectory());
  if (matches.length !== 1) {
    console.error(`[external-review-gate] Could not uniquely resolve phase ${phaseId} dir; found: ${matches.join(', ')}`);
    process.exit(2);
  }
  return matches[0];
}

const phaseDir = findPhaseDir(phase);
const padded = String(phase).padStart(2, '0');
const outPath = argMap.out || path.join(phaseDir, `${padded}-EXTERNAL-REVIEW.md`);

// ---------- bundle phase materials ----------
function buildBundle() {
  const entries = fs.readdirSync(phaseDir);
  const plans = entries.filter((f) => f.endsWith('-PLAN.md'));
  const summaries = entries.filter((f) => f.endsWith('-SUMMARY.md'));
  const contextFiles = entries.filter((f) => f.endsWith('-CONTEXT.md'));
  return {
    project,
    phase,
    phaseDir,
    plans: plans.map((f) => ({ file: f, content: fs.readFileSync(path.join(phaseDir, f), 'utf8') })),
    summaries: summaries.map((f) => ({ file: f, content: fs.readFileSync(path.join(phaseDir, f), 'utf8') })),
    context: contextFiles.map((f) => ({ file: f, content: fs.readFileSync(path.join(phaseDir, f), 'utf8') })),
    roadmap: fs.existsSync('.planning/ROADMAP.md')
      ? fs.readFileSync('.planning/ROADMAP.md', 'utf8')
      : '',
  };
}

const bundle = buildBundle();

// ---------- reviewer prompt ----------
const REVIEWER_PROMPT_HEADER = `You are an external code-review reviewer for project ${project}, phase ${phase}.

Review the phase's plan documents and execution summaries against the phase context. Identify any:
- Logic bugs or correctness issues in the implementation as described in the SUMMARY
- Methodology concerns (especially for empirical phases)
- Missing test coverage for behaviors the plan claims to verify
- Mismatches between locked decisions in CONTEXT and what the SUMMARY claims was implemented
- Any silent-failure pattern (the v5.0.1 lesson — tests must assert visible failures, not just "no throw")
- Drift between PLAN intent and SUMMARY-reported deviations

For each finding, output a JSON object with:
  severity     : "critical" | "high" | "medium" | "low"
  finding      : 1-2 sentence description
  file         : (optional) path to the affected file
  line         : (optional) line number in the affected file
  recommendation: (optional) 1-sentence fix

CRITICAL severity: methodology-invalidating, ship-blocking correctness bugs, security regressions.
HIGH severity   : significant gaps that should be fixed before next phase.
MEDIUM severity : worthwhile improvements; non-blocking.
LOW severity    : nits; non-blocking.

Return findings as a JSON array on a single line, prefixed with the literal token \`FINDINGS:\`.
Example output:  FINDINGS:[{"severity":"high","finding":"..."}]
If no findings:  FINDINGS:[]

Phase materials follow.

`;

const reviewerPrompt = REVIEWER_PROMPT_HEADER + JSON.stringify(bundle).slice(0, 60000);

// ---------- reviewer dispatchers ----------
function runOllamaReviewer(model, timeoutMs) {
  try {
    const stdout = execSync(`ollama run ${model}`, {
      input: reviewerPrompt,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout, error: null };
  } catch (err) {
    return { ok: false, stdout: '', error: err && err.message ? err.message : String(err) };
  }
}

function runCodexReviewer(timeoutMs) {
  try {
    // Codex CLI invocation. The `codex` binary may not be on PATH; that's a graceful skip.
    const stdout = execSync(`codex review`, {
      input: reviewerPrompt,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout, error: null };
  } catch (err) {
    return { ok: false, stdout: '', error: err && err.message ? err.message : String(err) };
  }
}

function parseFindings(rawText) {
  if (!rawText) return [];
  const m = rawText.match(/FINDINGS:\s*(\[[^\n]*\])/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => f && typeof f === 'object' && typeof f.severity === 'string' && typeof f.finding === 'string');
  } catch {
    return [];
  }
}

// ---------- run reviewers ----------
const gem = runOllamaReviewer('gemini-3-flash-preview:cloud', 120_000);
const gemFindings = gem.ok ? parseFindings(gem.stdout) : [];

let cdx = { ok: false, stdout: '', error: 'skipped via --skip-codex' };
let cdxFindings = [];
let cdxSkipped = skipCodex;
if (!skipCodex) {
  cdx = runCodexReviewer(60_000);
  if (cdx.ok) cdxFindings = parseFindings(cdx.stdout);
  else cdxSkipped = true; // Codex reachable failure → mark as degraded
}

// ---------- classify ----------
const summary = { critical: 0, high: 0, medium: 0, low: 0 };
for (const f of [...gemFindings, ...cdxFindings]) {
  const sev = f.severity;
  if (summary[sev] !== undefined) summary[sev] += 1;
}

let verdict;
let signoff;
if (summary.critical > 0) { verdict = 'BLOCK'; signoff = false; }
else if (summary.high > 0) { verdict = 'LOG'; signoff = true; }
else { verdict = 'SIGNOFF'; signoff = true; }

const degraded = cdxSkipped;

// ---------- render markdown ----------
function renderFindings(findings) {
  if (findings.length === 0) return 'No findings.\n';
  const lines = findings.map((f) => {
    let line = `- **${f.severity}** ${f.finding}`;
    if (f.file) line += ` (${f.file}${f.line ? `:${f.line}` : ''})`;
    if (f.recommendation) line += ` — _${f.recommendation}_`;
    return line;
  });
  return lines.join('\n') + '\n';
}

let md = `# External Review — Phase ${phase} (${project})\n\n`;
md += `**Date:** ${new Date().toISOString()}\n`;
md += `**Verdict:** ${verdict}\n`;
md += `**Signoff:** ${signoff ? 'yes' : 'no — phase blocked pending operator review'}\n`;
md += `**Degraded:** ${degraded ? 'yes — Codex unreachable, Gemini-only path' : 'no'}\n\n`;
md += `## Findings summary\n\n`;
md += `| Severity | Count |\n|----------|-------|\n`;
md += `| critical | ${summary.critical} |\n`;
md += `| high | ${summary.high} |\n`;
md += `| medium | ${summary.medium} |\n`;
md += `| low | ${summary.low} |\n\n`;
md += `## Reviewer: gemini-3-flash-preview\n\n`;
if (gem.ok) {
  md += renderFindings(gemFindings);
} else {
  md += `_Reviewer error: ${gem.error || 'unknown'}_\n`;
}
md += `\n## Reviewer: codex\n\n`;
if (skipCodex) {
  md += `_Skipped via --skip-codex flag._\n`;
} else if (!cdx.ok) {
  md += `_Skipped — ${cdx.error || 'codex CLI unreachable'}._\n`;
} else {
  md += renderFindings(cdxFindings);
}
md += `\n## Classification rule\n\n`;
md += `- Any \`critical\` → **BLOCK** (signoff false, exit 1)\n`;
md += `- Any \`high\` (no critical) → **LOG** (signoff true, recommendations only, exit 0)\n`;
md += `- Otherwise → **SIGNOFF** (signoff true, exit 0)\n`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, md);

// ---------- emit JSON + exit ----------
console.log(JSON.stringify({
  signoff,
  verdict,
  review_path: outPath,
  degraded,
  findings_summary: summary,
}));

process.exit(signoff ? 0 : 1);
