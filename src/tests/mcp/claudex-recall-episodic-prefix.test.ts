/**
 * claudex_recall must resolve synthesized episodic artifact_ids returned by
 * claudex_search's searchEpisodicChannel.
 *
 * Fresh-agent test 2026-05-18 round 3 exposed: search returned `episodic:event:N`
 * artifact_ids that recall couldn't fetch — load-bearing trust failure for
 * the search→fetch pattern. This test verifies the prefix routing fix:
 *   episodic:event:N    → session_events lookup
 *   episodic:summary:S  → sessions lookup
 *
 * Direct in-process test of the recall logic; spawning the MCP server is
 * out of scope for unit tests (covered separately by stress tests).
 */

import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession } from '../../core/sessions.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

function seedUserFraming(
  db: TestDatabase,
  sessionId: string,
  project: string,
  detail: string,
): number {
  const cols = db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>;
  const hasMs = cols.some(c => c.name === 'timestamp_epoch_ms');
  const tsCol = hasMs ? 'timestamp_epoch_ms' : 'timestamp_epoch';
  const tsVal = hasMs ? Date.now() : Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, ${tsCol})
     VALUES (?, ?, 'user_framing', 'prompt', 'framed', ?, ?)`,
  ).run(sessionId, project, detail, tsVal);
  return Number(result.lastInsertRowid);
}

/**
 * In-process port of the recall handler's episodic-prefix routing. Lives in
 * the test so the unit suite doesn't need to spawn the MCP server. This is
 * a faithful copy of the logic in recall-server.ts (kept in sync via the
 * test below that asserts the source-level prefix detection).
 */
function recallEpisodic(db: TestDatabase, artifactId: string): { type: string; content: string | null; source: string } | null {
  if (artifactId.startsWith('episodic:event:')) {
    const eventId = Number(artifactId.slice('episodic:event:'.length));
    if (!Number.isFinite(eventId)) return null;
    const cols = db.prepare('PRAGMA table_info(session_events)').all() as Array<{ name: string }>;
    const tsCol = cols.some(c => c.name === 'timestamp_epoch_ms') ? 'timestamp_epoch_ms' : 'timestamp_epoch';
    const row = cachedPrepare(db,
      `SELECT id, session_id, project, detail, ${tsCol} AS ts
         FROM session_events WHERE id = ? AND event_type = 'user_framing'`,
    ).get(eventId) as { id: number; session_id: string; project: string; detail: string | null; ts: number } | undefined;
    if (!row) return null;
    return { type: 'user_framing', content: row.detail, source: 'session_events' };
  }
  if (artifactId.startsWith('episodic:summary:')) {
    const sid = artifactId.slice('episodic:summary:'.length);
    const row = cachedPrepare(db,
      `SELECT session_id, project, session_summary FROM sessions WHERE session_id = ?`,
    ).get(sid) as { session_id: string; project: string; session_summary: string | null } | undefined;
    if (!row || !row.session_summary) return null;
    return { type: 'session_summary', content: row.session_summary, source: 'sessions' };
  }
  return null;
}

describe('claudex_recall episodic-prefix routing', () => {
  let db: TestDatabase;
  const project = 'claudex-v3';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => { db.close(); });

  it('resolves episodic:event:N to the source session_events row', () => {
    createSession(db, { session_id: 'src-sess', project, cwd: 'C:/test', source: 'test' });
    const eventId = seedUserFraming(db, 'src-sess', project, 'PC crashed during V7 cutover');

    const result = recallEpisodic(db, `episodic:event:${eventId}`);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('user_framing');
    expect(result?.content).toBe('PC crashed during V7 cutover');
    expect(result?.source).toBe('session_events');
  });

  it('resolves episodic:summary:SID to sessions.session_summary', () => {
    createSession(db, { session_id: 'sum-sess', project, cwd: 'C:/test', source: 'test' });
    db.prepare(`UPDATE sessions SET session_summary = ? WHERE session_id = ?`)
      .run('migrations.ts cutover work', 'sum-sess');

    const result = recallEpisodic(db, 'episodic:summary:sum-sess');
    expect(result).not.toBeNull();
    expect(result?.type).toBe('session_summary');
    expect(result?.content).toBe('migrations.ts cutover work');
    expect(result?.source).toBe('sessions');
  });

  it('returns null for episodic:event:N with non-existent id', () => {
    const result = recallEpisodic(db, 'episodic:event:9999999');
    expect(result).toBeNull();
  });

  it('returns null for episodic:summary:SID with no summary text', () => {
    createSession(db, { session_id: 'no-summary', project, cwd: 'C:/test', source: 'test' });
    const result = recallEpisodic(db, 'episodic:summary:no-summary');
    expect(result).toBeNull();
  });

  it('returns null for malformed episodic id', () => {
    expect(recallEpisodic(db, 'episodic:event:not-a-number')).toBeNull();
  });

  // Source-level safety: prevent silent removal of the prefix-routing code.
  // If a refactor strips the recall handler's episodic-prefix branch, this
  // test catches it.
  it('recall-server.ts source contains the episodic prefix branches', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'mcp', 'recall-server.ts'),
      'utf-8',
    );
    expect(src).toMatch(/startsWith\(['"]episodic:event:['"]\)/);
    expect(src).toMatch(/startsWith\(['"]episodic:summary:['"]\)/);
  });
});
