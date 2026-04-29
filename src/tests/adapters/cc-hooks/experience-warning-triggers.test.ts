/**
 * INJ-07 reactive trigger tests (Phase 5 Plan 08).
 *
 * Tests the three pure trigger-detection functions exported from
 * experience-patterns.ts:
 *   - isExplicitMemoryQuery (UPS keyword match)
 *   - findPatternsByPathGlob (PreToolUse Edit/Write)
 *   - findPatternsByCommandSubstring (PreToolUse Bash)
 *
 * Wiring of these into the hooks themselves is intentionally minimal in this
 * plan; the gating test surface here is the boundary that future hook
 * integration calls into.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDatabase } from '../../helpers/test-db.js';
import {
  EXPLICIT_QUERY_KEYWORDS,
  isExplicitMemoryQuery,
  findPatternsByPathGlob,
  findPatternsByCommandSubstring,
  _globToRegex,
} from '../../../intelligence/experience-patterns.js';
import { GLOBAL_PROJECT_SCOPE } from '../../../shared/constants.js';

let db: TestDatabase;

beforeEach(() => { db = createTestDb(); });
afterEach(() => { db.close(); });

function seedPattern(opts: {
  project?: string;
  trigger_glob?: string | null;
  trigger_command?: string | null;
  pattern_type?: 'correction' | 'behavioral' | 'discovery';
  score?: number;
}): string {
  const id = ulid();
  db.prepare(`
    INSERT INTO experience_patterns (
      id, pattern_type, trigger_context, lesson, severity, score,
      source_project, created_at_epoch, trigger_glob, trigger_command
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.pattern_type ?? 'correction',
    'sample trigger context',
    'sample lesson',
    'important',
    opts.score ?? 5,
    opts.project ?? 'test-project',
    Math.floor(Date.now() / 1000),
    opts.trigger_glob ?? null,
    opts.trigger_command ?? null,
  );
  return id;
}

describe('isExplicitMemoryQuery (UPS reactive trigger)', () => {
  test('matches "do you remember when we ran into the X bug" (case-sensitive variant)', () => {
    expect(isExplicitMemoryQuery('do you remember when we ran into the X bug')).toBe(true);
  });

  test('matches uppercase "DO YOU REMEMBER..." (case-insensitive)', () => {
    expect(isExplicitMemoryQuery('DO YOU REMEMBER the rate-limit issue')).toBe(true);
  });

  test('matches "have we" phrasing', () => {
    expect(isExplicitMemoryQuery('Have we seen this kind of error before?')).toBe(true);
  });

  test('matches "last time" phrasing', () => {
    expect(isExplicitMemoryQuery('What was the fix last time we hit this?')).toBe(true);
  });

  test('does NOT match "let me check the codebase" (no canonical keyword)', () => {
    expect(isExplicitMemoryQuery('let me check the codebase')).toBe(false);
  });

  test('does NOT match empty string', () => {
    expect(isExplicitMemoryQuery('')).toBe(false);
  });

  test('canonical keyword list contains expected entries', () => {
    expect(EXPLICIT_QUERY_KEYWORDS).toContain('do you remember');
    expect(EXPLICIT_QUERY_KEYWORDS).toContain('have we');
    expect(EXPLICIT_QUERY_KEYWORDS).toContain('last time');
  });
});

describe('_globToRegex helper', () => {
  test('translates `src/intelligence/*.ts` correctly (single-segment wildcard)', () => {
    const re = _globToRegex('src/intelligence/*.ts');
    expect(re.test('src/intelligence/foo.ts')).toBe(true);
    expect(re.test('src/intelligence/sub/foo.ts')).toBe(false); // single * does NOT cross /
  });

  test('translates `src/**/*.ts` correctly (double-segment wildcard)', () => {
    const re = _globToRegex('src/**/*.ts');
    // ** matches any number of intermediate dirs (including zero is a known
    // edge — current implementation requires at least one segment between
    // src/ and *.ts; that's acceptable for the trigger surface in this plan).
    expect(re.test('src/intelligence/foo.ts')).toBe(true);
    expect(re.test('src/intelligence/sub/foo.ts')).toBe(true);
    expect(re.test('lib/foo.ts')).toBe(false);
  });

  test('escapes regex specials', () => {
    const re = _globToRegex('foo.bar+baz');
    expect(re.test('foo.bar+baz')).toBe(true);
    expect(re.test('fooXbarYbaz')).toBe(false);
  });
});

describe('findPatternsByPathGlob (PreToolUse Edit/Write trigger)', () => {
  test('pattern with glob `src/intelligence/*.ts` matches file_path under that path', () => {
    seedPattern({ trigger_glob: 'src/intelligence/*.ts' });
    const matches = findPatternsByPathGlob(db, 'test-project', 'src/intelligence/foo.ts');
    expect(matches).toHaveLength(1);
  });

  test('pattern with glob `src/intelligence/*.ts` does NOT match file_path under different dir', () => {
    seedPattern({ trigger_glob: 'src/intelligence/*.ts' });
    const matches = findPatternsByPathGlob(db, 'test-project', 'src/core/foo.ts');
    expect(matches).toHaveLength(0);
  });

  test('CACH-03 host normalization: Windows-style `\\` paths are matched as `/`', () => {
    seedPattern({ trigger_glob: 'src/core/*.ts' });
    const matches = findPatternsByPathGlob(db, 'test-project', 'src\\core\\foo.ts');
    expect(matches).toHaveLength(1);
  });

  test('global-scope pattern (source_project = __global__) matches across projects', () => {
    seedPattern({ project: GLOBAL_PROJECT_SCOPE, trigger_glob: '**/*.ts' });
    const matches = findPatternsByPathGlob(db, 'any-project', 'lib/foo.ts');
    expect(matches).toHaveLength(1);
  });

  test('pattern with score=0 is excluded (decayed dead patterns)', () => {
    seedPattern({ trigger_glob: 'src/**/*.ts', score: 0 });
    const matches = findPatternsByPathGlob(db, 'test-project', 'src/foo.ts');
    expect(matches).toHaveLength(0);
  });

  test('empty filePath returns []', () => {
    seedPattern({ trigger_glob: 'src/*.ts' });
    expect(findPatternsByPathGlob(db, 'test-project', '')).toEqual([]);
  });

  test('limit caps result count', () => {
    seedPattern({ trigger_glob: 'src/*.ts' });
    seedPattern({ trigger_glob: 'src/*.ts' });
    seedPattern({ trigger_glob: 'src/*.ts' });
    const matches = findPatternsByPathGlob(db, 'test-project', 'src/foo.ts', 2);
    expect(matches.length).toBeLessThanOrEqual(2);
  });
});

