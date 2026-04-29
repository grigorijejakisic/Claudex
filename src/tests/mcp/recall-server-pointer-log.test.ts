/**
 * Phase 5.5 Plan 02 — claudex_recall pointer-log instrumentation tests.
 *
 * Suite A: extractLessonRef unit cases (path normalization + regex strictness).
 * Suite B: logLessonRecallIfApplicable integration cases against in-memory DB.
 *
 * The handler body itself uses the test-seam helper exported from
 * recall-server.ts; calling it directly avoids booting the MCP transport.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { extractLessonRef } from '../../angel/pointer-recall.js';
import { logLessonRecallIfApplicable } from '../../mcp/recall-server.js';

describe('extractLessonRef — Phase 5.5 lesson-path detection', () => {
  it('matches a POSIX home-style lesson path', () => {
    const r = extractLessonRef('~/.claude/projects/foo-abc/memory/feedback_check-deps.md');
    expect(r).toEqual({ project: 'foo-abc', filename: 'feedback_check-deps.md' });
  });

  it('matches a Windows backslash-separated path (after normalization)', () => {
    const r = extractLessonRef('C:\\Users\\X\\.claude\\projects\\foo-abc\\memory\\feedback_check-deps.md');
    expect(r).toEqual({ project: 'foo-abc', filename: 'feedback_check-deps.md' });
  });

  it('matches a substring path anchored on /projects/', () => {
    const r = extractLessonRef('something/projects/foo/memory/feedback_x.md');
    expect(r).toEqual({ project: 'foo', filename: 'feedback_x.md' });
  });

  it('matches all three lesson prefixes', () => {
    expect(extractLessonRef('/projects/p/memory/feedback_a.md')?.filename).toBe('feedback_a.md');
    expect(extractLessonRef('/projects/p/memory/project_b.md')?.filename).toBe('project_b.md');
    expect(extractLessonRef('/projects/p/memory/process_c.md')?.filename).toBe('process_c.md');
  });

  it('rejects a non-lesson filename in /projects/.../memory/', () => {
    const r = extractLessonRef('~/.claude/projects/foo/memory/notes.md');
    expect(r).toBeNull();
  });

  it('rejects literal-asterisk filenames (no glob expansion)', () => {
    const r = extractLessonRef('~/.claude/projects/foo/memory/feedback_*.md');
    expect(r).toBeNull();
  });

  it('rejects unrelated paths', () => {
    expect(extractLessonRef('/etc/passwd')).toBeNull();
    expect(extractLessonRef('src/foo.ts')).toBeNull();
    expect(extractLessonRef('~/.claude/projects/foo/feedback_a.md')).toBeNull();
  });

  it('rejects empty / null-ish input', () => {
    expect(extractLessonRef('')).toBeNull();
    expect(extractLessonRef(null)).toBeNull();
    expect(extractLessonRef(undefined)).toBeNull();
  });

  it('rejects a path missing the .md extension', () => {
    expect(extractLessonRef('/projects/p/memory/feedback_x')).toBeNull();
  });
});

describe('logLessonRecallIfApplicable — Phase 5.5 handler integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('writes a pointer_recall_log row on a lesson ref', () => {
    logLessonRecallIfApplicable(
      db,
      '~/.claude/projects/test-proj/memory/feedback_x.md',
      'sess-A',
    );

    const rows = db.prepare(
      `SELECT lp.project, lp.filename, lp.source, prl.session_id, prl.helpful_yn, prl.query
         FROM pointer_recall_log prl
         JOIN lesson_pointer lp ON lp.id = prl.pointer_id`
    ).all() as Array<{
      project: string;
      filename: string;
      source: string;
      session_id: string;
      helpful_yn: number | null;
      query: string | null;
    }>;

    expect(rows.length).toBe(1);
    expect(rows[0].project).toBe('test-proj');
    expect(rows[0].filename).toBe('feedback_x.md');
    expect(rows[0].source).toBe('lesson');
    expect(rows[0].session_id).toBe('sess-A');
    expect(rows[0].helpful_yn).toBeNull();
    expect(rows[0].query).toBeNull();
  });

  it('does not log when ref is non-lesson', () => {
    logLessonRecallIfApplicable(db, '/etc/passwd', 'sess-A');
    logLessonRecallIfApplicable(db, '~/.claude/projects/test-proj/memory/notes.md', 'sess-A');
    logLessonRecallIfApplicable(db, '', 'sess-A');
    logLessonRecallIfApplicable(db, null, 'sess-A');
    logLessonRecallIfApplicable(db, undefined, 'sess-A');

    const count = (db.prepare('SELECT COUNT(*) AS c FROM pointer_recall_log').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('multiple recalls of the same lesson reuse the same pointer_id', () => {
    const ref = '~/.claude/projects/proj/memory/feedback_dup.md';
    logLessonRecallIfApplicable(db, ref, 'sess-A');
    logLessonRecallIfApplicable(db, ref, 'sess-A');
    logLessonRecallIfApplicable(db, ref, 'sess-B');

    const lp = (db.prepare('SELECT COUNT(*) AS c FROM lesson_pointer').get() as { c: number }).c;
    const prl = (db.prepare('SELECT COUNT(*) AS c FROM pointer_recall_log').get() as { c: number }).c;
    expect(lp).toBe(1);
    expect(prl).toBe(3);
  });

  it('failure isolation: closed DB does not throw', () => {
    db.close();
    // Re-open a fresh DB so afterEach doesn't double-close, but pass a closed
    // handle to the helper to force a write failure path.
    const closedDb = new Database(':memory:');
    closedDb.close();

    expect(() => {
      logLessonRecallIfApplicable(closedDb, '~/.claude/projects/p/memory/feedback_x.md', 'sess-A');
    }).not.toThrow();

    db = new Database(':memory:');
    initializeSchema(db);
  });
});
