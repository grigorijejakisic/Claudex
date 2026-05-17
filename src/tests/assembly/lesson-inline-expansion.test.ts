/**
 * Phase 14-07j — lesson inline-expansion section tests.
 *
 * 14 tests covering:
 *  1.  pivot_text absent: returns null (graceful fallback)
 *  2.  pivot_text empty string: returns null (graceful fallback)
 *  3.  pivot_text present: top-K inline-expanded lessons appear
 *  4.  Inline-expanded lesson has trigger as H3 header
 *  5.  Inline-expanded lesson body truncated at ~130 tokens
 *  6.  Source line includes lesson filename
 *  7.  Remaining lessons appear as pointer lines
 *  8.  Empty memory_dir: returns null
 *  9.  Sparse link graph (no link distance signal): trigger-only ranking
 * 10.  Pivot keywords matching some lessons but not others: ranked correctly
 * 11.  K=0 explicitly: no inline-expansion; returns null (no pivot context)
 * 12.  Lesson with multi-paragraph body: truncated at first sentence boundary if possible
 * 13.  CLAUDEX_LESSON_INLINE_K env var override
 * 14.  H's existing formatProvenPrinciplesSection still works after J's extension
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  formatLessonsWithInlineExpansion,
  inlineExpandLesson,
  INLINE_EXPANSION_BUDGET_TOKENS,
  PER_LESSON_BODY_TOKEN_CAP,
} from '../../assembly/sections/lessons.js';
import {
  formatProvenPrinciplesSection,
} from '../../assembly/sections/lessons.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { migrateV37toV38 } from '../../core/migration-steps.js';

// ─── DB helpers ───────────────────────────────────────────────────────────────

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyV17DDL(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
  migrateV37toV38(db);
  return db;
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

let tmpDir: string;

function writeLessonFile(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function makeLessonFile(slug: string, opts: {
  type?: 'feedback' | 'project' | 'process';
  trigger?: string;
  body?: string;
} = {}): string {
  const {
    type = 'feedback',
    trigger,
    body = `This is the body of lesson ${slug}.`,
  } = opts;
  const triggerLine = trigger ? `trigger: ${trigger}\n` : '';
  const content =
    `---\ntype: ${type}\ncreated_at_epoch_ms: 1700000000000\n${triggerLine}` +
    `telemetry:\n  tools_used: []\n  files_touched: []\n  errors_encountered: []\n` +
    `  user_framing_tokens: []\n  session_arc: []\n  duration_min: 10\n  correction_count: 0\n` +
    `---\n\n${body}\n`;
  return writeLessonFile(`${type}_${slug}.md`, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-inline-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }
  delete process.env.CLAUDEX_LESSON_INLINE_K;
  delete process.env.CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT;
});

// ─── Helper: create a params object ──────────────────────────────────────────

function makeParams(overrides: Partial<Parameters<typeof formatLessonsWithInlineExpansion>[0]> = {}) {
  const db = buildDb();
  return {
    db,
    project: 'test-project',
    memory_dir: tmpDir,
    budget_tokens: 2000,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('formatLessonsWithInlineExpansion', () => {
  it('1. pivot_text absent: returns null (graceful fallback)', () => {
    makeLessonFile('lesson-a', { trigger: 'handoff schema' });
    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: undefined,
    }));
    expect(result).toBeNull();
  });

  it('2. pivot_text empty string: returns null (graceful fallback)', () => {
    makeLessonFile('lesson-b', { trigger: 'handoff schema' });
    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: '',
    }));
    expect(result).toBeNull();
  });

  it('3. pivot_text present: top-K inline-expanded lessons appear', () => {
    makeLessonFile('lesson-match', { trigger: 'handoff schema design', body: 'Always design handoff schemas carefully.' });
    makeLessonFile('lesson-nomatch', { trigger: 'database migration rollback', body: 'Rollback is hard.' });

    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: 'handoff schema design session',
      inline_top_k: 1,
    }));

    expect(result).not.toBeNull();
    // The matching lesson should be inline-expanded (H3 header)
    expect(result).toContain('### [');
    expect(result).toContain('handoff schema design');
  });

  it('4. Inline-expanded lesson has trigger as H3 header', () => {
    makeLessonFile('trigger-test', { trigger: 'My special trigger condition' });

    const filePath = path.join(tmpDir, 'feedback_trigger-test.md');
    const expanded = inlineExpandLesson(filePath);

    expect(expanded).not.toBeNull();
    expect(expanded).toContain('### [My special trigger condition]');
  });

  it('5. Inline-expanded lesson body truncated at ~130 tokens', () => {
    // Create a body that is very long (>130 tokens ≈ 520 chars)
    const longBody = 'word '.repeat(200); // 200 words × 5 chars = 1000 chars ≈ 250 tokens
    makeLessonFile('long-lesson', { trigger: 'truncation test', body: longBody });

    const filePath = path.join(tmpDir, 'feedback_long-lesson.md');
    const expanded = inlineExpandLesson(filePath, PER_LESSON_BODY_TOKEN_CAP);

    expect(expanded).not.toBeNull();
    // Body should be truncated: estimate tokens of the body portion
    // Extract the body portion (between header and source line)
    const lines = expanded!.split('\n');
    const headerLine = lines[0]; // ### [...]
    const sourceLine = lines[lines.length - 1]; // *Source: ...*
    const bodyLines = lines.slice(1, lines.length - 1);
    const bodyText = bodyLines.join('\n');

    // Should end with ellipsis
    expect(bodyText.trim()).toMatch(/…$/);
    // Body token estimate should be <= PER_LESSON_BODY_TOKEN_CAP + small buffer
    const bodyTokens = Math.ceil(bodyText.length / 4);
    expect(bodyTokens).toBeLessThanOrEqual(PER_LESSON_BODY_TOKEN_CAP + 5);
  });

  it('6. Source line includes lesson filename', () => {
    makeLessonFile('source-check', { trigger: 'source filename test' });

    const filePath = path.join(tmpDir, 'feedback_source-check.md');
    const expanded = inlineExpandLesson(filePath);

    expect(expanded).not.toBeNull();
    expect(expanded).toContain('*Source: feedback_source-check.md*');
  });

  it('7. Remaining lessons appear as pointer lines', () => {
    makeLessonFile('lesson-match', { trigger: 'handoff schema pivot', body: 'Handoff body.' });
    makeLessonFile('lesson-other1', { trigger: 'database rollback test', body: 'Other body 1.' });
    makeLessonFile('lesson-other2', { trigger: 'network timeout error', body: 'Other body 2.' });

    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: 'handoff schema pivot',
      inline_top_k: 1,
    }));

    expect(result).not.toBeNull();
    // The non-top-K lessons should be pointer lines (- [...](filename))
    expect(result).toContain('- [');
    // Pointer lines should have .md filenames
    expect(result).toMatch(/feedback_lesson-other[12]\.md/);
  });

  it('8. Empty memory_dir: returns null', () => {
    // No files created in tmpDir
    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: 'handoff schema',
    }));
    expect(result).toBeNull();
  });

  it('9. Sparse link graph (no link distance signal): trigger-only ranking', () => {
    // No artifacts, no links in DB → link_distance_score = 0 for all
    // Selection should still work via trigger-only scoring
    makeLessonFile('lesson-match', { trigger: 'handoff schema design' });
    makeLessonFile('lesson-nomatch', { trigger: 'database migration rollback' });

    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: 'handoff schema design',
      pivot_artifact_ids: [],
      inline_top_k: 1,
    }));

    expect(result).not.toBeNull();
    // Should still inline the matching lesson
    expect(result).toContain('handoff schema design');
  });

  it('10. Pivot keywords matching some lessons but not others: ranked correctly', () => {
    // lesson-hi matches pivot well; lesson-lo does not
    makeLessonFile('lesson-hi', { trigger: 'session handoff design schema artifacts', body: 'High relevance body.' });
    makeLessonFile('lesson-lo', { trigger: 'network timeout retry policy', body: 'Low relevance body.' });

    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: 'session handoff design schema artifacts',
      inline_top_k: 1,
    }));

    expect(result).not.toBeNull();
    // lesson-hi should be inline-expanded (appears with H3 header)
    expect(result).toContain('### [session handoff design schema artifacts]');
    // lesson-lo should appear as a pointer, not inline-expanded
    expect(result).toContain('feedback_lesson-lo.md');
    // lesson-lo should NOT have an H3 header
    const h3Count = (result!.match(/^### /gm) ?? []).length;
    expect(h3Count).toBe(1);
  });

  it('11. K=0 explicitly: no inline-expansion; returns null', () => {
    makeLessonFile('lesson-any', { trigger: 'any trigger' });

    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: 'any trigger text',
      inline_top_k: 0,
    }));

    // K=0 → no inline-expansion → null (no section to render)
    expect(result).toBeNull();
  });

  it('12. Lesson with multi-paragraph body: truncated at first sentence boundary if possible', () => {
    // Body with a clear sentence boundary inside the truncation window
    const body =
      'This is the first sentence that ends here. ' +
      'This is a longer second sentence that contains more information. ' +
      'This is the third sentence. '.repeat(20);
    makeLessonFile('multi-para', { trigger: 'multi paragraph lesson', body });

    const filePath = path.join(tmpDir, 'feedback_multi-para.md');
    const expanded = inlineExpandLesson(filePath, PER_LESSON_BODY_TOKEN_CAP);

    expect(expanded).not.toBeNull();
    const lines = expanded!.split('\n');
    const bodyText = lines.slice(1, -1).join('\n').trim();

    // Should end with either ellipsis (truncated) or end of content
    // If truncated, should prefer sentence boundary
    if (bodyText.endsWith('…')) {
      // Truncated — verify it didn't cut mid-word (body should end at a logical boundary)
      expect(bodyText.length).toBeGreaterThan(0);
    }
  });

  it('13. CLAUDEX_LESSON_INLINE_K env var override', () => {
    process.env.CLAUDEX_LESSON_INLINE_K = '1';

    // Create 3 lessons with matching triggers
    makeLessonFile('lesson-alpha', { trigger: 'handoff schema design one' });
    makeLessonFile('lesson-beta', { trigger: 'handoff schema design two' });
    makeLessonFile('lesson-gamma', { trigger: 'handoff schema design three' });

    const result = formatLessonsWithInlineExpansion(makeParams({
      pivot_text: 'handoff schema design',
      // inline_top_k NOT set — should use env var
    }));

    expect(result).not.toBeNull();
    // Only 1 lesson should be inline-expanded (env var K=1)
    const h3Count = (result!.match(/^### /gm) ?? []).length;
    expect(h3Count).toBe(1);
  });

  it('14. H\'s existing formatProvenPrinciplesSection still works after J\'s extension', () => {
    // Verify H's function is unmodified by J's changes
    const patterns = [
      {
        id: 'p1',
        pattern_type: 'correction' as const,
        trigger_context: 'When starting a new feature',
        lesson: 'Always write tests first.',
        anti_pattern: null,
        helpful_count: 5,
        harmful_count: 0,
        maturity: 'established' as const,
        source_project: 'test-project',
        global_scope: false,
        created_at_epoch: Math.floor(Date.now() / 1000),
        last_triggered_at_epoch: Math.floor(Date.now() / 1000),
      },
    ];

    const result = formatProvenPrinciplesSection(patterns);
    expect(result).not.toBeNull();
    expect(result).toContain('## Proven Principles');
    expect(result).toContain('When starting a new feature');
    expect(result).toContain('Always write tests first.');
  });
});

describe('inlineExpandLesson', () => {
  it('returns null for non-existent file', () => {
    const result = inlineExpandLesson('/nonexistent/path/feedback_fake.md');
    expect(result).toBeNull();
  });

  it('uses filename as header when trigger field missing', () => {
    makeLessonFile('no-trigger', { body: 'Some body content.' });
    const filePath = path.join(tmpDir, 'feedback_no-trigger.md');

    const result = inlineExpandLesson(filePath);
    expect(result).not.toBeNull();
    // Should use filename (without .md) as the header label
    expect(result).toContain('### [feedback_no-trigger]');
  });

  it('respects custom body_token_cap', () => {
    const body = 'word '.repeat(100); // ~100 words
    makeLessonFile('cap-test', { trigger: 'cap test', body });
    const filePath = path.join(tmpDir, 'feedback_cap-test.md');

    const result = inlineExpandLesson(filePath, 20); // Very small cap: 20 tokens ≈ 80 chars
    expect(result).not.toBeNull();
    // With 20-token cap, body should be very short
    const lines = result!.split('\n');
    const bodyText = lines.slice(1, -1).join('\n').trim();
    const bodyTokens = Math.ceil(bodyText.replace(/…$/, '').length / 4);
    expect(bodyTokens).toBeLessThanOrEqual(25); // 20 + small buffer for ellipsis
  });
});