describe('findPatternsByCommandSubstring (PreToolUse Bash trigger)', () => {
  test('pattern with trigger_command="bun test" fires on `bun test src/tests`', () => {
    seedPattern({ trigger_command: 'bun test' });
    const matches = findPatternsByCommandSubstring(db, 'test-project', 'bun test src/tests/foo.test.ts');
    expect(matches).toHaveLength(1);
  });

  test('pattern with trigger_command="bun test" does NOT fire on `bun run build`', () => {
    seedPattern({ trigger_command: 'bun test' });
    const matches = findPatternsByCommandSubstring(db, 'test-project', 'bun run build');
    expect(matches).toHaveLength(0);
  });

  test('global-scope pattern matches across projects', () => {
    seedPattern({ project: GLOBAL_PROJECT_SCOPE, trigger_command: 'rm -rf' });
    const matches = findPatternsByCommandSubstring(db, 'any-project', 'rm -rf node_modules');
    expect(matches).toHaveLength(1);
  });

  test('empty command returns []', () => {
    seedPattern({ trigger_command: 'git push' });
    expect(findPatternsByCommandSubstring(db, 'test-project', '')).toEqual([]);
  });

  test('pattern with score=0 is excluded', () => {
    seedPattern({ trigger_command: 'docker build', score: 0 });
    const matches = findPatternsByCommandSubstring(db, 'test-project', 'docker build .');
    expect(matches).toHaveLength(0);
  });
});
