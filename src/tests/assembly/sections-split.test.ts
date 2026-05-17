/**
 * Round-trip parity test for the Wave 0 sections.ts split (14-07-w0d).
 *
 * AC-4: For a representative fixture, every moved function's output is
 * byte-equivalent whether imported from the original path (sections.js)
 * or the new modular path (sections/lessons.js, sections/codebase-context.js).
 *
 * Tests also cover that formatCodebaseContextSection produces the SAME string
 * the assembler.ts inline code would have produced — verifying the extraction
 * is signature-preserving.
 */

import { describe, it, expect } from 'vitest';
import type { ExperiencePattern } from '../../intelligence/experience-patterns.js';
import type { LearningRow } from '../../core/learnings.js';

// ─── Import from original sections.ts path (for backwards-compat verification) ───
import {
  formatProvenPrinciplesSection as fromSections_ProvenPrinciples,
  formatLearningsSection as fromSections_Learnings,
  formatCodebaseContextSection as fromSections_CodebaseContext,
} from '../../assembly/sections.js';

// ─── Import from new modular paths (the new canonical locations) ───
import {
  formatProvenPrinciplesSection as fromLessons_ProvenPrinciples,
  formatLearningsSection as fromLessons_Learnings,
} from '../../assembly/sections/lessons.js';

import {
  formatCodebaseContextSection as fromCodebaseContext_Format,
  type CodebaseContextFile,
} from '../../assembly/sections/codebase-context.js';

// ─── Import from sections/index.ts re-export hub ───
import {
  formatProvenPrinciplesSection as fromIndex_ProvenPrinciples,
  formatLearningsSection as fromIndex_Learnings,
  formatCodebaseContextSection as fromIndex_CodebaseContext,
} from '../../assembly/sections/index.js';

// ─── Fixtures ───

const nowEpoch = Math.floor(Date.now() / 1000);

function makePattern(trigger: string, lesson: string): ExperiencePattern {
  return {
    id: 'p1',
    project: 'test-project',
    trigger_context: trigger,
    lesson,
    anti_pattern: null,
    times_triggered: 5,
    times_useful: 4,
    is_global: false,
    confidence: 0.9,
    first_observed_epoch: nowEpoch,
    last_triggered_epoch: nowEpoch,
    updated_at_epoch: nowEpoch,
  };
}

function makeLearning(content: string, promotionCount: number): LearningRow {
  return {
    id: 1,
    project: 'test-project',
    agent_id: 'default',
    fingerprint: 'fp1',
    content,
    promotion_count: promotionCount,
    first_seen_epoch: nowEpoch,
    last_promoted_epoch: nowEpoch,
    updated_at_epoch_ms: nowEpoch * 1000,
  };
}

const PATTERN_FIXTURES: ExperiencePattern[] = [
  makePattern('When doing schema migrations', 'Always run a dry-run first before applying to production'),
  makePattern('When debugging async code', 'Add explicit logging at each await boundary to trace the hang'),
];

const LEARNING_FIXTURES: LearningRow[] = [
  makeLearning('Verify function names against the actual codebase before writing specs', 3),
  makeLearning('Tests written before implementation catch edge cases earlier', 2),
  makeLearning('Round-trip parity tests are the gate for signature-preserving refactors', 1),
];

const FILE_FIXTURES: CodebaseContextFile[] = [
  {
    file_path: '/project/src/assembly/sections.ts',
    symbols: [
      { name: 'formatProvenPrinciplesSection', kind: 'function', line: 363, exported: true },
      { name: 'formatLearningsSection', kind: 'function', line: 1000, exported: true },
    ],
    relevance: 5,
  },
  {
    file_path: '/project/src/assembly/assembler.ts',
    symbols: [
      { name: 'assembleFullContext', kind: 'function', line: 324, exported: true },
      { name: 'assembleRegularPrompt', kind: 'function', line: 664, exported: true },
      { name: '_shortenPathCacheStable', kind: 'function', line: 186, exported: true },
    ],
    relevance: 3,
  },
];

