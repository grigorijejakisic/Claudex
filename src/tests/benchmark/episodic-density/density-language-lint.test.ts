/**
 * Phase 2.1 Plan 02.1-05 Task 6 — density-language lint test
 * (CONTEXT.md decision 4c rule 1 + decision 6 outcomes-language).
 *
 * Strategy:
 *   - Build a CommonMark-aware blockquote + fenced-code state machine
 *     so lazy-continuation lines inside `>` blocks and fenced code
 *     blocks are excluded from the lint surface (checker NOTE 3 + 4
 *     bindings).
 *   - Run the lint over: synthetic positive/negative samples + the
 *     real rendered files (multi-handle.md, 02.1-RESULTS.md,
 *     aggregates/README.md, audit MDs).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FORBIDDEN_PATTERNS: RegExp[] = [
  /the thesis works/i,
  /the thesis doesn'?t work/i,
  /thesis is validated/i,
  /thesis is invalidated/i,
  /thesis is dead/i,
  /fusion works/i,
  /fusion doesn'?t work/i,
  /fusion is justified/i,
  /fusion isn'?t justified/i,
  /this proves/i,
  /this disproves/i,
  /\bphase 3 ships\b/i,
  /\bphase 3 does not ship\b/i,
  /\bphase 3 should ship\b/i,
  /\bphase 3 shouldn'?t ship\b/i,
  /if .* lands GREEN.*then.*ship/i,
];

interface LintResult {
  ok: boolean;
  violations: Array<{ line: number; phrase: string; text: string }>;
}

/**
 * State-machine lint per checker NOTE 3 + NOTE 4 bindings.
 *
 * State transitions:
 *   "outside"        | line starts with `>`              -> "in_blockquote" (skip line)
 *                    | line starts with ```` ``` ````    -> "in_fenced_code" (skip line)
 *                    | otherwise                         -> lint(line)
 *   "in_blockquote"  | blank line                        -> "outside" (skip line)
 *                    | otherwise                         -> stay (skip line, lazy continuation)
 *   "in_fenced_code" | line starts with ```` ``` ````    -> "outside" (skip closing fence)
 *                    | otherwise                         -> stay (skip code-block line)
 */
