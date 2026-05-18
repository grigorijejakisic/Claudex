/**
 * Episodic channel tests — verifies that hybrid retrieval indexes
 * `session_events.user_framing` + `sessions.session_summary` so episodic-shape
 * questions ("why did production stop?", "what happened last session?") find
 * the literal English in those tables.
 *
 * Closes the gap diagnosed in session d2237451 (2026-05-17 turn 215):
 * `claudex_search("v7 production stopped")` returned junk (top score 0.017)
 * because RRF over FTS5+vector+recency doesn't reach session_events.detail.
 */

import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import { hybridSearchSync, isEpisodicQuery } from '../../core/hybrid-retrieval.js';

function seedUserFramingEvent(
  db: TestDatabase,
  sessionId: string,
  project: string,
  detail: string,
  timestampSec: number,
): void {
  // Schema detection: V43+ test fixtures have `timestamp_epoch_ms`; older
  // (live, pre-V43) DBs still expose `timestamp_epoch`. Same channel-detect
  // approach as searchEpisodicChannel.
  const cols = db.prepare("PRAGMA table_info(session_events)").all() as Array<{ name: string }>;
  const hasMs = cols.some(c => c.name === 'timestamp_epoch_ms');
  const tsCol = hasMs ? 'timestamp_epoch_ms' : 'timestamp_epoch';
  const tsValue = hasMs ? timestampSec * 1000 : timestampSec;
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, ${tsCol})
     VALUES (?, ?, 'user_framing', 'prompt', 'framed', ?, ?)`,
  ).run(sessionId, project, detail, tsValue);
}

describe('isEpisodicQuery', () => {
  it('matches "why did production stop" shapes', () => {
    expect(isEpisodicQuery('why did production stop?')).toBe(true);
    expect(isEpisodicQuery('Why did the last session stop')).toBe(true);
    expect(isEpisodicQuery('what happened last time we tried this')).toBe(true);
    expect(isEpisodicQuery('PC crashed during the v7 cutover')).toBe(true);
    expect(isEpisodicQuery('we got cut off mid-phase')).toBe(true);
  });

  it('does not match conceptual queries', () => {
    expect(isEpisodicQuery('what is the schema for artifact_links')).toBe(false);
    expect(isEpisodicQuery('how do I implement a new MCP tool')).toBe(false);
    expect(isEpisodicQuery('best practices for SQLite migrations')).toBe(false);
  });

  it('handles empty / null-ish input safely', () => {
    expect(isEpisodicQuery('')).toBe(false);
  });
});

describe('hybridSearchSync — episodic channel', () => {
  let db: TestDatabase;
  const project = 'claudex-v3';
  const sessionId = 'd2237451-test';

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: sessionId,
      project,
      cwd: 'C:/test',
      source: 'test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('finds user_framing text via episodic channel for PC-crash question', () => {
    // The literal prompt from session d2237451 turn 0
    seedUserFramingEvent(
      db,
      sessionId,
      project,
      'Again, PC crashed, please read the entirety or the previous session, no skipping or skimming!',
      Math.floor(Date.now() / 1000),
    );

    const results = hybridSearchSync(db, 'why did the session stop, PC crashed', project);
    expect(results.length).toBeGreaterThan(0);

    const episodicHit = results.find(r => r.match_kind === 'episodic');
    expect(episodicHit).toBeDefined();
    expect(episodicHit?.content).toContain('PC crashed');
    expect(episodicHit?.artifact_type).toBe('user_framing');
    expect(typeof episodicHit?.artifact_id).toBe('string');
    expect(String(episodicHit?.artifact_id)).toMatch(/^episodic:event:\d+$/);
  });

  it('finds session_summary text via episodic channel', () => {
    // Seed a session_summary row matching the d2237451 shape
    db.prepare(
      `UPDATE sessions
         SET session_summary = 'edited migrations.ts (22x), migration-steps.ts (8x), v7 cutover production'
       WHERE session_id = ?`,
    ).run(sessionId);

    const results = hybridSearchSync(db, 'production cutover migrations', project);
    expect(results.length).toBeGreaterThan(0);

    const summaryHit = results.find(r =>
      r.match_kind === 'episodic' && String(r.artifact_id).startsWith('episodic:summary:'),
    );
    expect(summaryHit).toBeDefined();
    expect(summaryHit?.content).toContain('cutover');
    expect(summaryHit?.artifact_type).toBe('session_summary');
  });

  it('episodic results carry rrf_episodic in score_breakdown', () => {
    seedUserFramingEvent(
      db,
      sessionId,
      project,
      'why did production stop the last 2 times?',
      Math.floor(Date.now() / 1000),
    );

    const results = hybridSearchSync(db, 'why did production stop', project);
    const episodicHit = results.find(r => r.match_kind === 'episodic');
    expect(episodicHit).toBeDefined();
    expect(episodicHit?.score_breakdown?.rrf_episodic).toBeGreaterThan(0);
  });

  it('episodic-shape query boosts episodic hits above pure recency', () => {
    // Seed two user_framing events: one with matching keywords, one without
    seedUserFramingEvent(
      db,
      sessionId,
      project,
      'production stopped because cutover gate refused',
      Math.floor(Date.now() / 1000) - 3600,
    );
    seedUserFramingEvent(
      db,
      sessionId,
      project,
      'random unrelated prompt about something else entirely',
      Math.floor(Date.now() / 1000),
    );

    const results = hybridSearchSync(db, 'why did production stop', project);
    expect(results.length).toBeGreaterThan(0);

    // Matching episodic content should rank ABOVE the more-recent unrelated one
    const matchingIdx = results.findIndex(r =>
      r.match_kind === 'episodic' && String(r.content || '').includes('cutover'),
    );
    const unrelatedIdx = results.findIndex(r =>
      String(r.content || '').includes('unrelated prompt'),
    );

    expect(matchingIdx).toBeGreaterThanOrEqual(0);
    if (unrelatedIdx >= 0) {
      expect(matchingIdx).toBeLessThan(unrelatedIdx);
    }
  });

  it('does NOT confuse user_framing across projects when globalScope=false', () => {
    seedUserFramingEvent(
      db,
      sessionId,
      'other-project',
      'production stopped on other-project',
      Math.floor(Date.now() / 1000),
    );

    const results = hybridSearchSync(db, 'production stopped', project, { globalScope: false });
    const hit = results.find(r => r.match_kind === 'episodic');
    expect(hit).toBeUndefined();
  });

  it('returns empty when no episodic content matches', () => {
    seedUserFramingEvent(
      db,
      sessionId,
      project,
      'totally different content about something else',
      Math.floor(Date.now() / 1000),
    );

    const results = hybridSearchSync(db, 'why did the database migration fail', project);
    const episodicHit = results.find(r => r.match_kind === 'episodic');
    expect(episodicHit).toBeUndefined();
  });
});
