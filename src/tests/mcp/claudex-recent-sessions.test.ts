/**
 * Phase 14-09 — claudex_recent_sessions MCP tool contract.
 *
 * The MCP tool wraps `getRecentTerminations` (already covered by
 * session-termination.test.ts) and enriches each row with `topic` from
 * `thread_state`. This test covers the enrichment shape and the
 * MCP-response JSON contract that consumers depend on.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  recordSessionTermination,
  getRecentTerminations,
} from '../../core/session-termination.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function seedSession(db: Database.Database, sessionId: string, project: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (session_id, scope, project, cwd, source, status, observation_count, created_at_epoch_ms)
     VALUES (?, 'main', ?, '/tmp', 'test', 'completed', 42, ?)`,
  ).run(sessionId, project, Date.now());
}

function seedThreadState(db: Database.Database, sessionId: string, _project: string, topic: string): void {
  // thread_state schema: session_id PK, topic, summary, key_exchanges, updated_at_epoch.
  // No project column — project belongs on sessions, not thread_state.
  db.prepare(
    `INSERT OR REPLACE INTO thread_state (session_id, topic) VALUES (?, ?)`,
  ).run(sessionId, topic);
}

// Simulate the MCP tool's enrichment logic (lifted from recall-server.ts).
function enrichWithTopic(
  db: Database.Database,
  rows: ReturnType<typeof getRecentTerminations>,
): Array<{
  session_id: string;
  project: string;
  ended_at: string;
  ended_at_epoch_ms: number;
  end_reason: string;
  last_user_directive: string | null;
  last_assistant_text: string | null;
  observation_count: number;
  topic: string | null;
}> {
  const topicStmt = db.prepare(`SELECT topic FROM thread_state WHERE session_id = ? LIMIT 1`);
  return rows.map((r) => {
    let topic: string | null = null;
    try {
      const t = topicStmt.get(r.session_id) as { topic?: string } | undefined;
      topic = t?.topic ?? null;
    } catch {
      /* thread_state may be missing on very old DBs */
    }
    return {
      session_id: r.session_id,
      project: r.project,
      ended_at: new Date(r.ended_at_epoch_ms).toISOString(),
      ended_at_epoch_ms: r.ended_at_epoch_ms,
      end_reason: r.end_reason,
      last_user_directive: r.last_user_directive,
      last_assistant_text: r.last_assistant_text,
      observation_count: r.observation_count,
      topic,
    };
  });
}

describe('claudex_recent_sessions MCP tool', () => {
  it('enriches termination rows with topic from thread_state', () => {
    const db = freshDb();
    seedSession(db, 'sess-with-topic', 'p1');
    seedThreadState(db, 'sess-with-topic', 'p1', 'fixing-the-cutover-gate');
    recordSessionTermination(db, {
      session_id: 'sess-with-topic',
      project: 'p1',
      end_reason: 'endsession',
      last_user_directive: 'good night',
    });

    const rows = getRecentTerminations(db, { limit: 10 });
    const enriched = enrichWithTopic(db, rows);

    expect(enriched.length).toBe(1);
    expect(enriched[0].session_id).toBe('sess-with-topic');
    expect(enriched[0].topic).toBe('fixing-the-cutover-gate');
    expect(enriched[0].end_reason).toBe('endsession');
    expect(enriched[0].last_user_directive).toBe('good night');
    expect(enriched[0].ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    db.close();
  });

  it('returns topic=null when thread_state row absent for the session', () => {
    const db = freshDb();
    seedSession(db, 'sess-no-topic', 'p1');
    recordSessionTermination(db, {
      session_id: 'sess-no-topic',
      project: 'p1',
      end_reason: 'crash',
    });

    const enriched = enrichWithTopic(db, getRecentTerminations(db, { limit: 10 }));
    expect(enriched.length).toBe(1);
    expect(enriched[0].topic).toBeNull();
    expect(enriched[0].end_reason).toBe('crash');
    db.close();
  });

  it('respects limit and project filter', () => {
    const db = freshDb();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      seedSession(db, 'a-' + i, 'projA');
      recordSessionTermination(db, {
        session_id: 'a-' + i,
        project: 'projA',
        end_reason: 'endsession',
        ended_at_epoch_ms: now - i * 60_000,
      });
    }
    for (let i = 0; i < 3; i++) {
      seedSession(db, 'b-' + i, 'projB');
      recordSessionTermination(db, {
        session_id: 'b-' + i,
        project: 'projB',
        end_reason: 'compact',
        ended_at_epoch_ms: now - i * 30_000,
      });
    }

    const enrichedA = enrichWithTopic(db, getRecentTerminations(db, { limit: 10, project: 'projA' }));
    expect(enrichedA.length).toBe(5);
    expect(enrichedA.every((r) => r.project === 'projA')).toBe(true);

    const enrichedLimited = enrichWithTopic(db, getRecentTerminations(db, { limit: 2 }));
    expect(enrichedLimited.length).toBe(2);
    db.close();
  });

  it('JSON-serializable response shape', () => {
    const db = freshDb();
    seedSession(db, 'sess-json', 'p1');
    recordSessionTermination(db, {
      session_id: 'sess-json',
      project: 'p1',
      end_reason: 'endsession',
      last_user_directive: 'do it',
    });

    const enriched = enrichWithTopic(db, getRecentTerminations(db, { limit: 5 }));
    const payload = { sessions: enriched, count: enriched.length };
    // Must round-trip through JSON.
    const serialized = JSON.stringify(payload, null, 2);
    const parsed = JSON.parse(serialized) as { sessions: typeof enriched; count: number };
    expect(parsed.count).toBe(1);
    expect(parsed.sessions[0].end_reason).toBe('endsession');
    db.close();
  });
});
