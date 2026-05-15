/**
 * Phase 5.5 Plan 04 — heartbeat curation-sweep tests.
 *
 * Covers archive + promote sweep predicates, idempotency, time gates,
 * and resilience to missing lesson files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { ensurePointerId } from '../../angel/pointer-recall.js';
import {
  sweepArchivePointers,
  sweepPromotePointers,
  shouldRunArchiveSweep,
  markArchiveSweepRan,
  shouldRunPromoteSweep,
  markPromoteSweepRan,
  __resetGatesForTests,
} from '../../angel/curation-sweep.js';
import { parseLessonFile } from '../../angel/lesson-reader.js';

let db: Database.Database;
let tmpdir: string;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'p55-cs-'));
  __resetGatesForTests();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

interface SeedOpts {
  project: string;
  filename: string;
  tier?: 'foreground' | 'background';
  lastFired?: number;
  createdAt?: number;
}

/**
 * Write a valid lesson file at <tmpdir>/projects/<project>/memory/<filename>.
 * Bypass the writeLesson API to keep the seed simple — we don't need the full
 * validation pipeline; we just need a parseLessonFile-compatible file.
 */
function seedLesson(opts: SeedOpts): string {
  const memDir = path.join(tmpdir, 'projects', opts.project, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const filePath = path.join(memDir, opts.filename);
  const created = opts.createdAt ?? 1_700_000_000_000;
  // Filename prefix is 'feedback' / 'project' / 'process' — match it from filename
  const prefix = opts.filename.split('_')[0] as 'feedback' | 'project' | 'process';
  const tier = opts.tier ? `\ntier: ${opts.tier}` : '';
  const lastFired = opts.lastFired != null ? `\nlast_fired_at_epoch: ${opts.lastFired}` : '';
  const content = `---
type: ${prefix}
created_at_epoch_ms: ${created}
telemetry:
  tools_used: [Read]
  files_touched: [src/foo.ts]
  errors_encountered: []
  user_framing_tokens: [test]
  session_arc: [test]
  duration_min: 1
  correction_count: 0${tier}${lastFired}
---

# ${prefix} body
content here
`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function insertRecall(
  pointerId: number,
  sessionId: string,
  retrievedAtEpochMs: number,
  helpful?: boolean,
): void {
  db.prepare(
    `INSERT INTO pointer_recall_log (pointer_id, session_id, retrieved_at_epoch_ms, helpful_yn, query)
     VALUES (?, ?, ?, ?, ?)`
  ).run(pointerId, sessionId, retrievedAtEpochMs, helpful === true ? 1 : null, null);
}

describe('sweepArchivePointers', () => {
  it('archives a stale pointer (no recalls in 90d, no helpful=1)', () => {
    const filePath = seedLesson({ project: 'proj-a', filename: 'feedback_stale.md', tier: 'foreground' });
    ensurePointerId(db, 'proj-a', 'feedback_stale.md', 'lesson');

    const T = 1_800_000_000_000;
    const archived = sweepArchivePointers(db, T, { basedir: tmpdir });
    expect(archived).toBe(1);
    expect(parseLessonFile(filePath)?.frontmatter.tier).toBe('background');
  });

  it('skips a pointer with a recent recall (within 90d window)', () => {
    const filePath = seedLesson({ project: 'proj-a', filename: 'feedback_fresh.md', tier: 'foreground' });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_fresh.md', 'lesson');
    const T = 1_800_000_000_000;
    insertRecall(pid, 'sess-1', T - 30 * 86_400_000);

    const archived = sweepArchivePointers(db, T, { basedir: tmpdir });
    expect(archived).toBe(0);
    expect(parseLessonFile(filePath)?.frontmatter.tier).toBe('foreground');
  });

  it('skips any pointer with helpful_yn=1, regardless of age', () => {
    const filePath = seedLesson({ project: 'proj-a', filename: 'feedback_helpful.md', tier: 'foreground' });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_helpful.md', 'lesson');
    const T = 1_800_000_000_000;
    insertRecall(pid, 'sess-1', T - 100 * 86_400_000, true);

    const archived = sweepArchivePointers(db, T, { basedir: tmpdir });
    expect(archived).toBe(0);
    expect(parseLessonFile(filePath)?.frontmatter.tier).toBe('foreground');
  });

  it('idempotent: already-background pointer is not re-written', () => {
    const filePath = seedLesson({ project: 'proj-a', filename: 'feedback_bg.md', tier: 'background' });
    ensurePointerId(db, 'proj-a', 'feedback_bg.md', 'lesson');

    const T = 1_800_000_000_000;
    const mtimeBefore = fs.statSync(filePath).mtimeMs;
    const archived = sweepArchivePointers(db, T, { basedir: tmpdir });
    expect(archived).toBe(0);
    expect(fs.statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });

  it('skips user_note source pointers (lesson-only sweep)', () => {
    seedLesson({ project: 'proj-a', filename: 'feedback_un.md', tier: 'foreground' });
    ensurePointerId(db, 'proj-a', 'feedback_un.md', 'user_note');

    const T = 1_800_000_000_000;
    const archived = sweepArchivePointers(db, T, { basedir: tmpdir });
    expect(archived).toBe(0);
  });

  it('resilient to missing lesson file (no throw, no count)', () => {
    ensurePointerId(db, 'proj-a', 'feedback_ghost.md', 'lesson');
    const T = 1_800_000_000_000;
    expect(() => sweepArchivePointers(db, T, { basedir: tmpdir })).not.toThrow();
  });

  it('archives multiple stale lessons in one sweep', () => {
    const a = seedLesson({ project: 'proj-a', filename: 'feedback_a.md', tier: 'foreground' });
    const b = seedLesson({ project: 'proj-a', filename: 'feedback_b.md', tier: 'foreground' });
    const c = seedLesson({ project: 'proj-a', filename: 'feedback_c.md', tier: 'foreground' });
    ensurePointerId(db, 'proj-a', 'feedback_a.md', 'lesson');
    ensurePointerId(db, 'proj-a', 'feedback_b.md', 'lesson');
    ensurePointerId(db, 'proj-a', 'feedback_c.md', 'lesson');

    const T = 1_800_000_000_000;
    const archived = sweepArchivePointers(db, T, { basedir: tmpdir });
    expect(archived).toBe(3);
    expect(parseLessonFile(a)?.frontmatter.tier).toBe('background');
    expect(parseLessonFile(b)?.frontmatter.tier).toBe('background');
    expect(parseLessonFile(c)?.frontmatter.tier).toBe('background');
  });
});

describe('sweepPromotePointers', () => {
  it('promotes a pointer with ≥3 recalls and ≥1 helpful_yn=1', () => {
    const filePath = seedLesson({
      project: 'proj-a',
      filename: 'feedback_promote.md',
      tier: 'foreground',
      lastFired: 0,
    });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_promote.md', 'lesson');
    insertRecall(pid, 'sess-1', 1000);
    insertRecall(pid, 'sess-2', 2000);
    insertRecall(pid, 'sess-3', 3000, true);

    const T = 1_800_000_000_000;
    const promoted = sweepPromotePointers(db, T, { basedir: tmpdir });
    expect(promoted).toBe(1);
    expect(parseLessonFile(filePath)?.frontmatter.last_fired_at_epoch).toBe(T);
  });

  it('skips pointer with too few recalls (<3)', () => {
    const filePath = seedLesson({ project: 'proj-a', filename: 'feedback_few.md', lastFired: 0 });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_few.md', 'lesson');
    insertRecall(pid, 'sess-1', 1000);
    insertRecall(pid, 'sess-2', 2000, true);

    const T = 1_800_000_000_000;
    const promoted = sweepPromotePointers(db, T, { basedir: tmpdir });
    expect(promoted).toBe(0);
    expect(parseLessonFile(filePath)?.frontmatter.last_fired_at_epoch).toBe(0);
  });

  it('skips pointer with no helpful_yn=1', () => {
    const filePath = seedLesson({ project: 'proj-a', filename: 'feedback_unh.md', lastFired: 0 });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_unh.md', 'lesson');
    insertRecall(pid, 'sess-1', 1000);
    insertRecall(pid, 'sess-2', 2000);
    insertRecall(pid, 'sess-3', 3000);
    insertRecall(pid, 'sess-4', 4000);
    insertRecall(pid, 'sess-5', 5000);

    const T = 1_800_000_000_000;
    const promoted = sweepPromotePointers(db, T, { basedir: tmpdir });
    expect(promoted).toBe(0);
    expect(parseLessonFile(filePath)?.frontmatter.last_fired_at_epoch).toBe(0);
  });

  it('cooldown: skips a recently-promoted pointer (last_fired within 24h)', () => {
    const T = 1_800_000_000_000;
    const filePath = seedLesson({
      project: 'proj-a',
      filename: 'feedback_cool.md',
      lastFired: T - 12 * 60 * 60 * 1000,
    });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_cool.md', 'lesson');
    insertRecall(pid, 'sess-1', T - 5_000_000);
    insertRecall(pid, 'sess-2', T - 4_000_000);
    insertRecall(pid, 'sess-3', T - 3_000_000, true);

    const mtimeBefore = fs.statSync(filePath).mtimeMs;
    const promoted = sweepPromotePointers(db, T, { basedir: tmpdir });
    expect(promoted).toBe(0);
    expect(fs.statSync(filePath).mtimeMs).toBe(mtimeBefore);
  });

  it('cooldown: promotes after the 24h window elapses', () => {
    const T = 1_800_000_000_000;
    const filePath = seedLesson({
      project: 'proj-a',
      filename: 'feedback_after.md',
      lastFired: T - 25 * 60 * 60 * 1000,
    });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_after.md', 'lesson');
    insertRecall(pid, 'sess-1', T - 5_000_000);
    insertRecall(pid, 'sess-2', T - 4_000_000);
    insertRecall(pid, 'sess-3', T - 3_000_000, true);

    const promoted = sweepPromotePointers(db, T, { basedir: tmpdir });
    expect(promoted).toBe(1);
    expect(parseLessonFile(filePath)?.frontmatter.last_fired_at_epoch).toBe(T);
  });

  it('rehabilitation: re-promotion un-archives (background → foreground)', () => {
    const filePath = seedLesson({
      project: 'proj-a',
      filename: 'process_rehab.md',
      tier: 'background',
      lastFired: 0,
    });
    const pid = ensurePointerId(db, 'proj-a', 'process_rehab.md', 'lesson');
    insertRecall(pid, 'sess-1', 1000);
    insertRecall(pid, 'sess-2', 2000);
    insertRecall(pid, 'sess-3', 3000, true);

    const T = 1_800_000_000_000;
    const promoted = sweepPromotePointers(db, T, { basedir: tmpdir });
    expect(promoted).toBe(1);
    const parsed = parseLessonFile(filePath)!;
    expect(parsed.frontmatter.tier).toBe('foreground');
    expect(parsed.frontmatter.last_fired_at_epoch).toBe(T);
  });

  it('skips user_note source pointers', () => {
    seedLesson({ project: 'proj-a', filename: 'feedback_un2.md', lastFired: 0 });
    const pid = ensurePointerId(db, 'proj-a', 'feedback_un2.md', 'user_note');
    insertRecall(pid, 'sess-1', 1000);
    insertRecall(pid, 'sess-2', 2000);
    insertRecall(pid, 'sess-3', 3000, true);

    const T = 1_800_000_000_000;
    const promoted = sweepPromotePointers(db, T, { basedir: tmpdir });
    expect(promoted).toBe(0);
  });
});

describe('time gates', () => {
  it('shouldRunArchiveSweep returns true once any time has elapsed past initial state', () => {
    // Initial gate state is lastArchiveSweepAt = 0, so any nowEpochMs ≥ ARCHIVE_GATE_MS
    // satisfies the elapsed-time predicate.
    expect(shouldRunArchiveSweep(24 * 60 * 60 * 1000)).toBe(true);
    expect(shouldRunArchiveSweep(1_800_000_000_000)).toBe(true);
  });

  it('archive gate blocks within 24h, opens after', () => {
    const T = 1_800_000_000_000;
    markArchiveSweepRan(T);
    expect(shouldRunArchiveSweep(T + 60 * 60 * 1000)).toBe(false);
    expect(shouldRunArchiveSweep(T + 25 * 60 * 60 * 1000)).toBe(true);
  });

  it('promote gate blocks within 7d, opens after', () => {
    const T = 1_800_000_000_000;
    markPromoteSweepRan(T);
    expect(shouldRunPromoteSweep(T + 6 * 86_400_000)).toBe(false);
    expect(shouldRunPromoteSweep(T + 8 * 86_400_000)).toBe(true);
  });

  it('__resetGatesForTests returns gate state to initial', () => {
    const T = 1_800_000_000_000;
    markArchiveSweepRan(T);
    markPromoteSweepRan(T);
    __resetGatesForTests();
    expect(shouldRunArchiveSweep(T + 1)).toBe(true);
    expect(shouldRunPromoteSweep(T + 1)).toBe(true);
  });
});
