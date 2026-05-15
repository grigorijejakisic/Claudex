/**
 * Tests for Phase 6.5 task-pattern classifier (regex-first, abstain-allowed).
 *
 * Covers four areas:
 *   1. classifyTaskPattern: direct shape match, Jaccard fallback, files-topology
 *      rules, abstain behavior at confidence floor.
 *   2. writeTaskPattern: column shape, INSERT OR IGNORE no-op on PK conflict.
 *   3. backfillTaskPatternsBatch: bounded batch, idempotency via abstain
 *      sentinel, no-op on second run.
 *   4. lesson-writer integration: writeLessonWithTaskPattern populates the
 *      sidecar at confidence ≥ 0.85; abstains gracefully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  classifyTaskPattern,
  writeTaskPattern,
  backfillTaskPatternsBatch,
  ABSTAIN_SENTINEL,
} from '../../angel/task-pattern-classifier.js';
import { writeLessonWithTaskPattern } from '../../angel/lesson-writer.js';
import type { TelemetryHandles, ShapeHandles } from '../../angel/lesson-types.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  // Seed canonical task_shape vocabulary (Phase 4.1 substrate).
  const insert = db.prepare(
    `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES ('task_shape', ?, ?, ?)`
  );
  const now = Date.now();
  insert.run('scraping-rate-limit-investigation', now, 5);
  insert.run('schema-migration-design', now, 5);
  insert.run('auth-flow-design', now, 4);
  insert.run('design-discussion-before-commit', now, 3);
  return db;
}

function emptyHandles(over: Partial<TelemetryHandles> = {}): TelemetryHandles {
  return {
    tools_used: [],
    files_touched: [],
    errors_encountered: [],
    user_framing_tokens: [],
    session_arc: [],
    duration_min: 0,
    correction_count: 0,
    ...over,
  };
}

describe('classifyTaskPattern — direct shape match', () => {
  it('returns confidence 1.0 when shape.task_shape is in canonical vocab', () => {
    const db = makeDb();
    const handles = emptyHandles();
    const shape: ShapeHandles = { task_shape: 'scraping-rate-limit-investigation' };
    const result = classifyTaskPattern(db, handles, shape);
    expect(result.task_pattern).toBe('scraping-rate-limit-investigation');
    expect(result.confidence).toBe(1.0);
    expect(result.source).toBe('write_time');
    db.close();
  });

  it('falls through when shape.task_shape is not in canonical vocab', () => {
    const db = makeDb();
    const handles = emptyHandles();
    const shape: ShapeHandles = { task_shape: 'totally-made-up-shape' };
    const result = classifyTaskPattern(db, handles, shape);
    // Falls into Jaccard / topology stages; no signal here → abstain.
    expect(result.task_pattern).toBeNull();
    db.close();
  });
});

describe('classifyTaskPattern — Jaccard fallback', () => {
  it('matches when framing tokens have ≥0.5 Jaccard with a canonical pattern', () => {
    const db = makeDb();
    // Pattern "schema-migration-design" → tokens {schema, migration, design}
    // Framing tokens {schema, migration, design, column} → |∩|=3, |∪|=4 → 0.75
    const handles = emptyHandles({
      user_framing_tokens: ['schema', 'migration', 'design', 'column'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    expect(result.task_pattern).toBe('schema-migration-design');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.confidence).toBeLessThanOrEqual(1.0);
    db.close();
  });

  it('abstains when Jaccard < 0.5 and no topology rule matches', () => {
    const db = makeDb();
    const handles = emptyHandles({
      // Only "design" overlaps with any canonical pattern; no topology
      // regex (auth/scrape/migration) matches any of these tokens.
      user_framing_tokens: ['only', 'one', 'matching', 'word', 'here', 'is', 'design'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    // Single-token overlap → ~0.14 jaccard → abstain.
    expect(result.task_pattern).toBeNull();
    expect(result.confidence).toBe(0);
    db.close();
  });
});

describe('classifyTaskPattern — files-topology rules', () => {
  it('files containing scraper.* trigger scraping-rate-limit-investigation', () => {
    const db = makeDb();
    const handles = emptyHandles({
      files_touched: ['src/scraper.ts', 'src/utils.ts'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    expect(result.task_pattern).toBe('scraping-rate-limit-investigation');
    expect(result.confidence).toBe(0.85);
    db.close();
  });

  it('errors_encountered with 429 triggers scraping-rate-limit-investigation', () => {
    const db = makeDb();
    const handles = emptyHandles({
      errors_encountered: ['HTTP 429 Too Many Requests'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    expect(result.task_pattern).toBe('scraping-rate-limit-investigation');
    db.close();
  });

  it('files in prisma/migrations trigger schema-migration-design', () => {
    const db = makeDb();
    const handles = emptyHandles({
      files_touched: ['prisma/migrations/20260101_add_users.sql'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    expect(result.task_pattern).toBe('schema-migration-design');
    db.close();
  });

  it('files in src/auth trigger auth-flow-design', () => {
    const db = makeDb();
    const handles = emptyHandles({
      files_touched: ['src/auth/middleware.ts'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    expect(result.task_pattern).toBe('auth-flow-design');
    db.close();
  });

  it('framing token "logout" triggers auth-flow-design', () => {
    const db = makeDb();
    const handles = emptyHandles({
      user_framing_tokens: ['users', 'kicked', 'out', 'logout'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    expect(result.task_pattern).toBe('auth-flow-design');
    db.close();
  });

  it('abstains when no rule matches and no shape provided', () => {
    const db = makeDb();
    const handles = emptyHandles({
      user_framing_tokens: ['nothing', 'special', 'here'],
      files_touched: ['random.txt'],
    });
    const result = classifyTaskPattern(db, handles, undefined);
    expect(result.task_pattern).toBeNull();
    expect(result.confidence).toBe(0);
    db.close();
  });
});

describe('writeTaskPattern', () => {
  it('writes a row with correct columns', () => {
    const db = makeDb();
    writeTaskPattern(db, 100, {
      task_pattern: 'auth-flow-design',
      confidence: 0.92,
      source: 'write_time',
    });
    const row = db.prepare(
      `SELECT artifact_id, task_pattern, classifier_confidence, classifier_source
         FROM artifact_task_pattern WHERE artifact_id = 100`
    ).get() as { artifact_id: number; task_pattern: string; classifier_confidence: number; classifier_source: string };
    expect(row.artifact_id).toBe(100);
    expect(row.task_pattern).toBe('auth-flow-design');
    expect(row.classifier_confidence).toBeCloseTo(0.92, 2);
    expect(row.classifier_source).toBe('write_time');
    db.close();
  });

  it('is a no-op when result.task_pattern is null', () => {
    const db = makeDb();
    writeTaskPattern(db, 200, {
      task_pattern: null,
      confidence: 0,
      source: 'write_time',
    });
    const row = db.prepare(
      `SELECT 1 AS one FROM artifact_task_pattern WHERE artifact_id = 200`
    ).get() as { one: number } | undefined;
    expect(row).toBeUndefined();
    db.close();
  });

  it('INSERT OR IGNORE preserves the first write under PK conflict', () => {
    const db = makeDb();
    writeTaskPattern(db, 300, { task_pattern: 'auth-flow-design', confidence: 0.9, source: 'write_time' });
    expect(() => {
      writeTaskPattern(db, 300, { task_pattern: 'schema-migration-design', confidence: 0.95, source: 'write_time' });
    }).not.toThrow();
    const row = db.prepare(
      `SELECT task_pattern FROM artifact_task_pattern WHERE artifact_id = 300`
    ).get() as { task_pattern: string };
    expect(row.task_pattern).toBe('auth-flow-design');
    db.close();
  });
});

describe('backfillTaskPatternsBatch', () => {
  function seedArtifact(db: Database.Database, id: number, type: string, summary: string, content: string): void {
    db.prepare(
      `INSERT INTO sessions (session_id, scope, project, status) VALUES (?, 'project', 'p', 'active')
         ON CONFLICT(session_id) DO NOTHING`
    ).run('s-' + id);
    db.prepare(
      `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?, 3, unixepoch())`
    ).run(id, 's-' + id, 'p', type, summary, content);
  }

  it('classifies a batch of artifacts and writes results', () => {
    const db = makeDb();
    seedArtifact(db, 1, 'learning', 'rate-limit handling', 'investigation of 429 throttling on cloudflare');
    seedArtifact(db, 2, 'observation', 'random fact', 'no signal here at all');
    seedArtifact(db, 3, 'memory_file', 'auth session token', 'tracking jwt logout flow design');
    const counts = backfillTaskPatternsBatch(db, 50);
    expect(counts.classified).toBeGreaterThanOrEqual(2); // rows 1 and 3
    expect(counts.abstained).toBeGreaterThanOrEqual(1);   // row 2
    db.close();
  });

  it('writes the abstain sentinel for low-confidence rows', () => {
    const db = makeDb();
    seedArtifact(db, 10, 'learning', 'random thing', 'unrelated content with no signal');
    backfillTaskPatternsBatch(db, 10);
    const row = db.prepare(
      `SELECT task_pattern FROM artifact_task_pattern WHERE artifact_id = 10`
    ).get() as { task_pattern: string };
    expect(row.task_pattern).toBe(ABSTAIN_SENTINEL);
    db.close();
  });

  it('is idempotent — re-running on same DB does not double-process', () => {
    const db = makeDb();
    seedArtifact(db, 21, 'learning', 'auth session', 'logout flow design');
    seedArtifact(db, 22, 'observation', 'no signal', 'just text');
    const first = backfillTaskPatternsBatch(db, 50);
    const second = backfillTaskPatternsBatch(db, 50);
    expect(first.classified + first.abstained).toBeGreaterThan(0);
    expect(second.classified).toBe(0);
    expect(second.abstained).toBe(0);
    db.close();
  });

  it('respects the artifact_type whitelist (only learning/observation/memory_file/flow/milestone)', () => {
    const db = makeDb();
    seedArtifact(db, 31, 'decision', 'auth flow', 'logout session token design'); // 'decision' is NOT in the whitelist
    const counts = backfillTaskPatternsBatch(db, 50);
    expect(counts.classified).toBe(0);
    expect(counts.abstained).toBe(0);
    const row = db.prepare(`SELECT 1 FROM artifact_task_pattern WHERE artifact_id = 31`).get();
    expect(row).toBeUndefined();
    db.close();
  });

  it('handles batchSize bound correctly', () => {
    const db = makeDb();
    for (let i = 50; i < 60; i++) {
      seedArtifact(db, i, 'learning', `auth session ${i}`, `logout flow design entry ${i}`);
    }
    const counts = backfillTaskPatternsBatch(db, 5);
    expect(counts.classified).toBeLessThanOrEqual(5);
    expect(counts.classified + counts.abstained).toBeLessThanOrEqual(5);
    db.close();
  });
});

describe('writeLessonWithTaskPattern integration', () => {
  let tmpRoot: string;
  let homeBackup: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p65-lesson-test-'));
    homeBackup = process.env.HOME;
    process.env.HOME = tmpRoot;
    // os.homedir caches; force USERPROFILE on Windows too.
    process.env.USERPROFILE = tmpRoot;
  });

  afterEach(() => {
    if (homeBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeBackup;
    delete process.env.USERPROFILE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writing a lesson with shape.task_shape produces a task_pattern row', () => {
    const db = makeDb();
    const filePath = writeLessonWithTaskPattern(db, {
      project: 'test-project',
      type: 'feedback',
      slug: 'rate-limit-finding',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: emptyHandles({
          tools_used: ['Read'],
          user_framing_tokens: ['rate', 'limit', 'investigation'],
        }),
        shape: { task_shape: 'scraping-rate-limit-investigation' },
      },
      body: 'Investigated rate-limit issues on the scraper.',
    });
    expect(fs.existsSync(filePath)).toBe(true);
    const filename = path.basename(filePath);

    const pointerRow = db.prepare(
      `SELECT id FROM lesson_pointer WHERE project = ? AND filename = ? AND source = 'lesson'`
    ).get('test-project', filename) as { id: number };
    expect(pointerRow.id).toBeGreaterThan(0);

    const tpRow = db.prepare(
      `SELECT task_pattern, classifier_source FROM artifact_task_pattern WHERE artifact_id = ?`
    ).get(pointerRow.id) as { task_pattern: string; classifier_source: string };
    expect(tpRow.task_pattern).toBe('scraping-rate-limit-investigation');
    expect(tpRow.classifier_source).toBe('write_time');
    db.close();
  });

  it('lesson with abstained shape produces no task_pattern row', () => {
    const db = makeDb();
    const filePath = writeLessonWithTaskPattern(db, {
      project: 'test-project',
      type: 'feedback',
      slug: 'mystery-thing',
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: emptyHandles({
          user_framing_tokens: ['nothing', 'special'],
        }),
        // No shape, no topology hints → abstain.
      },
      body: 'A lesson with no clear pattern.',
    });
    const filename = path.basename(filePath);

    const pointerRow = db.prepare(
      `SELECT id FROM lesson_pointer WHERE project = ? AND filename = ? AND source = 'lesson'`
    ).get('test-project', filename) as { id: number };
    expect(pointerRow.id).toBeGreaterThan(0);

    const tpRow = db.prepare(
      `SELECT 1 AS one FROM artifact_task_pattern WHERE artifact_id = ?`
    ).get(pointerRow.id) as { one: number } | undefined;
    expect(tpRow).toBeUndefined();
    db.close();
  });
});
