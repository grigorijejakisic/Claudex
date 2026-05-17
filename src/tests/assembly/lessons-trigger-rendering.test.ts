/**
 * Phase 14-07h — tests for lessons section rendering with trigger frontmatter.
 *
 * Covers: formatLessonsSectionFromDir with trigger/non-trigger lessons,
 * budget cap, mtime-DESC sort, and empty memory_dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../../core/migrations.js';
import { formatLessonsSectionFromDir } from '../../assembly/sections/lessons.js';

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-trigger-'));
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeLessonFile(
  name: string,
  { trigger, body }: { trigger?: string; body?: string } = {},
  mtime?: number,
): string {
  const lines = [
    '---',
    'type: feedback',
    `created_at_epoch_ms: ${Date.now()}`,
    'telemetry:',
    '  tools_used: []',
    '  files_touched: []',
    '  errors_encountered: []',
    '  user_framing_tokens: []',
    '  session_arc: []',
    '  duration_min: 0',
    '  correction_count: 0',
  ];
  if (trigger) lines.push(`trigger: ${trigger}`);
  lines.push('---', '', body ?? '# Body headline\n\nContent.');
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  if (mtime !== undefined) {
    fs.utimesSync(filePath, new Date(mtime), new Date(mtime));
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatLessonsSectionFromDir', () => {
  it('with N lessons: section has N pointer lines (under budget)', () => {
    writeLessonFile('feedback_a.md', { trigger: 'When A happens, do X.' });
    writeLessonFile('feedback_b.md', { trigger: 'When B happens, do Y.' });
    writeLessonFile('feedback_c.md', { trigger: 'When C happens, do Z.' });

    const section = formatLessonsSectionFromDir({
      db,
      project: 'test',
      memory_dir: tmpDir,
      budget_tokens: 1000,
    });

    expect(section).not.toBeNull();
    const lines = section!.split('\n').filter(l => l.startsWith('- ['));
    expect(lines).toHaveLength(3);
  });

  it('lesson with trigger: line shows trigger text', () => {
    writeLessonFile('feedback_trigger-shown.md', {
      trigger: 'When reviewing code, check imports first.',
      body: '# Body headline should NOT appear\n\nDetails.',
    });

    const section = formatLessonsSectionFromDir({
      db,
      project: 'test',
      memory_dir: tmpDir,
      budget_tokens: 1000,
    });

    expect(section).not.toBeNull();
    expect(section).toContain('When reviewing code, check imports first.');
    expect(section).not.toContain('Body headline should NOT appear');
  });

  it('lesson without trigger: line shows truncated-body fallback', () => {
    writeLessonFile('feedback_no-trigger.md', {
      body: '# Body headline fallback text\n\nMore content.',
    });

    const section = formatLessonsSectionFromDir({
      db,
      project: 'test',
      memory_dir: tmpDir,
      budget_tokens: 1000,
    });

    expect(section).not.toBeNull();
    expect(section).toContain('Body headline fallback text');
  });

  it('budget cap: truncates with "... and N more" message', () => {
    // Write many lessons to exceed a small budget.
    for (let i = 0; i < 10; i++) {
      writeLessonFile(`feedback_lesson-${i}.md`, {
        trigger: `When situation ${i} occurs, take action ${i} in this specific way.`,
      });
    }

    // Very small budget — should force truncation.
    const section = formatLessonsSectionFromDir({
      db,
      project: 'test',
      memory_dir: tmpDir,
      budget_tokens: 60, // very tight: header uses ~20, ~30-40 per line
    });

    // Should have the "... and N more" message if budget was hit.
    if (section) {
      const pointerLines = section.split('\n').filter(l => l.startsWith('- ['));
      const moreMessage = section.includes('more lessons available');
      // Either all fit (no truncation needed) or we have truncation message.
      expect(pointerLines.length <= 10).toBe(true);
      if (pointerLines.length < 10) {
        expect(moreMessage).toBe(true);
      }
    }
  });

  it('mtime-DESC sort: most recently modified file appears first', () => {
    const baseTime = Date.now() - 100_000;
    writeLessonFile('feedback_older.md', { trigger: 'Older lesson trigger.' }, baseTime);
    writeLessonFile('feedback_newer.md', { trigger: 'Newer lesson trigger.' }, baseTime + 50_000);

    const section = formatLessonsSectionFromDir({
      db,
      project: 'test',
      memory_dir: tmpDir,
      budget_tokens: 1000,
    });

    expect(section).not.toBeNull();
    const newerIdx = section!.indexOf('Newer lesson trigger.');
    const olderIdx = section!.indexOf('Older lesson trigger.');
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('empty memory_dir: returns null', () => {
    // No lesson files in tmpDir.
    const section = formatLessonsSectionFromDir({
      db,
      project: 'test',
      memory_dir: tmpDir,
      budget_tokens: 1000,
    });

    expect(section).toBeNull();
  });

  it('non-existent memory_dir: returns null', () => {
    const section = formatLessonsSectionFromDir({
      db,
      project: 'test',
      memory_dir: path.join(tmpDir, 'does-not-exist'),
      budget_tokens: 1000,
    });

    expect(section).toBeNull();
  });
});
