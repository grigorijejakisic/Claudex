/**
 * Tests for Phase 4.1 lesson reader (CONTEXT.md locked schema).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseLessonFile, listLessonsForProject } from '../../angel/lesson-reader.js';
import { writeLesson } from '../../angel/lesson-writer.js';
import { pathToCcSlug } from '../../shared/cc-slug.js';

const project = 'lesson-reader-proj';

function baseTelemetry() {
  return {
    tools_used: ['Read'],
    files_touched: ['src/x.ts'],
    errors_encountered: [],
    user_framing_tokens: ['x'],
    session_arc: ['fix'],
    duration_min: 5,
    correction_count: 0,
  };
}

describe('lesson-reader', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let memDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-reader-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // For path-shape inputs, reader uses pathToCcSlug; align our memDir with that.
    const slug = pathToCcSlug(project);
    memDir = path.join(tmpHome, '.claude', 'projects', slug, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns null for non-existent file', () => {
    expect(parseLessonFile(path.join(tmpHome, 'nope.md'))).toBeNull();
  });

  it('returns null for file without frontmatter delimiters', () => {
    const fp = path.join(memDir, 'feedback_x.md');
    fs.writeFileSync(fp, 'no frontmatter just body', 'utf8');
    expect(parseLessonFile(fp)).toBeNull();
  });

  it('returns null for filename-vs-frontmatter type mismatch', () => {
    const fp = path.join(memDir, 'feedback_x.md');
    fs.writeFileSync(fp, [
      '---',
      'type: project',
      'created_at_epoch_ms: 1700000000000',
      'telemetry:',
      '  tools_used: []',
      '  files_touched: []',
      '  errors_encountered: []',
      '  user_framing_tokens: []',
      '  session_arc: []',
      '  duration_min: 1',
      '  correction_count: 0',
      '---',
      '',
      '# body',
    ].join('\n'), 'utf8');
    expect(parseLessonFile(fp)).toBeNull();
  });

  it('parses a feedback lesson written by lesson-writer', () => {
    writeLesson({
      project,
      type: 'feedback',
      slug: 'parse-me',
      frontmatter: {
        created_at_epoch_ms: 1700000000000,
        telemetry: baseTelemetry(),
        shape: { task_shape: 'fix' },
      },
      body: '# Salience headline\n\nMore body.',
    });

    const fp = path.join(memDir, 'feedback_parse-me.md');
    const parsed = parseLessonFile(fp);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.type).toBe('feedback');
    expect(parsed!.frontmatter.created_at_epoch_ms).toBe(1700000000000);
    expect(parsed!.frontmatter.telemetry.tools_used).toEqual(['Read']);
    expect(parsed!.frontmatter.shape?.task_shape).toBe('fix');
    expect(parsed!.body).toContain('# Salience headline');
  });

  it('parses inline confidence comments on shape values (strips comment)', () => {
    const fp = path.join(memDir, 'feedback_with-comment.md');
    fs.writeFileSync(fp, [
      '---',
      'type: feedback',
      'created_at_epoch_ms: 1700000000000',
      'telemetry:',
      '  tools_used: []',
      '  files_touched: []',
      '  errors_encountered: []',
      '  user_framing_tokens: []',
      '  session_arc: []',
      '  duration_min: 1',
      '  correction_count: 0',
      'shape:',
      '  task_shape: design-discussion-before-commit  # confidence: 0.91',
      '---',
      '',
      '# body',
    ].join('\n'), 'utf8');

    const parsed = parseLessonFile(fp);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.shape?.task_shape).toBe('design-discussion-before-commit');
  });

  it('listLessonsForProject returns empty for missing memory directory', () => {
    // Use an unregistered project ID; resolveProjectPath returns null,
    // and the path-shape fallback uses the project string as cc-slug.
    expect(listLessonsForProject('nonexistent-proj')).toEqual([]);
  });

  it('listLessonsForProject returns sorted ParsedLesson[] skipping malformed and non-lesson files', () => {
    writeLesson({
      project,
      type: 'feedback',
      slug: 'a-first',
      frontmatter: { created_at_epoch_ms: 1700000000000, telemetry: baseTelemetry() },
      body: '# A',
    });
    writeLesson({
      project,
      type: 'project',
      slug: 'b-second',
      frontmatter: { created_at_epoch_ms: 1700000000000, telemetry: baseTelemetry() },
      body: '# B',
    });
    // Add a non-lesson markdown file (e.g., MEMORY.md) — should be ignored.
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), 'noise', 'utf8');
    // Add a malformed lesson file (right name pattern, broken frontmatter) — skipped.
    fs.writeFileSync(path.join(memDir, 'feedback_broken.md'), 'no frontmatter', 'utf8');

    const lessons = listLessonsForProject(project);
    expect(lessons.length).toBe(2);
    expect(lessons.map(l => l.filename).sort()).toEqual([
      'feedback_a-first.md',
      'project_b-second.md',
    ]);
  });

  it('parses tier and last_fired_at_epoch fields', () => {
    const fp = path.join(memDir, 'feedback_tiered.md');
    fs.writeFileSync(fp, [
      '---',
      'type: feedback',
      'created_at_epoch_ms: 1700000000000',
      'telemetry:',
      '  tools_used: []',
      '  files_touched: []',
      '  errors_encountered: []',
      '  user_framing_tokens: []',
      '  session_arc: []',
      '  duration_min: 1',
      '  correction_count: 0',
      'tier: background',
      'last_fired_at_epoch: 1700000005000',
      '---',
      '',
      '# body',
    ].join('\n'), 'utf8');

    const parsed = parseLessonFile(fp);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.tier).toBe('background');
    expect(parsed!.frontmatter.last_fired_at_epoch).toBe(1700000005000);
  });
});
