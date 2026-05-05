/**
 * Phase 2.1 Plan 02.1-05 Task 5 — append-evolving markdown test
 * (CONTEXT.md decision 4c rule 3).
 *
 * Asserts:
 *   - First render with empty priorMarkdown produces the full layout
 *     (chronological table + verdict-grouping summary + new dated
 *     section under `## Interpretive History`).
 *   - Prior dated sections survive byte-identical when a NEW dated
 *     paragraph is prepended above them.
 *   - Idempotent re-render with newParagraph=null leaves prior history
 *     unchanged.
 *   - Idempotent re-render: passing a fragment whose date+phase already
 *     exists is treated as a no-op (no double-prepend).
 *   - Chronological table is REGENERATED from JSON every render —
 *     stale rows in priorMarkdown are replaced by current values.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  renderAggregatorMarkdown,
  extractPriorInterpretiveHistory,
} from '../../../benchmark/episodic-density/aggregator-renderer.js';
import type {
  AggregatorFile,
  BoundExperience,
} from '../../../benchmark/episodic-density/aggregator.js';

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const PHASE2_ENTRY: BoundExperience = {
  phase: '2',
  labeler: 'strict_3frame',
  date: '2026-05-04',
  n: 20,
  verdict: 'KILL',
  conditions: { corpus_size: { total: 136 } },
  metrics: {
    delta_precision_at_5: { delta: 0.1, ci_lower: -0.157, ci_upper: 0.376 },
    delta_recall_at_10: { delta: -0.05, ci_lower: -0.273, ci_upper: 0.172 },
    intra_project_share: 0.234,
    p99_fused_over_p99_semantic: 0.892,
  },
};

const PHASE21_STRICT: BoundExperience = {
  phase: '2.1-strict',
  labeler: 'strict_3frame',
  date: '2026-05-05',
  n: 30,
  verdict: 'KILL',
  conditions: {},
  metrics: {
    delta_precision_at_5: { delta: 0.08, ci_lower: -0.05, ci_upper: 0.21 },
    delta_recall_at_10: { delta: 0.02, ci_lower: -0.10, ci_upper: 0.14 },
    intra_project_share: 0.25,
    p99_fused_over_p99_semantic: 1.1,
  },
};

const PHASE21_RELAXED: BoundExperience = {
  phase: '2.1-relaxed',
  labeler: 'relaxed_2frame',
  date: '2026-05-05',
  n: 45,
  verdict: 'SCOPE_DOWN',
  conditions: {},
  metrics: {
    delta_precision_at_5: { delta: 0.12, ci_lower: 0.02, ci_upper: 0.22 },
    delta_recall_at_10: { delta: 0.06, ci_lower: -0.04, ci_upper: 0.16 },
    intra_project_share: 0.31,
    p99_fused_over_p99_semantic: 2.2,
  },
};

function aggregatorWith(...entries: BoundExperience[]): AggregatorFile {
  return {
    schema_version: 1,
    question: 'q',
    bound_experiences: entries,
  };
}

describe('renderAggregatorMarkdown — first render (empty prior)', () => {
  it('produces full layout with `## Interpretive History` and one dated section', () => {
    const md = renderAggregatorMarkdown(
      aggregatorWith(PHASE2_ENTRY, PHASE21_STRICT, PHASE21_RELAXED),
      '',
      { date: '2026-05-05', phase_closing: '2.1', body: 'descriptive body text' },
    );
    expect(md).toContain('# Multi-handle aggregator');
    expect(md).toContain('## Chronological table');
    expect(md).toContain('## Verdict-grouping summary');
    expect(md).toContain('## Interpretive History');
    expect(md).toContain('### 2026-05-05 — phase 2.1 close');
    expect(md).toContain('descriptive body text');
    // Three rows in the chronological table.
    expect(md.match(/^\| 2 \|/m)).not.toBeNull();
    expect(md.match(/^\| 2\.1-strict \|/m)).not.toBeNull();
    expect(md.match(/^\| 2\.1-relaxed \|/m)).not.toBeNull();
  });
});

describe('renderAggregatorMarkdown — append-evolving (CONTEXT.md decision 4c rule 3)', () => {
  it('prior dated sections survive byte-identical when a new dated section is prepended', () => {
    const priorMd = `# Multi-handle aggregator

**Question:** q

**Bound experiences:** 1

---

## Chronological table

(stale data here — should be regenerated from JSON every render)

---

## Verdict-grouping summary

(stale)

---

## Interpretive History

(boilerplate intro)

### 2026-05-01 — phase 2 close

This is the Phase 2 close paragraph. It contains specific descriptive text that must survive verbatim.
`;
    const priorHistory = extractPriorInterpretiveHistory(priorMd);
    expect(priorHistory).toContain('### 2026-05-01 — phase 2 close');
    expect(priorHistory).toContain('Phase 2 close paragraph');
    const priorHistoryHash = hash(priorHistory.trimEnd());

    const md = renderAggregatorMarkdown(
      aggregatorWith(PHASE2_ENTRY, PHASE21_STRICT, PHASE21_RELAXED),
      priorMd,
      { date: '2026-05-05', phase_closing: '2.1', body: 'phase 2.1 close body' },
    );

    // New section appears ABOVE the prior section.
    const idxNew = md.indexOf('### 2026-05-05 — phase 2.1 close');
    const idxOld = md.indexOf('### 2026-05-01 — phase 2 close');
    expect(idxNew).toBeGreaterThan(0);
    expect(idxOld).toBeGreaterThan(0);
    expect(idxNew).toBeLessThan(idxOld);

    // Prior history block is byte-identical inside the rendered output.
    const renderedHistory = extractPriorInterpretiveHistory(md);
    // The rendered history NOW contains BOTH the new section and the
    // old section. The OLD section's byte content must match the prior
    // hash for the block of text after `### 2026-05-01 — phase 2 close`.
    const oldSectionStart = renderedHistory.indexOf('### 2026-05-01 — phase 2 close');
    expect(oldSectionStart).toBeGreaterThan(0);
    const oldSection = renderedHistory.slice(oldSectionStart).trimEnd();
    // The prior history block ends after the Phase 2 paragraph; the
    // hash should match.
    expect(hash(oldSection)).toBe(hash('### 2026-05-01 — phase 2 close\n\nThis is the Phase 2 close paragraph. It contains specific descriptive text that must survive verbatim.'.trimEnd()));
    expect(priorHistoryHash).toBeDefined();
  });
});

describe('renderAggregatorMarkdown — idempotent re-render', () => {
  it('newParagraph=null preserves prior history without adding a new section', () => {
    const priorMd = `# Multi-handle aggregator

**Question:** q

---

## Interpretive History

### 2026-05-01 — phase 2 close

Phase 2 paragraph body.
`;
    const md = renderAggregatorMarkdown(
      aggregatorWith(PHASE2_ENTRY),
      priorMd,
      null,
    );
    expect(md).toContain('### 2026-05-01 — phase 2 close');
    expect(md).toContain('Phase 2 paragraph body.');
    // No new dated section was added.
    const dateMatches = md.match(/### \d{4}-\d{2}-\d{2} — phase /g) ?? [];
    expect(dateMatches.length).toBe(1);
  });

  it('passing a fragment whose date+phase heading already exists is a no-op', () => {
    const priorMd = `# Multi-handle aggregator

---

## Interpretive History

### 2026-05-05 — phase 2.1 close

Existing 2.1 body.
`;
    const md = renderAggregatorMarkdown(
      aggregatorWith(PHASE21_STRICT, PHASE21_RELAXED),
      priorMd,
      { date: '2026-05-05', phase_closing: '2.1', body: 'NEW 2.1 body that should NOT replace' },
    );
    // The prior dated section survives.
    expect(md).toContain('### 2026-05-05 — phase 2.1 close');
    expect(md).toContain('Existing 2.1 body.');
    // The new body is NOT inserted.
    expect(md).not.toContain('NEW 2.1 body that should NOT replace');
    // Exactly one dated section.
    const dateMatches = md.match(/### \d{4}-\d{2}-\d{2} — phase /g) ?? [];
    expect(dateMatches.length).toBe(1);
  });
});

describe('renderAggregatorMarkdown — chronological table regenerated from JSON', () => {
  it('stale chronological-table rows in priorMarkdown are replaced by current JSON values', () => {
    const priorMdWithStaleTable = `# Multi-handle aggregator

## Chronological table

| Phase | ... | Verdict |
| 2 | wrong-date | wrong-verdict |

## Interpretive History

### 2026-05-01 — phase 2 close

Phase 2 body.
`;
    const md = renderAggregatorMarkdown(
      aggregatorWith(PHASE2_ENTRY),
      priorMdWithStaleTable,
      null,
    );
    // The "wrong-verdict" cell does NOT appear in the rendered output —
    // chronological table is regenerated from the JSON.
    expect(md).not.toContain('wrong-verdict');
    expect(md).not.toContain('wrong-date');
    // The current verdict and date DO appear.
    expect(md).toContain('| 2 | 2026-05-04 | strict_3frame');
    expect(md).toContain('KILL');
    // The prior dated section is still preserved.
    expect(md).toContain('### 2026-05-01 — phase 2 close');
    expect(md).toContain('Phase 2 body.');
  });
});
