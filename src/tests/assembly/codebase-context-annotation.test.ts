/**
 * 14-07i: codebase-context section annotation tests.
 *
 * 10 tests covering AC-6 through AC-11:
 *  1. single-file section with metadata: annotation line rendered
 *  2. multi-file section with metadata: each file has annotation
 *  3. file without metadata (fallback): existing format preserved
 *  4. match_query truncated to ~50 chars in display
 *  5. Score formatted to 2 decimal places
 *  6. Multi-match file: highest-score query rendered (via pre-sorted input)
 *  7. Budget overflow: drops last file, not annotations
 *  8. Function-list within file preserved post-annotation
 *  9. Empty match_query (defensive): falls back to format without annotation
 * 10. Cascade integration: assembler invokes the formatter and section appears
 */

import { describe, it, expect } from 'vitest';
import {
  formatCodebaseContextSection,
  type CodebaseContextFile,
} from '../../assembly/sections/codebase-context.js';
import type { SymbolInfo } from '../../indexer/codebase-indexer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SHORTEN_PATH = (fp: string): string => {
  const norm = fp.replace(/\\/g, '/');
  const srcIdx = norm.indexOf('src/');
  return srcIdx >= 0 ? norm.substring(srcIdx) : norm.split('/').slice(-2).join('/');
};

function makeSymbol(name: string, kind: SymbolInfo['kind'] = 'function', exported = true): SymbolInfo {
  return { name, kind, line: 1, exported };
}

