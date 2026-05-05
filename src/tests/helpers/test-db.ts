/**
 * Shared test database helpers.
 * Eliminates duplicated DB setup across test files.
 *
 * Phase 4 note: createPattern()-using tests must call allowLegacyPatternInsert(db)
 * in beforeEach() — the V28 trigger blocks INSERTs by default. See
 * .planning/reframes/2026-05-05-multi-handle-kill.md.
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createSession } from '../../core/sessions.js';

export type TestDatabase = Database.Database;

/**
 * Creates an initialized in-memory SQLite database with the full Claudex schema.
 * Equivalent to the pattern: new Database(':memory:') + initializeSchema(db).
 */
export function createTestDb(): TestDatabase {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

/**
 * Creates an initialized in-memory DB with a session already inserted.
 * Useful for tests that need a valid session_id for foreign key constraints.
 */
export function createTestDbWithSession(
  sessionId: string = 'test-session',
  project: string = 'test-project',
): { db: TestDatabase; sessionId: string; project: string } {
  const db = createTestDb();
  createSession(db, {
    session_id: sessionId,
    project,
    cwd: '/test',
    source: 'test',
  });
  return { db, sessionId, project };
}

/**
 * Creates an initialized in-memory DB with common test fixtures:
 * a session, and optionally seed data for observations/decisions/learnings.
 */
export function createTestDbWithData(opts: {
  sessionId?: string;
  project?: string;
  cwd?: string;
  source?: string;
} = {}): { db: TestDatabase; sessionId: string; project: string } {
  const sessionId = opts.sessionId ?? 'test-session';
  const project = opts.project ?? 'test-project';
  const db = createTestDb();
  createSession(db, {
    session_id: sessionId,
    project,
    cwd: opts.cwd ?? '/test',
    source: opts.source ?? 'test',
  });
  return { db, sessionId, project };
}

/**
 * Phase 4: enable legacy `experience_patterns` INSERTs for the duration of a test.
 * Camp III tests that seed via createPattern() must call this in beforeEach().
 * extraction-deleted.test.ts deliberately does NOT call this — that test
 * relies on the V28 trigger blocking would-be writes.
 */
export function allowLegacyPatternInsert(db: TestDatabase): void {
  db.exec(
    "INSERT OR REPLACE INTO temp.session_pragmas(key, value) VALUES ('allow_legacy_pattern_insert', '1')"
  );
}

/**
 * Phase 4: clear the legacy-INSERT pragma. Call in afterEach() to keep
 * test-isolation tight; if your DB connection doesn't survive across
 * tests, this is a no-op.
 */
export function blockLegacyPatternInsert(db: TestDatabase): void {
  db.exec("DELETE FROM temp.session_pragmas WHERE key='allow_legacy_pattern_insert'");
}
