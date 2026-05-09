#!/usr/bin/env node
/**
 * POLISH-14 — Q2 disjoint-pool validator.
 *
 * Reads `.planning/phases/11-polish-land-v6-properly/q2-locked-probes.json`
 * (60 probes) and asserts the constraints from `q2-probe-rules.md`:
 *   - 60 probes total
 *   - 12 per kind (a/b/c/d/e × 12 each)
 *   - r1 + r2 split (30 + 30) inferred from probe ID convention `q2-{kind}-{NN}`
 *     where NN 01-06 is r1 and NN 07-12 is r2 (lexically explicit)
 *   - Disjoint from P9 (no anchor session_id, no normalized prompt text overlap)
 *   - Q2 ID prefix `q2-` (not `drift-`)
 *   - ≥70% source: 'real'
 *   - No parametric-likely terms unless explicitly flagged
 *
 * Exit codes:
 *   0 — all constraints satisfied; pool is locked-eligible
 *   1 — at least one constraint violated; emits per-probe failure list
 *   2 — file shape error
 *
 * Usage:
 *   node scripts/validate-q2-probes.cjs
 *   node scripts/validate-q2-probes.cjs --probes <path-to-q2-locked-probes.json>
 *   node scripts/validate-q2-probes.cjs --p9-probes <path-to-p9-probes-dir>
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

const Q2_PATH = argMap.probes || path.resolve(__dirname, '..', '.planning', 'phases', '11-polish-land-v6-properly', 'q2-locked-probes.json');
const P9_DIR = argMap['p9-probes'] || path.resolve(__dirname, '..', '.planning', 'phases', '09-empirical-measurement', 'probes');

// Parametric-likely terms (mirror scripts/audit-probes-parametric.cjs).
const PARAM_TERMS = [
  /\b(react|vue|angular|express|django|flask|spring)\b/i,
  /\b(http|https|tcp|udp|json|yaml|xml)\b/i,
  /\b(github|stackoverflow|npm|pypi)\b/i,
  /\b(algorithm|big-o|sorting|hashing|binary search)\b/i,
  /\b(ssl|tls|oauth|jwt|saml)\b/i,
  /\b(kubernetes|docker|terraform|aws|gcp|azure)\b/i,
];

function loadQ2() {
  if (!fs.existsSync(Q2_PATH)) {
    console.error(`[validate-q2] q2-locked-probes.json not found at ${Q2_PATH}`);
    console.error('User-pair authoring per q2-probe-rules.md must complete first.');
    process.exit(2);
  }
  let raw;
  try {
    raw = fs.readFileSync(Q2_PATH, 'utf8');
  } catch (err) {
    console.error(`[validate-q2] read error: ${err.message}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[validate-q2] parse error: ${err.message}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    console.error('[validate-q2] file must contain a JSON array of 60 probes');
    process.exit(2);
  }
  return parsed;
}

function loadP9() {
  if (!fs.existsSync(P9_DIR)) {
    console.error(`[validate-q2] P9 probes dir not found at ${P9_DIR}`);
    process.exit(2);
  }
  const files = fs
    .readdirSync(P9_DIR)
    .filter((f) => /^drift-[a-e]-\d+\.json$/.test(f));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(P9_DIR, f), 'utf8')));
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const probes = loadQ2();
const p9 = loadP9();

const failures = [];

// (1) Total count
if (probes.length !== 60) {
  failures.push(`pool size: expected 60 probes, got ${probes.length}`);
}

// (2) Kind balance
const byKind = { a: 0, b: 0, c: 0, d: 0, e: 0 };
for (const p of probes) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
for (const k of ['a', 'b', 'c', 'd', 'e']) {
  if (byKind[k] !== 12) {
    failures.push(`kind balance: kind '${k}' has ${byKind[k]} probes, expected 12`);
  }
}

// (3) ID convention + replication split
const idPattern = /^q2-([a-e])-(\d{2})$/;
const ids = new Set();
for (const p of probes) {
  const m = idPattern.exec(p.id);
  if (!m) {
    failures.push(`probe ${p.id}: ID does not match q2-{kind}-{NN} convention`);
    continue;
  }
  if (m[1] !== p.kind) {
    failures.push(`probe ${p.id}: ID kind '${m[1]}' does not match probe.kind '${p.kind}'`);
  }
  const nn = parseInt(m[2], 10);
  if (nn < 1 || nn > 12) {
    failures.push(`probe ${p.id}: NN ${nn} outside 01-12 range`);
  }
  if (ids.has(p.id)) {
    failures.push(`probe ${p.id}: duplicate ID`);
  }
  ids.add(p.id);
}

// (4) Disjointness from P9: anchor session_id
const p9SessionIds = new Set(p9.map((p) => p.transcript_anchor?.session_id));
for (const p of probes) {
  const sid = p.transcript_anchor?.session_id;
  if (sid && p9SessionIds.has(sid)) {
    failures.push(`probe ${p.id}: transcript_anchor.session_id '${sid}' overlaps with P9 fixture (must be disjoint)`);
  }
}

// (5) Disjointness: ID prefix `q2-` (not `drift-`)
for (const p of probes) {
  if (String(p.id).startsWith('drift-')) {
    failures.push(`probe ${p.id}: forbidden 'drift-' prefix (P9 namespace; Q2 must use 'q2-')`);
  }
}

// (6) Disjointness: normalized prompt text
const p9Prompts = new Set(p9.map((p) => normalize(p.prompt)));
for (const p of probes) {
  if (p9Prompts.has(normalize(p.prompt))) {
    failures.push(`probe ${p.id}: prompt verbatim duplicates a P9 probe`);
  }
}

// (7) Source distribution: ≥70% real
const realCount = probes.filter((p) => p.source === 'real').length;
const realPct = (realCount / probes.length) * 100;
if (realPct < 70) {
  failures.push(`source distribution: ${realCount}/${probes.length} (${realPct.toFixed(1)}%) real, < 70% required`);
}

// (8) Parametric-knowledge avoidance
const termCount = probes.reduce((acc, p) => {
  const text = JSON.stringify(p).toLowerCase();
  const hits = PARAM_TERMS.filter((re) => re.test(text)).length;
  if (hits > 0 && p.parametric_risk !== 'mentioned') {
    failures.push(`probe ${p.id}: contains parametric-likely terms (${hits} matches) but parametric_risk is not 'mentioned' — re-author or flag explicitly`);
  }
  return acc + hits;
}, 0);

if (failures.length === 0) {
  console.log(`[validate-q2] OK — 60 probes pass all constraints (${realCount} real / ${probes.length - realCount} synthetic; ${termCount} parametric-term hits across all probes, all flagged or absent).`);
  process.exit(0);
}

console.error(`[validate-q2] ${failures.length} constraint violation(s):`);
for (const f of failures) console.error(`  - ${f}`);
console.error('');
console.error('Re-author affected probes per q2-probe-rules.md, re-run validator. Pool is NOT locked-eligible until all constraints pass.');
process.exit(1);
