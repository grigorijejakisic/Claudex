/**
 * Tests for updateLessonFrontmatter (Phase 5.5).
 *
 * Verifies frontmatter merge, body byte-preservation, atomic write,
 * idempotent no-op, and error paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { updateLessonFrontmatter } from '../../angel/lesson-writer.js';
import { parseLessonFile } from '../../angel/lesson-reader.js';
import type { LessonFrontmatter } from '../../angel/lesson-types.js';

let tmpdir: string;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'p55-lwu-'));
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function baseFrontmatter(overrides: Partial<LessonFrontmatter> = {}): string {
  const created = overrides.created_at_epoch_ms ?? 1_700_000_000_000;
  const tier = overrides.tier ? `\ntier: ${overrides.tier}` : '';
  const lastFired = overrides.last_fired_at_epoch != null
    ? `\nlast_fired_at_epoch: ${overrides.last_fired_at_epoch}`
    : '';
  return `---
type: feedback
created_at_epoch_ms: ${created}
telemetry:
  tools_used: [Read, Edit]
  files_touched: [src/foo.ts]
  errors_encountered: []
  user_framing_tokens: [check, deps]
  session_arc: [diagnose, fix]
  duration_min: 12
  correction_count: 1${tier}${lastFired}
---
`;
}

function writeFixture(filename: string, body: string, fmOverrides?: Partial<LessonFrontmatter>): string {
  const filePath = path.join(tmpdir, filename);
  fs.writeFileSync(filePath, baseFrontmatter(fmOverrides) + '\n' + body, 'utf8');
  return filePath;
}

describe('updateLessonFrontmatter', () => {
  it('preserves the body byte-for-byte after a frontmatter merge', () => {
    const body = '# Heading\n\n- bullet\n  - nested\n\n```ts\nconst x = 1;\n```\n';
    const filePath = writeFixture('feedback_byte-preserve.md', body);

    // Verify reader recovers the body before mutation
    const before = parseLessonFile(filePath);
    expect(before).not.toBeNull();
    const originalBody = before!.body;

    updateLessonFrontmatter(filePath, { tier: 'background' });

    const after = parseLessonFile(filePath);
    expect(after).not.toBeNull();
    expect(after!.body).toBe(originalBody);
    expect(after!.frontmatter.tier).toBe('background');
  });

  it('merges partial keys into existing frontmatter (last_fired_at_epoch preserved)', () => {
    const filePath = writeFixture('feedback_merge.md', 'body content\n', { last_fired_at_epoch: 1000 });

    updateLessonFrontmatter(filePath, { tier: 'background' });

    const parsed = parseLessonFile(filePath)!;
    expect(parsed.frontmatter.tier).toBe('background');
    expect(parsed.frontmatter.last_fired_at_epoch).toBe(1000);
  });

  it('writes atomically via tmp + rename — no leftover .tmp after success', () => {
    // Atomic invariant: after a successful write, the .tmp sidecar must not
    // exist (it was renamed to the final path). And the file content was
    // mutated. Using fs spies is not portable here (Node fs methods are
    // non-configurable in some runtimes), so we assert the observable
    // invariants the atomic-write contract guarantees.
    const filePath = writeFixture('feedback_atomic.md', 'body content\n');
    const tmpExpected = filePath + '.tmp';

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(tmpExpected)).toBe(false);

    updateLessonFrontmatter(filePath, { tier: 'background' });

    // Final file exists; .tmp does not (would be present only if the rename
    // step were skipped — which is what the atomic-write contract forbids).
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(tmpExpected)).toBe(false);

    // Mutation landed on disk via the rename, not via a partial write.
    const parsed = parseLessonFile(filePath)!;
    expect(parsed.frontmatter.tier).toBe('background');
  });

  it('idempotent no-op: identical merge does not change mtime', () => {
    const filePath = writeFixture('feedback_idem.md', 'body\n', { tier: 'background' });

    const mtimeBefore = fs.statSync(filePath).mtimeMs;
    // Wait a tick so any rewrite would visibly bump mtime.
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    updateLessonFrontmatter(filePath, { tier: 'background' });

    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('throws on missing file', () => {
    const filePath = path.join(tmpdir, 'feedback_missing.md');
    expect(() => updateLessonFrontmatter(filePath, { tier: 'background' })).toThrow();
  });

  it('throws on a file that is not a valid lesson (no frontmatter)', () => {
    const filePath = path.join(tmpdir, 'feedback_malformed.md');
    fs.writeFileSync(filePath, 'no frontmatter here\nplain text\n', 'utf8');
    expect(() => updateLessonFrontmatter(filePath, { tier: 'background' })).toThrow();
  });
});
