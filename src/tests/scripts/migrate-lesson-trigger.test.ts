/**
 * Phase 14-07h — tests for migrate-lesson-trigger.ts CLI.
 *
 * Covers: dry-run, --infer, --trigger override, refusal-on-ambiguity,
 * --file scoping, --skip-existing, --force, idempotency, body preservation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseArgs,
  parseLessonFileBasic,
  inferTriggerFromBody,
  insertTriggerInFrontmatter,
  processFile,
  atomicWrite,
  type MigratorArgs,
} from '../../scripts/migrate-lesson-trigger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-trigger-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helper: create a minimal lesson file
// ---------------------------------------------------------------------------

function writeLessonFile(
  dir: string,
  name: string,
  {
    trigger,
    body = '# Default lesson body\n\nSome detailed content here.\n',
  }: { trigger?: string; body?: string } = {},
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
  lines.push('---', '', body);
  const content = lines.join('\n');
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function makeArgs(overrides: Partial<MigratorArgs> = {}): MigratorArgs {
  return {
    memoryDir: tmpDir,
    dryRun: true,
    infer: false,
    trigger: undefined,
    file: undefined,
    skipExisting: false,
    force: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrate-lesson-trigger — dry-run', () => {
  it('dry-run prints diff; no writes', () => {
    const filePath = writeLessonFile(tmpDir, 'feedback_test.md', {
      body: 'When things fail, investigate root cause.\n',
    });
    const original = fs.readFileSync(filePath, 'utf8');

    const result = processFile(filePath, makeArgs({ dryRun: true, infer: true }));

    expect(result.status).toBe('dry_run');
    // File must NOT be modified.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });
});

describe('migrate-lesson-trigger — --infer', () => {
  it('--infer succeeds on clear-condition body starting with "When"', () => {
    const filePath = writeLessonFile(tmpDir, 'feedback_clear.md', {
      body: 'When debugging, add logs before forming a theory.\n',
    });

    const result = processFile(filePath, makeArgs({ dryRun: false, infer: true }));

    expect(result.status).toBe('migrated');
    expect(result.proposedTrigger).toBeDefined();
    expect(result.proposedTrigger).toMatch(/When debugging/);
    const updated = fs.readFileSync(filePath, 'utf8');
    expect(updated).toContain('trigger:');
    expect(updated).toContain('When debugging');
  });

  it('--infer refuses on ambiguous body (vague opener)', () => {
    const filePath = writeLessonFile(tmpDir, 'feedback_vague.md', {
      body: 'This is important. Always remember to do things correctly.',
    });

    const result = processFile(filePath, makeArgs({ dryRun: false, infer: true }));

    expect(result.status).toBe('refused');
    // File must NOT be modified.
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('trigger:');
  });

  it('--infer refuses on empty body', () => {
    // Write file with empty body (no content after frontmatter).
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
      '---',
      '',
    ].join('\n');
    const filePath = path.join(tmpDir, 'feedback_empty-body.md');
    fs.writeFileSync(filePath, lines, 'utf8');

    const result = processFile(filePath, makeArgs({ dryRun: false, infer: true }));

    expect(result.status).toBe('refused');
  });
});

describe('migrate-lesson-trigger — --trigger override', () => {
  it('--trigger "<text>" overrides inference for the matched file', () => {
    const filePath = writeLessonFile(tmpDir, 'feedback_override.md', {
      body: '# Complicated body\n\nSome details.',
    });

    const myTrigger = 'When reviewing diffs, look for scope creep first.';
    const result = processFile(filePath, makeArgs({
      dryRun: false,
      trigger: myTrigger,
    }));

    expect(result.status).toBe('migrated');
    expect(result.proposedTrigger).toBe(myTrigger);
    const updated = fs.readFileSync(filePath, 'utf8');
    expect(updated).toContain(`trigger: ${myTrigger}`);
  });
});

describe('migrate-lesson-trigger — --file scoping', () => {
  it('--file limits to a specific filename', () => {
    writeLessonFile(tmpDir, 'feedback_file-a.md', {
      body: 'When starting, read existing code.\n',
    });
    writeLessonFile(tmpDir, 'feedback_file-b.md', {
      body: 'When debugging, check logs.\n',
    });

    // Process only file-a.
    const fileAPath = path.join(tmpDir, 'feedback_file-a.md');
    const result = processFile(fileAPath, makeArgs({
      dryRun: false,
      infer: true,
      file: 'feedback_file-a.md',
    }));

    expect(result.status).toBe('migrated');
    expect(result.file).toBe('feedback_file-a.md');

    // file-b must NOT have trigger added.
    const fileBContent = fs.readFileSync(path.join(tmpDir, 'feedback_file-b.md'), 'utf8');
    expect(fileBContent).not.toContain('trigger:');
  });
});

describe('migrate-lesson-trigger — --skip-existing', () => {
  it('--skip-existing leaves files with trigger field unchanged', () => {
    const existingTrigger = 'When testing, always isolate the cause.';
    const filePath = writeLessonFile(tmpDir, 'feedback_has-trigger.md', {
      trigger: existingTrigger,
      body: '# Body\n\nContent.',
    });
    const original = fs.readFileSync(filePath, 'utf8');

    const result = processFile(filePath, makeArgs({
      dryRun: false,
      infer: true,
      skipExisting: true,
    }));

    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });
});

describe('migrate-lesson-trigger — --force', () => {
  it('--force overwrites existing trigger field', () => {
    const filePath = writeLessonFile(tmpDir, 'feedback_force-overwrite.md', {
      trigger: 'Old trigger text.',
      body: '# Body\n\nContent.',
    });

    const newTrigger = 'When pairing, speak your assumptions out loud.';
    const result = processFile(filePath, makeArgs({
      dryRun: false,
      trigger: newTrigger,
      force: true,
    }));

    expect(result.status).toBe('migrated');
    const updated = fs.readFileSync(filePath, 'utf8');
    expect(updated).toContain(newTrigger);
    expect(updated).not.toContain('Old trigger text.');
  });
});

describe('migrate-lesson-trigger — idempotency', () => {
  it('idempotent: re-running with --skip-existing is a no-op on migrated files', () => {
    const trigger = 'When deploying, run smoke tests first.';
    const filePath = writeLessonFile(tmpDir, 'feedback_idempotent.md', {
      trigger,
      body: '# Body\n\nContent.',
    });
    const originalContent = fs.readFileSync(filePath, 'utf8');

    // Run with --skip-existing.
    const result1 = processFile(filePath, makeArgs({ dryRun: false, infer: true, skipExisting: true }));
    expect(result1.status).toBe('skipped');

    const result2 = processFile(filePath, makeArgs({ dryRun: false, infer: true, skipExisting: true }));
    expect(result2.status).toBe('skipped');

    // File must be unchanged.
    expect(fs.readFileSync(filePath, 'utf8')).toBe(originalContent);
  });
});

describe('migrate-lesson-trigger — preservation', () => {
  it('preserves other frontmatter fields byte-equivalent', () => {
    const filePath = writeLessonFile(tmpDir, 'feedback_preserve-fm.md', {
      body: 'When reviewing, check for edge cases.\n',
    });
    const before = parseLessonFileBasic(fs.readFileSync(filePath, 'utf8'));
    expect(before).not.toBeNull();

    const originalCreatedAt = before!.frontmatter.fields['created_at_epoch_ms'];

    processFile(filePath, makeArgs({ dryRun: false, infer: true }));

    const after = parseLessonFileBasic(fs.readFileSync(filePath, 'utf8'));
    expect(after).not.toBeNull();
    // All original fields preserved.
    expect(after!.frontmatter.fields['type']).toBe(before!.frontmatter.fields['type']);
    expect(after!.frontmatter.fields['created_at_epoch_ms']).toBe(originalCreatedAt);
  });

  it('preserves body content byte-equivalent after migration', () => {
    const originalBody = 'When starting a new feature, write tests first.\n\nThis is the second paragraph.';
    const filePath = writeLessonFile(tmpDir, 'feedback_preserve-body.md', {
      body: originalBody,
    });

    processFile(filePath, makeArgs({ dryRun: false, infer: true }));

    const after = parseLessonFileBasic(fs.readFileSync(filePath, 'utf8'));
    expect(after).not.toBeNull();
    expect(after!.body).toBe(originalBody);
  });
});

// ---------------------------------------------------------------------------
// inferTriggerFromBody unit tests
// ---------------------------------------------------------------------------

describe('inferTriggerFromBody', () => {
  it('returns trigger for body starting with "When"', () => {
    const result = inferTriggerFromBody('When the build fails, check logs first.\n\nMore details.');
    expect('trigger' in result).toBe(true);
    if ('trigger' in result) {
      expect(result.trigger).toMatch(/When the build fails/);
    }
  });

  it('refuses on body starting with vague opener "This is"', () => {
    const result = inferTriggerFromBody('This is important to remember.');
    expect('refused' in result).toBe(true);
  });

  it('refuses on empty body', () => {
    const result = inferTriggerFromBody('   \n\n  ');
    expect('refused' in result).toBe(true);
  });

  it('refuses on sentence too short', () => {
    const result = inferTriggerFromBody('Check it.');
    expect('refused' in result).toBe(true);
  });
});
