/**
 * Phase 13 Plan 05: shouldFireCue coverage gate + 3 new cue builder tests.
 *
 * Verifies:
 *  - shouldFireCue fires (returns true) when no highlights exist
 *  - Per-surface coverage check semantics (suppress when covered)
 *  - Pattern matching for each new cue surface (Bash command shape, Read file shape)
 *  - Master switch + per-type opt-out flag respect
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  shouldFireCue,
  buildPackageInstallCue,
  buildErrorInvestigationCue,
  buildScriptEncounterCue,
  _resetScriptEncounterCacheForTest,
} from '../../core/context-pull-cues.js';
import { upsertHighlights } from '../../intelligence/session-highlights.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, project TEXT NOT NULL,
  mental_model TEXT, open_questions TEXT, reframes TEXT,
  tools_introduced TEXT, decisions_not_made TEXT, posture_context TEXT,
  degraded INTEGER NOT NULL DEFAULT 0, degraded_reason TEXT, degraded_model TEXT,
  created_at_epoch_ms INTEGER NOT NULL, re_extracted_at_epoch_ms INTEGER,
  UNIQUE(session_id, project)
);
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT,
  event_type TEXT,
  entity TEXT,
  action TEXT,
  detail TEXT,
  timestamp_epoch INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT,
  status TEXT DEFAULT 'active',
  created_at_epoch INTEGER DEFAULT 0
);
`;

function makeDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

/**
 * Seed a sessions row. Required after Phase 13.1 Fix #4 (2026-05-15): the
 * `getLatestHighlights` query JOINs `sessions` to filter by source-of-truth
 * project, so any test seeding session_highlights must also seed a sessions
 * row for the highlight to be visible to consumers like shouldFireCue.
 */
function seedSession(db: DatabaseType, session_id: string, project: string): void {
  db.prepare(`INSERT OR IGNORE INTO sessions (session_id, project) VALUES (?, ?)`).run(session_id, project);
}

describe('shouldFireCue — coverage gate', () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = makeDb();
    _resetScriptEncounterCacheForTest();
    // Phase 13.1 Fix #4 (2026-05-15): getLatestHighlights JOINs sessions for
    // project-truth filtering. Seed the sessions rows the tests reference so
    // upsertHighlights writes are visible through the consuming surfaces.
    seedSession(db, 's1', 'p1');
    seedSession(db, 's2', 'p1');
    seedSession(db, 's3', 'p1');
  });

  it('fires when no highlights exist (no coverage possible)', () => {
    expect(shouldFireCue('script_encounter', { filePath: 'src/angel/heartbeat.ts' }, 'p1', db)).toBe(true);
  });

  it('script_encounter suppressed when file is in tools_introduced', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      tools_introduced: [{ path: 'src/angel/heartbeat.ts', purpose: 'Angel tick loop' }],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('script_encounter', { filePath: 'src/angel/heartbeat.ts' }, 'p1', db)).toBe(false);
  });

  it('script_encounter fires when file NOT in tools_introduced', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      tools_introduced: [{ path: 'other-script.ts', purpose: 'Something else' }],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('script_encounter', { filePath: 'src/angel/heartbeat.ts' }, 'p1', db)).toBe(true);
  });

  it('error_investigation suppressed when keyword in open_questions context', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      open_questions: [{ question: 'Why is the reranker failing?', context: 'reranker timeout error logs investigated' }],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('error_investigation', { errorKeyword: 'timeout' }, 'p1', db)).toBe(false);
  });

  it('error_investigation fires when keyword not in open_questions', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      open_questions: [{ question: 'Schema version?', context: 'migration path discussion' }],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('error_investigation', { errorKeyword: 'crash' }, 'p1', db)).toBe(true);
  });

  it('package_install fires when package is in decisions_not_made (cue surfaces the rejection)', () => {
    // Rejection content is load-bearing — suppressing the cue would hide
    // the operator's prior reasoning about not installing this package.
    // The cue's job is to surface that reasoning to the agent before they
    // install it again.
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      decisions_not_made: [{ gray_area: 'Use chokidar for file watching?', why_deferred: 'Windows fragility risk' }],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('package_install', { packageName: 'chokidar' }, 'p1', db)).toBe(true);
  });

  it('package_install suppressed when package is already in tools_introduced (in active use)', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      tools_introduced: [{ path: 'src/uses-zod.ts', purpose: 'zod schema validation' }],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('package_install', { packageName: 'zod' }, 'p1', db)).toBe(false);
  });

  it('package_install fires when package not previously discussed', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      decisions_not_made: [],
      tools_introduced: [],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('package_install', { packageName: 'zod' }, 'p1', db)).toBe(true);
  });

  it('wait_for_direction suppressed when no open questions (already oriented)', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      open_questions: [],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('wait_for_direction', {}, 'p1', db)).toBe(false);
  });

  it('wait_for_direction fires when there are open questions', () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      open_questions: [{ question: 'What next?', context: 'unclear direction' }],
      created_at_epoch_ms: 1000,
    });
    expect(shouldFireCue('wait_for_direction', {}, 'p1', db)).toBe(true);
  });
});

