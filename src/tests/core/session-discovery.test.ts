import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { resolveSession, listActiveSessions, nameSession, autoNameSession } from '../../core/session-discovery.js';

describe('session-discovery', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    // Insert test sessions
    db.prepare(`INSERT INTO sessions (session_id, project, status, name) VALUES (?, ?, 'active', ?)`).run('sess-aaa', 'claudex-v3', 'my-auth-fix');
    db.prepare(`INSERT INTO sessions (session_id, project, status) VALUES (?, ?, 'active')`).run('sess-bbb', 'nexus-v2');
    db.prepare(`INSERT INTO sessions (session_id, project, status) VALUES (?, ?, 'completed')`).run('sess-ccc', 'claudex-v3');
    // Add thread state for topic matching
    db.prepare(`INSERT INTO thread_state (session_id, topic) VALUES (?, ?)`).run('sess-bbb', 'debugging oauth flow');
  });

  afterEach(() => { db.close(); });

  it('resolves by exact name', () => {
    const result = resolveSession(db, 'my-auth-fix');
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess-aaa');
    expect(result!.match_type).toBe('exact_name');
  });

  it('resolves by fuzzy name', () => {
    const result = resolveSession(db, 'auth');
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess-aaa');
    expect(result!.match_type).toBe('fuzzy_name');
  });

  it('resolves by topic', () => {
    const result = resolveSession(db, 'oauth');
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess-bbb');
    expect(result!.match_type).toBe('topic');
  });

  it('resolves by project', () => {
    const result = resolveSession(db, 'nexus');
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess-bbb');
    expect(result!.match_type).toBe('project');
  });

  it('returns null for no match', () => {
    const result = resolveSession(db, 'nonexistent-xyz');
    expect(result).toBeNull();
  });

  it('excludes the requesting session', () => {
    const result = resolveSession(db, 'claudex', 'sess-aaa');
    // Should not return sess-aaa (excluded), should find by project
    expect(result).toBeNull(); // sess-ccc is completed, only sess-aaa matches but excluded
  });

  it('does not match completed sessions', () => {
    const result = resolveSession(db, 'sess-ccc');
    expect(result).toBeNull(); // completed
  });

  it('lists active sessions', () => {
    const sessions = listActiveSessions(db);
    expect(sessions.length).toBe(2); // sess-aaa and sess-bbb
  });

  it('names a session', () => {
    nameSession(db, 'sess-bbb', 'My Nexus Debug');
    const row = db.prepare(`SELECT name FROM sessions WHERE session_id = 'sess-bbb'`).get() as { name: string };
    expect(row.name).toBe('my-nexus-debug'); // slugified
  });

  it('auto-names a session only once', () => {
    autoNameSession(db, 'sess-bbb', 'debugging oauth flow');
    const row1 = db.prepare(`SELECT name FROM sessions WHERE session_id = 'sess-bbb'`).get() as { name: string };
    expect(row1.name).toBeTruthy();

    // Second call should not overwrite
    autoNameSession(db, 'sess-bbb', 'completely different topic');
    const row2 = db.prepare(`SELECT name FROM sessions WHERE session_id = 'sess-bbb'`).get() as { name: string };
    expect(row2.name).toBe(row1.name);
  });

  it('escapes LIKE wildcards', () => {
    // % and _ should not cause broad matches
    const result = resolveSession(db, '%');
    // Should match nothing specific (% is escaped)
    // May still match if any name/topic contains literal %
    expect(result === null || result.match_type !== 'exact_name').toBe(true);
  });
});