function makeFile(
  filePath: string,
  symbolNames: string[],
  meta?: { match_query?: string; score?: number; match_kind?: 'fts' | 'vector' },
): CodebaseContextFile {
  return {
    file_path: filePath,
    symbols: symbolNames.map(n => makeSymbol(n)),
    relevance: 1,
    ...meta,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('codebase-context annotation (14-07i)', () => {

  it('1. single-file section with metadata: annotation line rendered', () => {
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/angel/heartbeat.ts', ['heartbeatTick', 'startAngel'], {
        match_query: 'Angel heartbeat',
        score: 0.84,
        match_kind: 'vector',
      }),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    expect(result).toContain('matched "Angel heartbeat"');
    expect(result).toContain('score 0.84');
    expect(result).toContain('vector');
    // Path still present
    expect(result).toContain('src/angel/heartbeat.ts');
    // New format uses — separator, not :
    expect(result).toContain('—');
  });

  it('2. multi-file section with metadata: each file has annotation', () => {
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/angel/heartbeat.ts', ['heartbeatTick'], {
        match_query: 'Angel heartbeat',
        score: 0.84,
        match_kind: 'vector',
      }),
      makeFile('/project/src/assembly/assembler.ts', ['assembleFullContext'], {
        match_query: 'session start cascade',
        score: 0.71,
        match_kind: 'fts',
      }),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    // Both files annotated
    expect(result).toContain('matched "Angel heartbeat"');
    expect(result).toContain('matched "session start cascade"');
    expect(result).toContain('score 0.84');
    expect(result).toContain('score 0.71');
    expect(result).toContain('vector');
    expect(result).toContain('fts');
  });

  it('3. file without metadata (fallback): existing format preserved', () => {
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/core/hybrid-retrieval.ts', ['hybridSearchSync', 'hybridSearchAsync']),
      // No match_query / score / match_kind
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    // Existing format: `- \`path\`: symbols`
    expect(result).toContain('src/core/hybrid-retrieval.ts');
    expect(result).toContain(': function hybridSearchSync');
    // No annotation marker present
    expect(result).not.toContain('matched "');
    expect(result).not.toContain('score ');
  });

  it('4. match_query truncated to ~50 chars in display', () => {
    const longQuery = 'A'.repeat(80); // 80 chars — longer than 50 display limit
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/core/utils.ts', ['myUtil'], {
        match_query: longQuery,
        score: 0.65,
        match_kind: 'fts',
      }),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    // The displayed query should be truncated to ≤50 chars + ellipsis
    // Full 80-char query should NOT appear
    expect(result).not.toContain(longQuery);
    // First 50 chars should appear
    expect(result).toContain('A'.repeat(50));
    // Ellipsis present (…)
    expect(result).toContain('…');
  });

  it('5. Score formatted to 2 decimal places', () => {
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/test.ts', ['testFn'], {
        match_query: 'test query',
        score: 0.84567,  // More than 2 decimals
        match_kind: 'fts',
      }),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    // Score displayed as 0.85 (2 decimals)
    expect(result).toContain('score 0.85');
    // Full precision NOT shown
    expect(result).not.toContain('0.84567');
  });

  it('6. Multi-match file: highest-score query rendered', () => {
    // Per AC-9: if a file appears in multiple channels, highest score wins.
    // The caller is responsible for resolving multi-channel hits before passing
    // to the formatter (hybrid-retrieval already does this). We verify the
    // formatter uses whatever match_query is provided (the caller already selected
    // the highest-score channel).
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/core/retrieval.ts', ['searchFts5'], {
        match_query: 'high-score query',   // This is the winner from caller
        score: 0.92,
        match_kind: 'vector',
      }),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    expect(result).toContain('matched "high-score query"');
    expect(result).toContain('score 0.92');
    expect(result).toContain('vector');
  });

  it('7. Budget overflow: drops last file, not annotations', () => {
    // Create 5 files with annotations; tight budget should drop later files
    // before dropping annotations on the surviving files.
    const files: CodebaseContextFile[] = Array.from({ length: 5 }, (_, i) =>
      makeFile(`/project/src/file${i + 1}.ts`, [`exportedFn${i + 1}`], {
        match_query: `query for file ${i + 1}`,
        score: 0.9 - i * 0.1,
        match_kind: 'fts',
      }),
    );

    // Very tight budget: only enough for 2-3 files with annotations
    const result = formatCodebaseContextSection(files, SHORTEN_PATH, 80);

    // Result should NOT be empty
    expect(result.length).toBeGreaterThan(0);

    // First file should be present with annotation (never dropped before last)
    expect(result).toContain('src/file1.ts');
    expect(result).toContain('matched "query for file 1"');

    // Count how many files appear
    const fileMatches = result.match(/src\/file\d+\.ts/g) ?? [];
    const annotationMatches = result.match(/matched "/g) ?? [];

    // Every included file should have an annotation (not the other way around)
    expect(annotationMatches.length).toBe(fileMatches.length);

    // Not all 5 files should be present (budget overflow dropped some)
    expect(fileMatches.length).toBeLessThan(5);
  });

  it('8. Function-list within file preserved post-annotation', () => {
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/assembly/assembler.ts', [
        'assembleFullContext',
        'assembleRegularPrompt',
        '_shortenPathCacheStable',
      ], {
        match_query: 'assembly cascade',
        score: 0.78,
        match_kind: 'vector',
      }),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    // All exported symbols should still appear in the output
    expect(result).toContain('function assembleFullContext');
    expect(result).toContain('function assembleRegularPrompt');
    expect(result).toContain('function _shortenPathCacheStable');

    // Annotation is also present
    expect(result).toContain('matched "assembly cascade"');
  });

  it('9. Empty match_query (defensive): falls back to format without annotation', () => {
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/core/utils.ts', ['utilFn'], {
        match_query: '',  // Empty string — defensive case
        score: 0.5,
        match_kind: 'fts',
      }),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    // Should fall back to existing format (no annotation)
    expect(result).toContain('src/core/utils.ts');
    expect(result).toContain(': function utilFn');
    expect(result).not.toContain('matched "');
  });

  it('10. Cascade integration: section starts with ## Codebase Context and contains relevant files header', () => {
    const files: CodebaseContextFile[] = [
      makeFile('/project/src/angel/heartbeat.ts', ['heartbeatTick'], {
        match_query: 'Angel heartbeat',
        score: 0.84,
        match_kind: 'vector',
      }),
      makeFile('/project/src/assembly/assembler.ts', ['assembleFullContext']),
    ];

    const result = formatCodebaseContextSection(files, SHORTEN_PATH);

    // Section header structure preserved
    expect(result.startsWith('## Codebase Context\n')).toBe(true);
    expect(result).toContain('**Relevant files:**');

    // Annotated file first
    expect(result.indexOf('matched "Angel heartbeat"')).toBeLessThan(
      result.indexOf('src/assembly/assembler.ts')
    );

    // Fallback-format file follows
    expect(result).toContain(': function assembleFullContext');
  });
});