describe('buildPackageInstallCue — pattern + content', () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = makeDb();
    _resetScriptEncounterCacheForTest();
    // Phase 13.1 Fix #4 (2026-05-15): getLatestHighlights JOINs sessions for
    // project-truth filtering. Seed the sessions rows the tests reference so
    // upsertHighlights writes are visible through the consuming surfaces.
    seedSession(db, 's1', 'p1');
    seedSession(db, 's2', 'p1');
    seedSession(db, 's3', 'p1');
  });

  it('fires on npm install <package>', async () => {
    const cue = await buildPackageInstallCue(db, 'npm install zod', 'p1');
    expect(cue).not.toBeNull();
    expect(cue).toContain('zod');
  });

  it('fires on bun add <package>', async () => {
    const cue = await buildPackageInstallCue(db, 'bun add better-sqlite3', 'p1');
    expect(cue).not.toBeNull();
    expect(cue).toContain('better-sqlite3');
  });

  it('fires on pip install <package>', async () => {
    const cue = await buildPackageInstallCue(db, 'pip install numpy', 'p1');
    expect(cue).not.toBeNull();
    expect(cue).toContain('numpy');
  });

  it('fires on uv pip install <package>', async () => {
    const cue = await buildPackageInstallCue(db, 'uv pip install requests', 'p1');
    expect(cue).not.toBeNull();
    expect(cue).toContain('requests');
  });

  it('fires on cargo add <package>', async () => {
    const cue = await buildPackageInstallCue(db, 'cargo add serde', 'p1');
    expect(cue).not.toBeNull();
    expect(cue).toContain('serde');
  });

  it('does NOT fire on npm run build', async () => {
    const cue = await buildPackageInstallCue(db, 'npm run build', 'p1');
    expect(cue).toBeNull();
  });

  it('does NOT fire on git status', async () => {
    const cue = await buildPackageInstallCue(db, 'git status', 'p1');
    expect(cue).toBeNull();
  });

  it('surfaces rejection reason when package was previously deferred', async () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      decisions_not_made: [{ gray_area: 'Use chokidar for watching?', why_deferred: 'Windows fragility' }],
      created_at_epoch_ms: 1000,
    });
    const cue = await buildPackageInstallCue(db, 'npm install chokidar', 'p1');
    expect(cue).toContain('Windows fragility');
    expect(cue).toContain('previously deferred');
  });
});

describe('buildErrorInvestigationCue — pattern + content', () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = makeDb();
    // Phase 13.1 Fix #4 (2026-05-15): seed sessions rows for the JOIN.
    seedSession(db, 's1', 'p1');
    seedSession(db, 's2', 'p1');
    seedSession(db, 's3', 'p1');
  });

  it('fires on grep error in logs', async () => {
    const cue = await buildErrorInvestigationCue(db, 'grep -r "error" logs/', 'p1');
    expect(cue).not.toBeNull();
  });

  it('fires on tail *.log', async () => {
    const cue = await buildErrorInvestigationCue(db, 'tail -f app.log', 'p1');
    expect(cue).not.toBeNull();
  });

  it('fires on bun test --verbose', async () => {
    const cue = await buildErrorInvestigationCue(db, 'bun test --verbose', 'p1');
    expect(cue).not.toBeNull();
  });

  it('fires on docker logs', async () => {
    const cue = await buildErrorInvestigationCue(db, 'docker logs container-id', 'p1');
    expect(cue).not.toBeNull();
  });

  it('does NOT fire on plain git status', async () => {
    const cue = await buildErrorInvestigationCue(db, 'git status', 'p1');
    expect(cue).toBeNull();
  });

  it('returns null when highlights already cover the error keyword (suppressed)', async () => {
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      open_questions: [{ question: 'Why does Angel crash?', context: 'reranker timeout error investigated last session' }],
      created_at_epoch_ms: 1000,
    });
    // grep matches with keyword "error" — covered → suppressed
    const cue = await buildErrorInvestigationCue(db, 'grep error reranker.log', 'p1');
    expect(cue).toBeNull();
  });

  it('surfaces related open questions when match found', async () => {
    // Command matches the grep+error-keyword pattern; keyword is "error";
    // open_questions question text contains "error" so it's pulled into the cue.
    upsertHighlights(db, {
      session_id: 's1', project: 'p1',
      open_questions: [{ question: 'Why does the reranker error out?', context: 'race condition during shutdown investigated' }],
      created_at_epoch_ms: 1000,
    });
    const cue = await buildErrorInvestigationCue(db, 'grep error reranker.log', 'p1');
    expect(cue).not.toBeNull();
    expect(cue).toContain('Why does the reranker error out?');
  });
});