const SHORTEN_PATH = (fp: string): string => {
  const norm = fp.replace(/\\/g, '/');
  const srcIdx = norm.indexOf('src/');
  return srcIdx >= 0 ? norm.substring(srcIdx) : norm.split('/').slice(-2).join('/');
};

// ─── Tests ───

describe('sections-split: round-trip parity (AC-4)', () => {

  describe('formatProvenPrinciplesSection', () => {
    it('sections.ts and sections/lessons.ts produce byte-identical output for non-empty fixture', () => {
      const fromOld = fromSections_ProvenPrinciples(PATTERN_FIXTURES);
      const fromNew = fromLessons_ProvenPrinciples(PATTERN_FIXTURES);
      expect(fromNew).toBe(fromOld);
    });

    it('sections/index.ts re-export produces byte-identical output', () => {
      const fromOld = fromSections_ProvenPrinciples(PATTERN_FIXTURES);
      const fromIndex = fromIndex_ProvenPrinciples(PATTERN_FIXTURES);
      expect(fromIndex).toBe(fromOld);
    });

    it('returns null for empty input (from new location)', () => {
      expect(fromLessons_ProvenPrinciples([])).toBeNull();
    });

    it('output starts with ## Proven Principles header', () => {
      const result = fromLessons_ProvenPrinciples(PATTERN_FIXTURES);
      expect(result).not.toBeNull();
      expect(result!.startsWith('## Proven Principles')).toBe(true);
    });

    it('renders all provided patterns', () => {
      const result = fromLessons_ProvenPrinciples(PATTERN_FIXTURES);
      expect(result).not.toBeNull();
      expect(result!).toContain('When doing schema migrations');
      expect(result!).toContain('Always run a dry-run first');
      expect(result!).toContain('When debugging async code');
    });

    it('single pattern fixture produces correct format', () => {
      const single = [makePattern('Trigger A', 'Lesson A')];
      const fromOld = fromSections_ProvenPrinciples(single);
      const fromNew = fromLessons_ProvenPrinciples(single);
      expect(fromNew).toBe(fromOld);
      expect(fromNew!).toContain('**Trigger A**: Lesson A');
    });
  });

  describe('formatLearningsSection', () => {
    it('sections.ts and sections/lessons.ts produce byte-identical output for non-empty fixture', () => {
      const fromOld = fromSections_Learnings(LEARNING_FIXTURES);
      const fromNew = fromLessons_Learnings(LEARNING_FIXTURES);
      expect(fromNew).toBe(fromOld);
    });

    it('sections/index.ts re-export produces byte-identical output', () => {
      const fromOld = fromSections_Learnings(LEARNING_FIXTURES);
      const fromIndex = fromIndex_Learnings(LEARNING_FIXTURES);
      expect(fromIndex).toBe(fromOld);
    });

    it('returns null for empty input (from new location)', () => {
      expect(fromLessons_Learnings([])).toBeNull();
    });

    it('output starts with ## Learnings header', () => {
      const result = fromLessons_Learnings(LEARNING_FIXTURES);
      expect(result).not.toBeNull();
      expect(result!.startsWith('## Learnings')).toBe(true);
    });

    it('caps at 5 learnings', () => {
      const many = Array.from({ length: 10 }, (_, i) =>
        makeLearning(`Learning ${i}`, i + 1)
      );
      const result = fromLessons_Learnings(many);
      expect(result).not.toBeNull();
      // Only first 5 should appear
      expect(result!).toContain('Learning 0');
      expect(result!).toContain('Learning 4');
      expect(result!).not.toContain('Learning 5');
    });

    it('renders promotion count for entries with count > 1', () => {
      const result = fromLessons_Learnings(LEARNING_FIXTURES);
      expect(result!).toContain('(×3)'); // promotion_count: 3
      expect(result!).toContain('(×2)'); // promotion_count: 2
      // promotion_count: 1 should NOT show ×1
      expect(result!).not.toContain('(×1)');
    });
  });

  describe('formatCodebaseContextSection', () => {
    it('sections.ts and sections/codebase-context.ts produce byte-identical output', () => {
      const fromOld = fromSections_CodebaseContext(FILE_FIXTURES, SHORTEN_PATH);
      const fromNew = fromCodebaseContext_Format(FILE_FIXTURES, SHORTEN_PATH);
      expect(fromNew).toBe(fromOld);
    });

    it('sections/index.ts re-export produces byte-identical output', () => {
      const fromOld = fromSections_CodebaseContext(FILE_FIXTURES, SHORTEN_PATH);
      const fromIndex = fromIndex_CodebaseContext(FILE_FIXTURES, SHORTEN_PATH);
      expect(fromIndex).toBe(fromOld);
    });

    it('returns empty string for empty files array', () => {
      expect(fromCodebaseContext_Format([], SHORTEN_PATH)).toBe('');
    });

    it('output starts with ## Codebase Context header', () => {
      const result = fromCodebaseContext_Format(FILE_FIXTURES, SHORTEN_PATH);
      expect(result.startsWith('## Codebase Context')).toBe(true);
    });

    it('renders shortened paths and exported symbols', () => {
      const result = fromCodebaseContext_Format(FILE_FIXTURES, SHORTEN_PATH);
      expect(result).toContain('src/assembly/sections.ts');
      expect(result).toContain('function formatProvenPrinciplesSection');
      expect(result).toContain('function formatLearningsSection');
    });

    it('only renders exported symbols (filters non-exported)', () => {
      const filesWithMixed: CodebaseContextFile[] = [
        {
          file_path: '/project/src/test.ts',
          symbols: [
            { name: 'publicFn', kind: 'function', line: 1, exported: true },
            { name: 'privateFn', kind: 'function', line: 10, exported: false },
          ],
          relevance: 1,
        },
      ];
      const result = fromCodebaseContext_Format(filesWithMixed, SHORTEN_PATH);
      expect(result).toContain('publicFn');
      expect(result).not.toContain('privateFn');
    });

    it('falls back to (no exports) when no exported symbols', () => {
      const filesNoExports: CodebaseContextFile[] = [
        {
          file_path: '/project/src/internal.ts',
          symbols: [
            { name: 'internalHelper', kind: 'function', line: 1, exported: false },
          ],
          relevance: 1,
        },
      ];
      const result = fromCodebaseContext_Format(filesNoExports, SHORTEN_PATH);
      expect(result).toContain('(no exports)');
    });

    it('matches the assembler.ts inline render exactly (pre-extraction parity)', () => {
      // This test replicates the exact logic that was inline in assembler.ts:857
      // to verify byte-equivalent output after extraction.
      const relevant = FILE_FIXTURES;
      const shortenFn = SHORTEN_PATH;

      // Original inline code (from assembler.ts before extraction):
      const codeParts: string[] = ['**Relevant files:**'];
      for (const f of relevant) {
        const relPath = shortenFn(f.file_path);
        const topSymbols = f.symbols
          .filter(s => s.exported)
          .slice(0, 5)
          .map(s => `${s.kind} ${s.name}`)
          .join(', ');
        codeParts.push(`- \`${relPath}\`: ${topSymbols || '(no exports)'}`);
      }
      const expectedInline = `## Codebase Context\n${codeParts.join('\n')}`;

      const fromNew = fromCodebaseContext_Format(relevant, shortenFn);
      expect(fromNew).toBe(expectedInline);
    });
  });

  describe('backwards compatibility: all existing import paths still work', () => {
    it('sections.js still exports formatProvenPrinciplesSection', () => {
      expect(typeof fromSections_ProvenPrinciples).toBe('function');
    });

    it('sections.js still exports formatLearningsSection', () => {
      expect(typeof fromSections_Learnings).toBe('function');
    });

    it('sections.js exports new formatCodebaseContextSection', () => {
      expect(typeof fromSections_CodebaseContext).toBe('function');
    });

    it('sections/index.js exports all three functions', () => {
      expect(typeof fromIndex_ProvenPrinciples).toBe('function');
      expect(typeof fromIndex_Learnings).toBe('function');
      expect(typeof fromIndex_CodebaseContext).toBe('function');
    });
  });
});
