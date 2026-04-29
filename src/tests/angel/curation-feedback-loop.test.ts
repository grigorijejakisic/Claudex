/**
 * Phase 5.5 Vesna probe — curation feedback loop lifecycle simulation.
 *
 * Simulates a 30+ day timeline using explicit nowEpochMs arguments through
 * every sweep call (no real-clock waits, no vi.useFakeTimers).
 *
 * The probe demonstrates the FULL feedback loop: a productive pointer earns
 * promotion; a forgotten pointer earns archival. Six scenarios cover the
 * positive paths (promote / archive / rehabilitation) and the negative paths
 * (insufficient recalls / no helpful_yn / fresh activity within 90d).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  ensurePointerId,
  markPointersHelpful,
} from '../../angel/pointer-recall.js';
import {
  sweepArchivePointers,
  sweepPromotePointers,
  __resetGatesForTests,
} from '../../angel/curation-sweep.js';
import { parseLessonFile } from '../../angel/lesson-reader.js';

// Anchor at an arbitrary "day 0" deep in 2023 (epoch ms). The relative-day
// helper makes the simulated 30-day window readable without coupling to the
// real wall clock.
const T0 = 1_700_000_000_000;
const day = (n: number) => T0 + n * 86_400_000;

let db: Database.Database;
let basedir: string;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  basedir = fs.mkdtempSync(path.join(os.tmpdir(), 'p55-vesna-'));
  __resetGatesForTests();
});

afterEach(() => {
  db.close();
  fs.rmSync(basedir, { recursive: true, force: true });
});

interface SeedOpts {
  project: string;
  filename: string;
  tier?: 'foreground' | 'background';
  lastFired?: number;
  createdAt?: number;
}

function seedLesson(opts: SeedOpts): string {
  const memDir = path.join(basedir, 'projects', opts.project, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const filePath = path.join(memDir, opts.filename);
  const created = opts.createdAt ?? day(0);
  const prefix = opts.filename.split('_')[0] as 'feedback' | 'project' | 'process';
  const tier = opts.tier ? `\ntier: ${opts.tier}` : '';
  const lastFired = opts.lastFired != null ? `\nlast_fired_at_epoch: ${opts.lastFired}` : '';
  const content = `---
type: ${prefix}
created_at_epoch: ${created}
telemetry:
  tools_used: [Read]
  files_touched: [src/foo.ts]
  errors_encountered: []
  user_framing_tokens: [vesna]
  session_arc: [test]
  duration_min: 1
  correction_count: 0${tier}${lastFired}
---

# vesna fixture body
`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function insertRecall(
  pointerId: number,
  sessionId: string,
  retrievedAtEpochMs: number,
): void {
  db.prepare(
    `INSERT INTO pointer_recall_log (pointer_id, session_id, retrieved_at_epoch_ms, query)
     VALUES (?, ?, ?, ?)`
  ).run(pointerId, sessionId, retrievedAtEpochMs, null);
}

describe('Phase 5.5 Vesna — curation feedback loop lifecycle', () => {
  it('SC#5-A — promotes a productive pointer (4 recalls over 7 days + helpful=true)', () => {
    const pathA = seedLesson({
      project: 'proj-a',
      filename: 'feedback_use-cache.md',
      tier: 'foreground',
      lastFired: 0,
    });
    const pidA = ensurePointerId(db, 'proj-a', 'feedback_use-cache.md', 'lesson');
    insertRecall(pidA, 'sess-1', day(1));
    insertRecall(pidA, 'sess-2', day(3));
    insertRecall(pidA, 'sess-3', day(5));
    insertRecall(pidA, 'sess-4', day(7));
    markPointersHelpful(db, 'sess-4', [pidA]);

    const promoted = sweepPromotePointers(db, day(8), { basedir });
    expect(promoted).toBe(1);
    expect(parseLessonFile(pathA)?.frontmatter.last_fired_at_epoch).toBe(day(8));
  });

  it('SC#5-B — archives a never-touched pointer (0 recalls in 90d, helpful=null)', () => {
    const pathB = seedLesson({
      project: 'proj-a',
      filename: 'process_old-pattern.md',
      tier: 'foreground',
      lastFired: 0,
      createdAt: day(-91),
    });
    ensurePointerId(db, 'proj-a', 'process_old-pattern.md', 'lesson');

    const archived = sweepArchivePointers(db, day(0), { basedir });
    expect(archived).toBe(1);
    expect(parseLessonFile(pathB)?.frontmatter.tier).toBe('background');
  });

  it('SC#5-C — does not archive an active pointer (recent recall within 90d)', () => {
    const pathC = seedLesson({
      project: 'proj-a',
      filename: 'feedback_active.md',
      tier: 'foreground',
      lastFired: 0,
      createdAt: day(-100),
    });
    const pidC = ensurePointerId(db, 'proj-a', 'feedback_active.md', 'lesson');
    insertRecall(pidC, 'sess-x', day(-10));

    const archived = sweepArchivePointers(db, day(0), { basedir });
    expect(archived).toBe(0);
    expect(parseLessonFile(pathC)?.frontmatter.tier).toBe('foreground');
  });

  it('SC#5-D — does not promote an under-recalled pointer (recall_count < 3)', () => {
    const pathD = seedLesson({
      project: 'proj-a',
      filename: 'feedback_underused.md',
      tier: 'foreground',
      lastFired: 0,
    });
    const pidD = ensurePointerId(db, 'proj-a', 'feedback_underused.md', 'lesson');
    insertRecall(pidD, 'sess-1', day(1));
    insertRecall(pidD, 'sess-2', day(3));
    markPointersHelpful(db, 'sess-2', [pidD]);

    const promoted = sweepPromotePointers(db, day(8), { basedir });
    expect(promoted).toBe(0);
    expect(parseLessonFile(pathD)?.frontmatter.last_fired_at_epoch).toBe(0);
  });

  it('SC#5-E — does not promote without any helpful=1 (3 recalls, all null)', () => {
    seedLesson({
      project: 'proj-a',
      filename: 'feedback_nohelp.md',
      tier: 'foreground',
      lastFired: 0,
    });
    const pidE = ensurePointerId(db, 'proj-a', 'feedback_nohelp.md', 'lesson');
    insertRecall(pidE, 'sess-1', day(1));
    insertRecall(pidE, 'sess-2', day(3));
    insertRecall(pidE, 'sess-3', day(5));

    const promoted = sweepPromotePointers(db, day(8), { basedir });
    expect(promoted).toBe(0);
  });

  it('SC#5-F — rehabilitation: archived pointer can re-promote out of background', () => {
    const pathF = seedLesson({
      project: 'proj-a',
      filename: 'process_revived.md',
      tier: 'background',
      lastFired: 0,
      createdAt: day(-100),
    });
    const pidF = ensurePointerId(db, 'proj-a', 'process_revived.md', 'lesson');
    insertRecall(pidF, 'sess-1', day(1));
    insertRecall(pidF, 'sess-2', day(3));
    insertRecall(pidF, 'sess-3', day(5));
    markPointersHelpful(db, 'sess-3', [pidF]);

    const promoted = sweepPromotePointers(db, day(8), { basedir });
    expect(promoted).toBe(1);
    const parsed = parseLessonFile(pathF)!;
    expect(parsed.frontmatter.tier).toBe('foreground');
    expect(parsed.frontmatter.last_fired_at_epoch).toBe(day(8));
  });
});
