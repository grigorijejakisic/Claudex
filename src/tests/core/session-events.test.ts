/**
 * Tests for session events (structured event capture + summary synthesis).
 */

import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  recordEvent,
  getSessionEvents,
  synthesizeSessionSummary,
  saveSessionSummary,
  getLastSessionSummary,
  extractEventsFromToolUse,
} from '../../core/session-events.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function insertSession(db: Database.Database, sessionId: string, project: string = 'test'): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
     VALUES (?, ?, 'active', 0, ?)`
  ).run(sessionId, project, Math.floor(Date.now() / 1000));
}

describe('recordEvent + getSessionEvents', () => {
  it('records and retrieves events', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      recordEvent(db, 'sess-1', 'test', 'file_edit', 'src/foo.ts', 'modified');
      recordEvent(db, 'sess-1', 'test', 'test_run', 'vitest', 'passed');

      const events = getSessionEvents(db, 'sess-1');
      expect(events.length).toBe(2);
      expect(events[0].event_type).toBe('file_edit');
      expect(events[1].event_type).toBe('test_run');
    } finally {
      db.close();
    }
  });

  it('does not return events from other sessions', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1');
      insertSession(db, 'sess-2');
      recordEvent(db, 'sess-1', 'test', 'file_edit', 'src/a.ts', 'modified');
      recordEvent(db, 'sess-2', 'test', 'file_edit', 'src/b.ts', 'modified');

      const events = getSessionEvents(db, 'sess-1');
      expect(events.length).toBe(1);
      expect(events[0].entity).toBe('src/a.ts');
    } finally {
      db.close();
    }
  });
});

describe('synthesizeSessionSummary', () => {
  it('summarizes file edits with counts', () => {
    const events = [
      { id: 1, session_id: 's', project: 'p', event_type: 'file_edit' as const, entity: 'src/foo.ts', action: 'modified', detail: null, timestamp_epoch: 1000 },
      { id: 2, session_id: 's', project: 'p', event_type: 'file_edit' as const, entity: 'src/foo.ts', action: 'modified', detail: null, timestamp_epoch: 1001 },
      { id: 3, session_id: 's', project: 'p', event_type: 'file_edit' as const, entity: 'src/bar.ts', action: 'modified', detail: null, timestamp_epoch: 1002 },
    ];

    const summary = synthesizeSessionSummary(events);
    expect(summary).toContain('src/foo.ts (2x)');
    expect(summary).toContain('src/bar.ts');
  });

  it('summarizes test runs', () => {
    const events = [
      { id: 1, session_id: 's', project: 'p', event_type: 'test_run' as const, entity: 'vitest', action: 'passed', detail: null, timestamp_epoch: 1000 },
      { id: 2, session_id: 's', project: 'p', event_type: 'test_run' as const, entity: 'vitest', action: 'failed', detail: null, timestamp_epoch: 1001 },
    ];

    const summary = synthesizeSessionSummary(events);
    expect(summary).toContain('ran tests');
    expect(summary).toContain('1 failed');
  });

  it('returns null for empty events', () => {
    expect(synthesizeSessionSummary([])).toBeNull();
  });

  it('includes decisions', () => {
    const events = [
      { id: 1, session_id: 's', project: 'p', event_type: 'decision' as const, entity: 'architecture', action: 'decided', detail: 'Use async file I/O', timestamp_epoch: 1000 },
    ];

    const summary = synthesizeSessionSummary(events);
    expect(summary).toContain('decided');
    expect(summary).toContain('async file I/O');
  });
});

describe('saveSessionSummary + getLastSessionSummary', () => {
  it('persists and retrieves session summary', () => {
    const db = createDb();
    try {
      insertSession(db, 'sess-1', 'my-project');
      saveSessionSummary(db, 'sess-1', 'edited foo.ts, ran tests, all pass.');

      const summary = getLastSessionSummary(db, 'my-project');
      expect(summary).toBe('edited foo.ts, ran tests, all pass.');
    } finally {
      db.close();
    }
  });

  it('returns null when no summary exists', () => {
    const db = createDb();
    try {
      const summary = getLastSessionSummary(db, 'no-project');
      expect(summary).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('extractEventsFromToolUse', () => {
  it('extracts file_edit from Edit tool', () => {
    const events = extractEventsFromToolUse('Edit', { file_path: 'src/foo.ts' });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('file_edit');
    expect(events[0].entity).toBe('src/foo.ts');
  });

  it('extracts file_create from Write tool', () => {
    const events = extractEventsFromToolUse('Write', { file_path: 'src/new.ts' });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('file_create');
  });

  it('extracts test_run from Bash with test command', () => {
    const events = extractEventsFromToolUse('Bash',
      { command: 'bun run test' },
      { output: 'Tests: 100 passed' }
    );
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('test_run');
    expect(events[0].action).toBe('passed');
  });

  it('detects test failures', () => {
    const events = extractEventsFromToolUse('Bash',
      { command: 'vitest run' },
      { output: '3 failed, 97 passed' }
    );
    expect(events[0].action).toBe('failed');
  });

  it('extracts build events', () => {
    const events = extractEventsFromToolUse('Bash',
      { command: 'bun run build' },
      { output: 'Done in 28ms' }
    );
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('build');
    expect(events[0].action).toBe('success');
  });

  it('returns empty for unrecognized tools', () => {
    const events = extractEventsFromToolUse('Read', { file_path: 'src/foo.ts' });
    expect(events.length).toBe(0);
  });
});