describe('buildScriptEncounterCue — pattern + history threshold', () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = makeDb();
    _resetScriptEncounterCacheForTest();
    // Phase 13.1 Fix #4 (2026-05-15): getLatestHighlights JOINs sessions for
    // project-truth filtering. Seed the sessions rows the tests reference so
    // upsertHighlights writes are visible through the consuming surfaces.
    seedSession(db, 's1', 'p1');
    seedSession(db, 's2', 'p1');
    seedSession(db, 's3', 'p1');
  });

  it('does NOT fire on a README path (not a script)', async () => {
    const cue = await buildScriptEncounterCue(db, 'docs/README.md', 'p1', 'this-session');
    expect(cue).toBeNull();
  });

  it('does NOT fire when prior-session count < 3', async () => {
    // Only 2 sessions ever touched the path → threshold not met
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s1', 'p1', 'file', 'src/angel/heartbeat.ts', 'read')`);
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s2', 'p1', 'file', 'src/angel/heartbeat.ts', 'edit')`);
    const cue = await buildScriptEncounterCue(db, 'src/angel/heartbeat.ts', 'p1', 'this-session');
    expect(cue).toBeNull();
  });

  it('fires when ≥3 prior sessions touched the path', async () => {
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s1', 'p1', 'file', 'src/angel/heartbeat.ts', 'read')`);
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s2', 'p1', 'file', 'src/angel/heartbeat.ts', 'edit')`);
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s3', 'p1', 'file', 'src/angel/heartbeat.ts', 'read')`);
    const cue = await buildScriptEncounterCue(db, 'src/angel/heartbeat.ts', 'p1', 'this-session');
    expect(cue).not.toBeNull();
    expect(cue).toContain('Script Encounter');
  });

  it('dedups within a single session (second read of same file returns null)', async () => {
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s1', 'p1', 'file', 'src/angel/heartbeat.ts', 'read')`);
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s2', 'p1', 'file', 'src/angel/heartbeat.ts', 'edit')`);
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s3', 'p1', 'file', 'src/angel/heartbeat.ts', 'read')`);
    const cue1 = await buildScriptEncounterCue(db, 'src/angel/heartbeat.ts', 'p1', 'this-session');
    const cue2 = await buildScriptEncounterCue(db, 'src/angel/heartbeat.ts', 'p1', 'this-session');
    expect(cue1).not.toBeNull();
    expect(cue2).toBeNull();
  });

  it('does NOT fire when highlights already cover the file (script-encounter suppression)', async () => {
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s1', 'p1', 'file', 'src/angel/heartbeat.ts', 'read')`);
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s2', 'p1', 'file', 'src/angel/heartbeat.ts', 'edit')`);
    db.exec(`INSERT INTO session_events (session_id, project, event_type, entity, action) VALUES ('s3', 'p1', 'file', 'src/angel/heartbeat.ts', 'read')`);
    seedSession(db, 's-prior', 'p1');
    upsertHighlights(db, {
      session_id: 's-prior', project: 'p1',
      tools_introduced: [{ path: 'src/angel/heartbeat.ts', purpose: 'Angel tick loop' }],
      created_at_epoch_ms: 1000,
    });
    const cue = await buildScriptEncounterCue(db, 'src/angel/heartbeat.ts', 'p1', 'this-session');
    expect(cue).toBeNull();
  });
});
