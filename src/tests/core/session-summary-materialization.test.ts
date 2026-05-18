/**
 * session_summary write-time materialization — V17 artifact creation.
 *
 * Closes the "synth-row with degraded confidence" weakness: when a session's
 * session_summary is finalized, also write a kind='session_summary' V17
 * artifact so the corpus indexes it first-class (FTS5 + vector via embed
 * pipeline + recency + graph walk all work naturally), rather than relying
 * on the query-time searchEpisodicChannel synth path which carries
 * confidence=0.6.
 */

import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import { saveSessionSummary, getLastSessionSummary } from '../../core/session-events.js';
import { hybridSearchSync } from '../../core/hybrid-retrieval.js';

describe('saveSessionSummary — V17 artifact materialization', () => {
  let db: TestDatabase;
  const project = 'claudex-v3';
  const sessionId = 'sess-mat-test';

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: sessionId,
      project,
      cwd: 'C:/test',
      source: 'test',
    });
  });

  afterEach(() => { db.close(); });

  it('updates sessions.session_summary (existing contract preserved)', () => {
    saveSessionSummary(db, sessionId, 'edited migrations.ts, ran tests, topics: V43 cutover');
    expect(getLastSessionSummary(db, project)).toBe('edited migrations.ts, ran tests, topics: V43 cutover');
  });

  it('creates a V17 artifact with kind=session_summary + confidence=0.7', () => {
    saveSessionSummary(db, sessionId, 'V44 open_blockers + episodic channel + Ollama supervisor gate');

    const artifact = db.prepare(
      `SELECT id, kind, title, body, project, confidence, session_id
         FROM artifact WHERE id = ?`,
    ).get(`session_summary:${sessionId}`) as Record<string, unknown> | undefined;

    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe('session_summary');
    expect(artifact?.confidence).toBe(0.7);
    expect(artifact?.project).toBe(project);
    expect(artifact?.session_id).toBe(sessionId);
    expect(String(artifact?.body)).toContain('open_blockers');
  });

  it('artifact_id is deterministic — re-saving updates same row, no duplicates', () => {
    saveSessionSummary(db, sessionId, 'first version');
    saveSessionSummary(db, sessionId, 'second version with more content');

    const rows = db.prepare(
      `SELECT id, body FROM artifact WHERE id = ?`,
    ).all(`session_summary:${sessionId}`) as Array<{ id: string; body: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].body).toBe('second version with more content');
  });

  it('updated body becomes searchable via hybridSearchSync as a real artifact (not synth episodic)', () => {
    saveSessionSummary(db, sessionId, 'edited migrations.ts for cutover gate redesign, V43 epoch normalization');

    const results = hybridSearchSync(db, 'cutover gate redesign', project, { limit: 5 });
    // The real V17 artifact should appear (FTS5 hit on title+body)
    const realHit = results.find(r =>
      r.artifact_id === `session_summary:${sessionId}` ||
      (typeof r.summary === 'string' && r.summary.includes('migrations.ts')),
    );
    expect(realHit).toBeDefined();
    // confidence comes through as 0.7 → importance 3.5 (×5 scaling)
    expect(realHit?.confidence).toBeCloseTo(0.7, 1);
    expect(realHit?.importance).toBeCloseTo(3.5, 1);
  });

  it('no-op for empty / whitespace-only summary', () => {
    saveSessionSummary(db, sessionId, '');
    const a = db.prepare(`SELECT id FROM artifact WHERE id = ?`).get(`session_summary:${sessionId}`);
    expect(a).toBeUndefined();

    saveSessionSummary(db, sessionId, '   \n\t   ');
    const b = db.prepare(`SELECT id FROM artifact WHERE id = ?`).get(`session_summary:${sessionId}`);
    expect(b).toBeUndefined();
  });

  it('non-throwing when session row does not exist for the session_id', () => {
    // Unknown session — materialization should silently skip (no project to scope to)
    expect(() => saveSessionSummary(db, 'no-such-session', 'orphan summary')).not.toThrow();
    const a = db.prepare(`SELECT id FROM artifact WHERE id = ?`).get(`session_summary:no-such-session`);
    expect(a).toBeUndefined();
  });

  it('handles missing V17 artifact table gracefully (very old DBs)', () => {
    // Drop the V17 artifact table to simulate a pre-V17 DB. The sessions
    // UPDATE should still succeed; materialization should silently skip.
    db.exec('DROP TABLE IF EXISTS artifact');
    expect(() => saveSessionSummary(db, sessionId, 'old-DB summary')).not.toThrow();
    // sessions.session_summary still updated
    expect(getLastSessionSummary(db, project)).toBe('old-DB summary');
  });
});
