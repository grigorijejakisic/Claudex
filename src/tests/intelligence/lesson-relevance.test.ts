/**
 * Phase 14-07j — lesson-relevance.ts tests.
 *
 * 20 tests covering:
 *  1.  computeTriggerMatch: identical strings → 1.0
 *  2.  computeTriggerMatch: zero overlap → 0.0
 *  3.  computeTriggerMatch: half overlap → ~0.5
 *  4.  computeTriggerMatch: stopwords ignored (the/a/and/of/etc.)
 *  5.  computeTriggerMatch: empty trigger → 0
 *  6.  computeTriggerMatch: empty pivot → 0
 *  7.  computeTriggerMatch: case-insensitive
 *  8.  computeLinkDistanceScore: directly linked (1 hop) → 1.0
 *  9.  computeLinkDistanceScore: two-hop → 0.5
 * 10.  computeLinkDistanceScore: three-hop → ~0.333
 * 11.  computeLinkDistanceScore: unreachable within 4 hops → 0
 * 12.  computeLinkDistanceScore: missing lesson_artifact_id → 0
 * 13.  computeLinkDistanceScore: empty pivot_artifact_ids → 0
 * 14.  computeLessonRelevance: combined formula correct (0.6 * tm + 0.4 * ld)
 * 15.  computeLessonRelevance: fallback to truncated-body when no trigger frontmatter
 * 16.  selectTopKLessons: sorts desc by combined, returns top K
 * 17.  selectTopKLessons: K capped at MAX_TOP_K (5)
 * 18.  selectTopKLessons: env var trigger weight override
 * 19.  selectTopKLessons: env var K override (within MAX_TOP_K)
 * 20.  selectTopKLessons: tie-break alphabetical by file_path
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  computeTriggerMatch,
  computeLinkDistanceScore,
  computeLessonRelevance,
  selectTopKLessons,
  DEFAULT_TRIGGER_WEIGHT,
  DEFAULT_TOP_K,
  MAX_TOP_K,
} from '../../intelligence/lesson-relevance.js';
import { writeSoftLink } from '../../core/link-writer.js';
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

function insertArtifact(db: Database.Database, id: string, project = 'proj-alpha'): string {
  db.prepare(`
    INSERT OR IGNORE INTO artifact(id, kind, title, body, created_at_epoch_ms, updated_at_epoch_ms, project)
    VALUES (?, 'learning', ?, ?, ?, ?, ?)
  `).run(id, `summary-${id}`, `body for ${id}`, Date.now(), Date.now(), project);
  return id;
}

function softLink(
  db: Database.Database,
  src: string,
  dst: string,
  type: 'references' | 'supersedes' | 'promoted_to' | 'extracted_from' = 'references',
): void {
  writeSoftLink(db, { src_artifact_id: src, dst_artifact_id: dst, type, created_by_session: 'test-session' });
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

let tmpDir: string;

function writeLessonFile(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function makeFeedbackLesson(slug: string, opts: {
  trigger?: string;
  body?: string;
} = {}): string {
  const { trigger, body = `This is the body of lesson ${slug}.` } = opts;
  const triggerLine = trigger ? `trigger: ${trigger}\n` : '';
  const content = `---\ntype: feedback\ncreated_at_epoch_ms: 1700000000000\n${triggerLine}telemetry:\n  tools_used: []\n  files_touched: []\n  errors_encountered: []\n  user_framing_tokens: []\n  session_arc: []\n  duration_min: 10\n  correction_count: 0\n---\n\n${body}\n`;
  return writeLessonFile(`feedback_${slug}.md`, content);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-relevance-'));
});

afterEach(() => {
  // Clean up temp files
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }
  // Clean up any env vars set in tests
  delete process.env.CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT;
  delete process.env.CLAUDEX_LESSON_INLINE_K;
});

// ─── computeTriggerMatch tests ────────────────────────────────────────────────

describe('computeTriggerMatch', () => {
  it('1. identical strings → 1.0', () => {
    const score = computeTriggerMatch('handoff schema design', 'handoff schema design');
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('2. zero overlap → 0.0', () => {
    const score = computeTriggerMatch('database migration rollback', 'session start pivot');
    expect(score).toBe(0);
  });

  it('3. half overlap → ~0.5 (approximately)', () => {
    // trigger: "handoff schema" (2 content words after stopword filtering)
    // pivot: "handoff session" (2 content words)
    // overlap: "handoff" = 1 word / 2 trigger words = 0.5
    const score = computeTriggerMatch('handoff schema', 'handoff session');
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('4. stopwords ignored (the/a/and/of/etc.)', () => {
    // Without stopword filtering: "the test" vs "test" → overlap=1/2=0.5
    // With stopword filtering: "test" vs "test" → overlap=1/1=1.0
    const score = computeTriggerMatch('the test', 'the test and the result');
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('5. empty trigger → 0', () => {
    expect(computeTriggerMatch('', 'some pivot text')).toBe(0);
  });

  it('6. empty pivot → 0', () => {
    expect(computeTriggerMatch('some trigger text', '')).toBe(0);
  });

  it('7. case-insensitive', () => {
    const score = computeTriggerMatch('Handoff Schema', 'handoff schema');
    expect(score).toBeCloseTo(1.0, 5);
  });
});

// ─── computeLinkDistanceScore tests ──────────────────────────────────────────

describe('computeLinkDistanceScore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  it('8. directly linked (1 hop) → 1.0', () => {
    insertArtifact(db, 'lesson-A');
    insertArtifact(db, 'pivot-X');
    softLink(db, 'lesson-A', 'pivot-X', 'references');

    const score = computeLinkDistanceScore(db, 'lesson-A', ['pivot-X']);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('9. two-hop → 0.5', () => {
    insertArtifact(db, 'lesson-A');
    insertArtifact(db, 'middle-B');
    insertArtifact(db, 'pivot-X');
    softLink(db, 'lesson-A', 'middle-B', 'references');
    softLink(db, 'middle-B', 'pivot-X', 'references');

    const score = computeLinkDistanceScore(db, 'lesson-A', ['pivot-X']);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('10. three-hop → ~0.333', () => {
    insertArtifact(db, 'lesson-A');
    insertArtifact(db, 'hop1-B');
    insertArtifact(db, 'hop2-C');
    insertArtifact(db, 'pivot-X');
    softLink(db, 'lesson-A', 'hop1-B', 'references');
    softLink(db, 'hop1-B', 'hop2-C', 'references');
    softLink(db, 'hop2-C', 'pivot-X', 'references');

    const score = computeLinkDistanceScore(db, 'lesson-A', ['pivot-X']);
    expect(score).toBeCloseTo(1 / 3, 3);
  });

  it('11. unreachable within 4 hops → 0', () => {
    insertArtifact(db, 'lesson-isolated');
    insertArtifact(db, 'pivot-X');
    // No links between them

    const score = computeLinkDistanceScore(db, 'lesson-isolated', ['pivot-X']);
    expect(score).toBe(0);
  });

  it('12. missing lesson_artifact_id → 0', () => {
    insertArtifact(db, 'pivot-X');
    const score = computeLinkDistanceScore(db, undefined, ['pivot-X']);
    expect(score).toBe(0);
  });

  it('13. empty pivot_artifact_ids → 0', () => {
    insertArtifact(db, 'lesson-A');
    const score = computeLinkDistanceScore(db, 'lesson-A', []);
    expect(score).toBe(0);
  });
});

// ─── computeLessonRelevance tests ─────────────────────────────────────────────

describe('computeLessonRelevance', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  it('14. combined formula correct (0.6 * tm + 0.4 * ld)', () => {
    // trigger: "handoff schema" → matches pivot "handoff schema pivot" → tm = 1.0
    // link distance: no links → ld = 0
    // combined = 0.6 * 1.0 + 0.4 * 0 = 0.6
    const filePath = makeFeedbackLesson('test-combined', { trigger: 'handoff schema' });

    const result = computeLessonRelevance({
      lesson_file_path: filePath,
      lesson_artifact_id: undefined,
      pivot_text: 'handoff schema pivot',
      pivot_artifact_ids: [],
      db,
    });

    expect(result.trigger_match_score).toBeCloseTo(1.0, 3);
    expect(result.link_distance_score).toBe(0);
    expect(result.combined_score).toBeCloseTo(DEFAULT_TRIGGER_WEIGHT * 1.0, 5);
  });

  it('15. fallback to truncated-body when no trigger frontmatter', () => {
    // No `trigger:` field — body starts with "handoff" which matches pivot
    const filePath = makeFeedbackLesson('no-trigger-lesson', {
      body: 'handoff is important for continuity across sessions.',
    });

    const result = computeLessonRelevance({
      lesson_file_path: filePath,
      lesson_artifact_id: undefined,
      pivot_text: 'handoff continuity',
      pivot_artifact_ids: [],
      db,
    });

    // trigger_text should be the body fallback (non-null)
    expect(result.trigger_text).not.toBeNull();
    // trigger matches since "handoff" and "continuity" appear in body
    expect(result.trigger_match_score).toBeGreaterThan(0);
    expect(result.combined_score).toBeGreaterThan(0);
  });
});

// ─── selectTopKLessons tests ──────────────────────────────────────────────────

describe('selectTopKLessons', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  it('16. sorts desc by combined, returns top K', () => {
    const file1 = makeFeedbackLesson('lesson-high', { trigger: 'handoff schema design session' });
    const file2 = makeFeedbackLesson('lesson-mid', { trigger: 'handoff session' });
    const file3 = makeFeedbackLesson('lesson-low', { trigger: 'database migration rollback' });

    const results = selectTopKLessons({
      lessons: [
        { file_path: file1 },
        { file_path: file2 },
        { file_path: file3 },
      ],
      pivot_text: 'handoff schema session design',
      pivot_artifact_ids: [],
      db,
      k: 2,
    });

    expect(results).toHaveLength(2);
    // file1 should rank first (more trigger words match)
    expect(results[0].lesson_file_path).toBe(file1);
    // Combined scores should be in descending order
    expect(results[0].combined_score).toBeGreaterThanOrEqual(results[1].combined_score);
  });

  it('17. K capped at MAX_TOP_K (5)', () => {
    // Create 8 lesson files
    const files = Array.from({ length: 8 }, (_, i) =>
      makeFeedbackLesson(`lesson-${i}`, { trigger: `lesson topic ${i}` })
    );

    const results = selectTopKLessons({
      lessons: files.map(f => ({ file_path: f })),
      pivot_text: 'lesson topic',
      pivot_artifact_ids: [],
      db,
      k: 99, // Way over max
    });

    expect(results.length).toBeLessThanOrEqual(MAX_TOP_K);
  });

  it('18. env var trigger weight override', () => {
    // Set weight to 0.0 → only link distance matters (all tm-only scores = 0)
    process.env.CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT = '0.0';

    const file1 = makeFeedbackLesson('lesson-env-weight', { trigger: 'strong trigger match' });

    const results = selectTopKLessons({
      lessons: [{ file_path: file1 }],
      pivot_text: 'strong trigger match',
      pivot_artifact_ids: [],
      db,
      k: 1,
      // NOTE: params trigger_weight is NOT set; env var should take effect
    });

    // With weight=0.0 for trigger, combined = 0 * tm + 1.0 * ld = 0 (no links)
    expect(results[0].combined_score).toBe(0);
    expect(results[0].trigger_match_score).toBeGreaterThan(0); // tm still computed
  });

  it('19. env var K override (within MAX_TOP_K)', () => {
    process.env.CLAUDEX_LESSON_INLINE_K = '2';

    const files = Array.from({ length: 5 }, (_, i) =>
      makeFeedbackLesson(`lesson-envk-${i}`, { trigger: `topic ${i}` })
    );

    const results = selectTopKLessons({
      lessons: files.map(f => ({ file_path: f })),
      pivot_text: 'topic',
      pivot_artifact_ids: [],
      db,
      // k not set — should read from env var
    });

    expect(results).toHaveLength(2);
  });

  it('20. tie-break alphabetical by file_path', () => {
    // Create lessons with ZERO pivot match (trigger = "xyz nomatch term")
    // All will have combined_score = 0 → tie → alphabetical by file_path
    const fileA = makeFeedbackLesson('zzz-lesson', { trigger: 'xyz nomatch term' });
    const fileB = makeFeedbackLesson('aaa-lesson', { trigger: 'xyz nomatch term' });
    const fileC = makeFeedbackLesson('mmm-lesson', { trigger: 'xyz nomatch term' });

    const results = selectTopKLessons({
      lessons: [
        { file_path: fileA },
        { file_path: fileB },
        { file_path: fileC },
      ],
      pivot_text: 'completely different pivot text',
      pivot_artifact_ids: [],
      db,
      k: 3,
    });

    // All should have combined_score = 0 → sorted alphabetically
    for (const r of results) {
      expect(r.combined_score).toBe(0);
    }

    // Results should be in alphabetical order by file_path
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].lesson_file_path.localeCompare(results[i + 1].lesson_file_path)).toBeLessThanOrEqual(0);
    }
  });
});
