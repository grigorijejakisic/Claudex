#!/usr/bin/env node
/**
 * POLISH-04 — Test discipline lint.
 *
 * Mechanical scan that flags `expect(...).not.toThrow()` patterns in test files
 * that ALSO mention missing-dependency keywords (`missing`, `not exist`,
 * `unavailable`, `unreachable`, `nonexistent`, `ENOENT`). The combination is
 * the v5.0.1 silent-fail anti-pattern: a test that asserts no-throw on a
 * dependency-failure surface codifies the silent-success bug instead of
 * surfacing the visible-failure semantic.
 *
 * Visible, not perfect — false positives are acceptable; false negatives are
 * not. Every flagged site is a candidate for a visible-sentinel rewrite
 * (`expect(result.errors).toBe(-1)`, telemetry assertion, etc.).
 *
 * Exit code:
 *   0 — no flagged sites
 *   1 — at least one flagged site (operator must rewrite or whitelist)
 *
 * Usage:
 *   node scripts/lint-test-discipline.cjs
 *   bun run lint:test-discipline
 */

const fs = require('node:fs');
const path = require('node:path');

const SCAN_ROOTS = ['src/tests'];
const FILE_EXT = '.test.ts';

// Keywords that imply a missing-dependency surface; a `not.toThrow` near one of
// these terms within the same `it(...)` / `describe(...)` block is the pattern
// we flag.
const MISSING_DEP_KEYWORDS = [
  'missing',
  'not exist',
  'nonexistent',
  'non-existent',
  'unavailable',
  'unreachable',
  'ENOENT',
  'no such',
  'absent',
  'fall back',
  'fallback',
  'degraded',
];

// The bug-codifying pattern: expect(...).not.toThrow()
const NOT_THROW_RE = /expect\s*\([^)]*\)\s*\.\s*not\s*\.\s*toThrow\s*\(/;

function* walkTestFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTestFiles(p);
    else if (entry.isFile() && entry.name.endsWith(FILE_EXT)) yield p;
  }
}

function blocksFromSource(src) {
  // Split source into `it(...)` / `describe(...)` blocks for context-aware
  // matching. Naive but sufficient for the visible-not-perfect mandate.
  const blocks = [];
  const blockRe = /(it|describe)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const lines = src.split('\n');
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    const lineStart = src.slice(0, m.index).split('\n').length;
    // Take up to 60 lines after the opening as the block window.
    const lineEnd = Math.min(lines.length, lineStart + 60);
    const window = lines.slice(lineStart - 1, lineEnd).join('\n');
    blocks.push({ kind: m[1], label: m[2], window, startLine: lineStart });
  }
  return blocks;
}

const flagged = [];

for (const root of SCAN_ROOTS) {
  for (const file of walkTestFiles(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const blocks = blocksFromSource(src);
    for (const block of blocks) {
      if (!NOT_THROW_RE.test(block.window)) continue;
      const labelLower = block.label.toLowerCase();
      const windowLower = block.window.toLowerCase();
      const matchKeyword = MISSING_DEP_KEYWORDS.find((kw) =>
        labelLower.includes(kw) || windowLower.includes(kw),
      );
      if (!matchKeyword) continue;
      flagged.push({
        file,
        line: block.startLine,
        label: block.label,
        keyword: matchKeyword,
      });
    }
  }
}

if (flagged.length === 0) {
  console.log('[lint-test-discipline] OK — no `expect(...).not.toThrow()` on missing-dependency surfaces.');
  process.exit(0);
}

console.error('');
console.error(
  `[lint-test-discipline] ${flagged.length} site(s) flagged — \`expect(...).not.toThrow()\` ` +
    'on a missing-dependency surface is the v5.0.1 silent-fail anti-pattern.',
);
console.error(
  '  Replace with an explicit-sentinel assertion ' +
    '(e.g. `expect(result.errors).toBe(-1)` + telemetry row check).',
);
console.error('');
for (const f of flagged) {
  console.error(`  ${f.file}:${f.line}  [${f.keyword}]  in '${f.label}'`);
}
console.error('');
process.exit(1);