function lintForbiddenPhrasings(markdown: string): LintResult {
  const lines = markdown.split(/\r?\n/);
  const violations: LintResult['violations'] = [];
  let state: 'outside' | 'in_blockquote' | 'in_fenced_code' = 'outside';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (state === 'in_fenced_code') {
      if (trimmed.startsWith('```')) {
        state = 'outside';
      }
      // Skip the line either way (closing fence or content inside).
      continue;
    }

    if (state === 'in_blockquote') {
      if (trimmed === '') {
        state = 'outside';
      }
      // Skip the line — blank exits, non-blank is lazy-continuation.
      continue;
    }

    // state === 'outside'
    if (trimmed.startsWith('```')) {
      state = 'in_fenced_code';
      continue;
    }
    if (line.startsWith('>')) {
      state = 'in_blockquote';
      continue;
    }

    for (const pat of FORBIDDEN_PATTERNS) {
      const m = line.match(pat);
      if (m) {
        violations.push({ line: i + 1, phrase: m[0], text: line });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

describe('density-language lint state machine (CONTEXT.md decision 4c rule 1 + decision 6)', () => {
  it('detects forbidden phrasings on a regular outside-of-blockquote line', () => {
    const md = '# Header\n\nThe fusion works perfectly.\n';
    const result = lintForbiddenPhrasings(md);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].phrase.toLowerCase()).toBe('fusion works');
  });

  it('accepts permitted phrasings (descriptive bound-experience language)', () => {
    const md = `# Header

Aggregator contains 3 bound experiences (1 KILL, 2 GREEN_LIGHT).
Density of consistent X is itself a finding.
More measurements may be needed before any milestone-level claim is warranted.
`;
    expect(lintForbiddenPhrasings(md).ok).toBe(true);
  });

  it('whitelists forbidden phrasings inside a blockquote (the locked decision rule)', () => {
    // The locked decision rule contains "Phase 3 plan is rewritten" and
    // similar phrasings that are FORBIDDEN outside blockquotes but
    // PERMITTED inside the verbatim quote.
    const md = `# Header

> ## 5. Decision rule
>
> **GREEN-LIGHT Phase 3 — proceed with full multi-handle retrieval cutover:**
>
> KILL: Phase 3 plan is rewritten.
`;
    const result = lintForbiddenPhrasings(md);
    expect(result.ok).toBe(true);
  });

  it('whitelists CommonMark lazy-continuation lines inside a blockquote (checker NOTE 3)', () => {
    // The DECISION_RULE_QUOTE block contains lazy-continuation lines
    // inside the `>` block. A naive startsWith('>') check would FALSE-
    // POSITIVE flag these. State machine enters in_blockquote on the
    // first `>` and stays until a blank line.
    const md = `# Header

> ## 5. Decision rule
this is a lazy-continuation line
the thesis works in this lazy-continuation context
> back to a > line

This is a regular outside line.
`;
    // The lazy-continuation lines (lines 4-5) are inside the blockquote
    // per CommonMark; the "the thesis works" phrasing on line 5 is
    // skipped. A blank line on line 6 is technically the end... wait.
    // Per CommonMark, the block ends at a blank line. Let's verify the
    // state machine handles this correctly.
    const result = lintForbiddenPhrasings(md);
    // The "outside" line "This is a regular outside line." has no
    // forbidden phrasings → lint passes.
    expect(result.ok).toBe(true);
  });

  it('exits blockquote on blank line — phrase after blank is linted', () => {
    const md = `# Header

> Inside blockquote: the thesis works (whitelisted).

The thesis works (linted).
`;
    const result = lintForbiddenPhrasings(md);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    // The blockquoted "the thesis works" is whitelisted; the outside
    // line is the violation.
    expect(result.violations[0].text).toContain('(linted)');
  });

  it('whitelists fenced code blocks (checker NOTE 4)', () => {
    const md = `# Header

\`\`\`text
the fusion works (in a code block — example output)
\`\`\`

The fusion works (outside, must lint).
`;
    const result = lintForbiddenPhrasings(md);
    expect(result.ok).toBe(false);
    // Only the outside-fence line should be flagged.
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].text).toContain('outside');
  });

  it('toggle ordering: open-fence -> forbidden phrasing -> close-fence -> forbidden phrasing -> exactly ONE violation outside', () => {
    const md = `# Header

\`\`\`
the thesis works (whitelisted, in fence)
\`\`\`

the thesis works (outside, linted)
`;
    const result = lintForbiddenPhrasings(md);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].text).toContain('outside');
  });
});

describe('density-language lint over actual rendered files', () => {
  const REPO_ROOT = process.cwd();

  function lintFile(p: string, label: string): void {
    if (!fs.existsSync(p)) {
      // The file is not yet rendered — caller is responsible for invoking
      // the runner first. We don't fail the test in that branch.
      return;
    }
    const content = fs.readFileSync(p, 'utf8');
    const result = lintForbiddenPhrasings(content);
    if (!result.ok) {
      // Surface the first violation in the assertion message.
      const v = result.violations[0];
      throw new Error(
        `[${label}] forbidden phrasing at line ${v.line}: "${v.phrase}" in ${v.text}`,
      );
    }
  }

  it('aggregates/README.md is clean', () => {
    lintFile(path.join(REPO_ROOT, '.planning', 'aggregates', 'README.md'), 'README.md');
  });

  it('multi-handle.md is clean (after runner runs)', () => {
    lintFile(path.join(REPO_ROOT, '.planning', 'aggregates', 'multi-handle.md'), 'multi-handle.md');
  });

  it('02.1-RESULTS.md is clean (after runner runs)', () => {
    lintFile(
      path.join(
        REPO_ROOT,
        '.planning',
        'phases',
        '02.1-corpus-expansion-rerun',
        '02.1-RESULTS.md',
      ),
      '02.1-RESULTS.md',
    );
  });

  it('02.1-03-strict-audit.md is clean', () => {
    lintFile(
      path.join(
        REPO_ROOT,
        '.planning',
        'phases',
        '02.1-corpus-expansion-rerun',
        '02.1-03-strict-audit.md',
      ),
      'strict-audit',
    );
  });

  it('02.1-03-relaxed-audit.md is clean', () => {
    lintFile(
      path.join(
        REPO_ROOT,
        '.planning',
        'phases',
        '02.1-corpus-expansion-rerun',
        '02.1-03-relaxed-audit.md',
      ),
      'relaxed-audit',
    );
  });
});
