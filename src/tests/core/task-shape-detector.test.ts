/**
 * Tests for Phase 6.5 task-shape detector + CLAUDE.md flag parser.
 *
 * Covers regex verb+domain detection, vocab Jaccard scoring, edge cases,
 * and the CLAUDE.md opt-out flag parser.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { detectTaskShape } from '../../core/task-shape-detector.js';
import { readCrossProjectSearchFlag } from '../../shared/claude-md-flags.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  const insert = db.prepare(
    `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES ('task_shape', ?, ?, ?)`
  );
  const now = Date.now();
  insert.run('scraping-rate-limit-investigation', now, 5);
  insert.run('schema-migration-design', now, 5);
  insert.run('auth-flow-design', now, 4);
  return db;
}

describe('detectTaskShape', () => {
  it('returns isTaskShaped=true on "investigate another backend"', () => {
    const db = makeDb();
    const result = detectTaskShape(db, 'investigate another backend for intel gathering');
    expect(result.isTaskShaped).toBe(true);
    db.close();
  });

  it('returns isTaskShaped=true on "users keep getting kicked out, can you check"', () => {
    const db = makeDb();
    // verb: 'check'; domain: 'users' (matches 'users' in DOMAIN_NOUNS).
    const result = detectTaskShape(db, 'users keep getting kicked out, can you check');
    expect(result.isTaskShaped).toBe(true);
    db.close();
  });

  it('returns isTaskShaped=false on "what is Claudex?"', () => {
    const db = makeDb();
    const result = detectTaskShape(db, 'what is Claudex?');
    expect(result.isTaskShaped).toBe(false);
    expect(result.canonicalShapeGuess).toBeNull();
    db.close();
  });

  it('returns isTaskShaped=false on "who is Grigorije?"', () => {
    const db = makeDb();
    const result = detectTaskShape(db, 'who is Grigorije?');
    expect(result.isTaskShaped).toBe(false);
    db.close();
  });

  it('returns isTaskShaped=false on empty query', () => {
    const db = makeDb();
    const result = detectTaskShape(db, '');
    expect(result.isTaskShaped).toBe(false);
    expect(result.matchScore).toBe(0);
    db.close();
  });

  it('returns isTaskShaped=false on whitespace-only query', () => {
    const db = makeDb();
    const result = detectTaskShape(db, '   \n  \t ');
    expect(result.isTaskShaped).toBe(false);
    db.close();
  });

  it('returns isTaskShaped=true with canonicalShapeGuess=null on vocab-empty DB', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    // No vocab seeded.
    const result = detectTaskShape(db, 'investigate the backend rate-limit');
    expect(result.isTaskShaped).toBe(true);
    expect(result.canonicalShapeGuess).toBeNull();
    expect(result.matchScore).toBe(0);
    db.close();
  });

  it('picks the canonical shape with the highest Jaccard score', () => {
    const db = makeDb();
    const result = detectTaskShape(db, 'design a schema migration');
    expect(result.isTaskShaped).toBe(true);
    expect(result.canonicalShapeGuess).toBe('schema-migration-design');
    expect(result.matchScore).toBeGreaterThan(0);
    db.close();
  });

  it('handles "design auth flow" → auth-flow-design canonical', () => {
    const db = makeDb();
    const result = detectTaskShape(db, 'design auth flow with token refresh');
    expect(result.isTaskShaped).toBe(true);
    expect(result.canonicalShapeGuess).toBe('auth-flow-design');
    db.close();
  });

  it('verb without domain is not task-shaped', () => {
    const db = makeDb();
    const result = detectTaskShape(db, 'investigate this');
    expect(result.isTaskShaped).toBe(false);
    db.close();
  });

  it('domain without verb is not task-shaped', () => {
    const db = makeDb();
    const result = detectTaskShape(db, 'the backend was down');
    expect(result.isTaskShaped).toBe(false);
    db.close();
  });
});

describe('readCrossProjectSearchFlag', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p65-flag-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true (default-on) when CLAUDE.md is missing', () => {
    expect(readCrossProjectSearchFlag(tmpDir)).toBe(true);
  });

  it('returns true when CLAUDE.md exists but does not contain the flag', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project rules\n\nNo flag here.\n');
    expect(readCrossProjectSearchFlag(tmpDir)).toBe(true);
  });

  it('returns false when CLAUDE.md contains claudex.cross_project_search: false', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'CLAUDE.md'),
      '# Project rules\n\nclaudex.cross_project_search: false\n',
    );
    expect(readCrossProjectSearchFlag(tmpDir)).toBe(false);
  });

  it('returns true when CLAUDE.md explicitly sets claudex.cross_project_search: true', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'CLAUDE.md'),
      '# Project rules\n\nclaudex.cross_project_search: true\n',
    );
    expect(readCrossProjectSearchFlag(tmpDir)).toBe(true);
  });

  it('case-insensitive flag value parsing', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'CLAUDE.md'),
      '# Project rules\n\nclaudex.cross_project_search: FALSE\n',
    );
    expect(readCrossProjectSearchFlag(tmpDir)).toBe(false);
  });

  it('returns true on unreadable CLAUDE.md (permission errors swallowed)', () => {
    // Don't actually create the file; resilience to fs failure modes.
    expect(readCrossProjectSearchFlag('/nonexistent/path')).toBe(true);
  });
});
