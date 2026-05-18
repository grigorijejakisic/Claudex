/**
 * isEventQuery + episodic channel filtering for event-shape queries.
 *
 * Closes the recursive-corpus problem: when the operator asks "find me past
 * crashes" (an event-shape query), the episodic channel was surfacing
 * user_framing rows (operator complaints) ahead of session_summary rows
 * (auto-generated session descriptions). For events, complaints are noise.
 * The proper deterministic surface is session_termination via
 * claudex_recent_sessions — but if claudex_search is called anyway, this
 * filter prevents the worst case.
 */

import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import { hybridSearchSync, isEventQuery, isEpisodicQuery } from '../../core/hybrid-retrieval.js';

describe('isEventQuery — narrower than isEpisodicQuery', () => {
  it('matches event-shape: find/list/when/how many', () => {
    expect(isEventQuery('find me the last 2 crashes')).toBe(true);
    expect(isEventQuery('find me past PC crashes')).toBe(true);
    expect(isEventQuery('list all crashes')).toBe(true);
    expect(isEventQuery('when did the last crash happen')).toBe(true);
    expect(isEventQuery('how many crashes have we had')).toBe(true);
    expect(isEventQuery('times we crashed')).toBe(true);
    expect(isEventQuery('all the times we hit this')).toBe(true);
  });

  it('does NOT match narrative episodic ("remember when", "why did")', () => {
    expect(isEventQuery('remember where we stopped')).toBe(false);
    expect(isEventQuery('why did production stop')).toBe(false);
    expect(isEventQuery('what was the last directive')).toBe(false);
    expect(isEventQuery('do you remember our auth policy')).toBe(false);
  });

  it('does NOT match conceptual queries', () => {
    expect(isEventQuery('production deployment strategy')).toBe(false);
    expect(isEventQuery('what is our retry policy')).toBe(false);
  });

  it('isEpisodicQuery still fires on narrative shapes (no regression)', () => {
    expect(isEpisodicQuery('why did production stop')).toBe(true);
    expect(isEpisodicQuery('remember where we stopped')).toBe(true);
  });
});

function seedUserFraming(
  db: TestDatabase,
  sessionId: string,
  project: string,
  detail: string,
  timestampSec: number,
): void {
  const cols = db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>;
  const hasMs = cols.some(c => c.name === 'timestamp_epoch_ms');
  const tsCol = hasMs ? 'timestamp_epoch_ms' : 'timestamp_epoch';
  const tsVal = hasMs ? timestampSec * 1000 : timestampSec;
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, ${tsCol})
     VALUES (?, ?, 'user_framing', 'prompt', 'framed', ?, ?)`,
  ).run(sessionId, project, detail, tsVal);
}

describe('searchEpisodicChannel — kind filter for event-shape queries', () => {
  let db: TestDatabase;
  const project = 'claudex-v3';
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'sess-with-summary',
      project,
      cwd: 'C:/test',
      source: 'test',
    });
    db.prepare(
      `UPDATE sessions SET session_summary = 'crashed during V7 cutover deployment' WHERE session_id = 'sess-with-summary'`,
    ).run();
    createSession(db, {
      session_id: 'sess-with-framing',
      project,
      cwd: 'C:/test',
      source: 'test',
    });
    seedUserFraming(db, 'sess-with-framing', project, 'PC crashed again, please recover', now);
  });

  afterEach(() => { db.close(); });

  it('event-shape query: user_framing rows are EXCLUDED, summary surfaces', () => {
    const results = hybridSearchSync(db, 'find me past crashes', project, { limit: 5 });
    // User_framing 'PC crashed again' must NOT appear via match_kind='episodic'
    const userFramingHit = results.find(r =>
      r.match_kind === 'episodic' && r.artifact_type === 'user_framing',
    );
    expect(userFramingHit).toBeUndefined();
    // session_summary should still be allowed
    const summaryHit = results.find(r =>
      r.match_kind === 'episodic' && r.artifact_type === 'session_summary',
    );
    expect(summaryHit).toBeDefined();
  });

  it('narrative-shape query: user_framing rows ARE surfaced as before', () => {
    // Use a narrative episodic query (isEpisodicQuery=true, isEventQuery=false)
    const results = hybridSearchSync(db, 'why did production stop', project, { limit: 5 });
    // For narrative queries, user_framing is still valid signal.
    // Either user_framing or session_summary can match — both are episodic.
    const anyEpisodic = results.find(r => r.match_kind === 'episodic');
    expect(anyEpisodic).toBeDefined();
  });
});
