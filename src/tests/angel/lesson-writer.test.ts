/**
 * Tests for Phase 4.1 lesson writer (CONTEXT.md locked schema).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeLesson, computeLessonFilePath, renderLessonFrontmatter } from '../../angel/lesson-writer.js';
import { parseLessonFile } from '../../angel/lesson-reader.js';

const project = 'lesson-writer-proj';

function baseTelemetry() {
  return {
    tools_used: ['Read', 'Grep'],
    files_touched: ['src/x.ts'],
    errors_encountered: [],
    user_framing_tokens: ['deps', 'imports'],
    session_arc: ['investigation', 'fix'],
    duration_min: 12,
    correction_count: 1,
  };
}

describe('lesson-writer', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-writer-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a feedback lesson and round-trips through reader', () => {
    const filePath = writeLesson({
      project,
      type: 'feedback',
      slug: 'check-deps',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: baseTelemetry(),
        shape: { task_shape: 'code-edit-with-existing-deps' },
      },
      body: '# Always check existing dependencies\n\nDetailed body content.',
    });

    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = parseLessonFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.type).toBe('feedback');
    expect(parsed!.frontmatter.shape?.task_shape).toBe('code-edit-with-existing-deps');
    expect(parsed!.body).toContain('Always check existing dependencies');
  });

  it('writes a project lesson with shape ABSENT (abstain) — reader returns shape undefined', () => {
    const filePath = writeLesson({
      project,
      type: 'project',
      slug: 'mozzart-429',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: baseTelemetry(),
        // shape omitted = abstain
      },
      body: '# Mozzart 429 is per-IP, 15-min auto-heal\n\nDocumented behavior.',
    });

    const parsed = parseLessonFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.shape).toBeUndefined();
  });

  it('writes a process lesson with triggered_by and full shape', () => {
    const filePath = writeLesson({
      project,
      type: 'process',
      slug: 'trajectory-1',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: { ...baseTelemetry(), triggered_by: ['corrections', 'pivots'] },
        shape: {
          task_shape: 'design-discussion-before-commit',
          failure_mode: 'false-framing-corrected',
          solution_pattern: 'layered-combination',
        },
      },
      body: '# Decision trajectory\n\nMulti-pivot session.',
    });

    const parsed = parseLessonFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.telemetry.triggered_by).toEqual(['corrections', 'pivots']);
    expect(parsed!.frontmatter.shape?.task_shape).toBe('design-discussion-before-commit');
    expect(parsed!.frontmatter.shape?.failure_mode).toBe('false-framing-corrected');
    expect(parsed!.frontmatter.shape?.solution_pattern).toBe('layered-combination');
  });

  it('idempotent: writing same lesson twice does not modify file', () => {
    const params = {
      project,
      type: 'feedback' as const,
      slug: 'idem',
      frontmatter: { created_at_epoch_ms: 1700000000000, telemetry: baseTelemetry() },
      body: '# Idempotent body\n\nSame content twice.',
    };
    const filePath1 = writeLesson(params);
    const stat1 = fs.statSync(filePath1);
    const content1 = fs.readFileSync(filePath1, 'utf8');

    const filePath2 = writeLesson(params);
    expect(filePath2).toBe(filePath1);
    const content2 = fs.readFileSync(filePath2, 'utf8');
    expect(content2).toBe(content1);
  });

  it('rejects empty body', () => {
    expect(() => writeLesson({
      project,
      type: 'feedback',
      slug: 'empty',
      frontmatter: { created_at_epoch_ms: 1700000000000, telemetry: baseTelemetry() },
      body: '   \n\n',
    })).toThrow(/body cannot be empty/i);
  });

  it('rejects missing telemetry array fields', () => {
    expect(() => writeLesson({
      project,
      type: 'feedback',
      slug: 'no-telem',
      frontmatter: {
        created_at_epoch_ms: 1700000000000,
        telemetry: {
          // tools_used missing
          files_touched: [],
          errors_encountered: [],
          user_framing_tokens: [],
          session_arc: [],
          duration_min: 1,
          correction_count: 0,
        } as any,
      },
      body: '# Body',
    })).toThrow(/Telemetry handles incomplete/i);
  });

  it('rejects pre-1e12 created_at_epoch_ms (CUR-14 wedge)', () => {
    expect(() => writeLesson({
      project,
      type: 'feedback',
      slug: 'old-epoch',
      frontmatter: {
        created_at_epoch_ms: 1700000000, // seconds-precision (10-digit)
        telemetry: baseTelemetry(),
      },
      body: '# Body',
    })).toThrow(/ms-precision/i);
  });

  it('rejects slug containing whitespace or uppercase', () => {
    expect(() => computeLessonFilePath(project, 'feedback', 'Bad Slug')).toThrow(/Invalid lesson slug/);
    expect(() => computeLessonFilePath(project, 'feedback', 'UPPER')).toThrow(/Invalid lesson slug/);
  });

  it('renderLessonFrontmatter omits shape block when all fields are null', () => {
    const yaml = renderLessonFrontmatter('feedback', {
      created_at_epoch_ms: 1700000000000,
      telemetry: baseTelemetry(),
      shape: { task_shape: undefined, failure_mode: undefined, solution_pattern: undefined },
    });
    expect(yaml).not.toContain('shape:');
  });

  // Phase 14-07h: trigger field tests
  it('14-07h: writeLesson with trigger — frontmatter contains trigger field', () => {
    const filePath = writeLesson({
      project,
      type: 'feedback',
      slug: 'with-trigger',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: baseTelemetry(),
        trigger: 'When facing a design choice, take a position first.',
      },
      body: '# Take a position\n\nBody content.',
    });

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('trigger: When facing a design choice, take a position first.');
  });

  it('14-07h: writeLesson without trigger — frontmatter omits trigger field', () => {
    const filePath = writeLesson({
      project,
      type: 'feedback',
      slug: 'no-trigger-field',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: baseTelemetry(),
        // trigger intentionally omitted
      },
      body: '# No trigger\n\nBody.',
    });

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('trigger:');
  });

  it('14-07h: readLessonTrigger returns field value when present', () => {
    const { readLessonTrigger } = await import('../../angel/lesson-writer.js');
    const filePath = writeLesson({
      project,
      type: 'feedback',
      slug: 'trigger-read',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: baseTelemetry(),
        trigger: 'When code review is requested, check security first.',
      },
      body: '# Security first\n\nAlways.',
    });

    const trigger = readLessonTrigger(filePath);
    expect(trigger).toBe('When code review is requested, check security first.');
  });

  it('14-07h: readLessonTrigger returns null when trigger absent', () => {
    const { readLessonTrigger } = await import('../../angel/lesson-writer.js');
    const filePath = writeLesson({
      project,
      type: 'project',
      slug: 'no-trigger-read',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: baseTelemetry(),
      },
      body: '# No trigger\n\nBody.',
    });

    const trigger = readLessonTrigger(filePath);
    expect(trigger).toBeNull();
  });
});
