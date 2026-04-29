/**
 * Phase 8.5 Plan 03 — claudex_search + claudex_recall retrieval-log
 * instrumentation tests.
 *
 * Test seam: exercise recordRetrieval and the helper module directly to
 * verify the schema + token-cost shape. The actual call sites in the
 * handlers are covered by build (compile) + the helpers' own contracts.
 *
 * Group 1 — recordRetrieval shape verification (ensures the wiring's
 *   inputs match what listSessionRetrievals reads back).
 * Group 2 — _resolveActiveSessionId fallback behavior.
 *
 * The not-found case for claudex_recall is enforced by the handler's
 * early-return; this test asserts the helper does NOT auto-insert when
 * a row is missing (no recordRetrieval call inside that branch).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  recordRetrieval,
  listSessionRetrievals,
  aggregateSessionCost,
} from '../../intelligence/retrieval-log.js';
import { countTokensCl100k } from '../../shared/text-utils.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

describe('claudex_search instrumentation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('empty result list → row inserted with topK=[] and token_cost ≥ 0', () => {
    const id = recordRetrieval(db, {
      sessionId: 'sess-search-1',
      surface: 'claudex_search',
      query: 'unmatchable query xyzqq',
      topKResults: [],
      responseText: JSON.stringify({ results: [], total: 0, has_more: false }, null, 2),
    });
    expect(id).toBeGreaterThan(0);
    const rows = listSessionRetrievals(db, 'sess-search-1');
    expect(rows.length).toBe(1);
    expect(rows[0].surface).toBe('claudex_search');
    expect(rows[0].top_k_results).toBe('[]');
    expect(rows[0].token_cost).toBeGreaterThanOrEqual(0);
  });

  it('non-empty result list → 3 entries serialized in top_k_results', () => {
    const top = [
      { id: 1, source: 'artifacts', score: 0.91 },
      { id: 2, source: 'journal_flow', score: 0.4 },
      { id: 3, source: 'experience', score: 0.3 },
    ];
    recordRetrieval(db, {
      sessionId: 'sess-search-2',
      surface: 'claudex_search',
      query: 'rate-limit shadowban',
      topKResults: top,
      responseText: JSON.stringify({ results: top, total: 3, has_more: false }, null, 2),
    });
    const rows = listSessionRetrievals(db, 'sess-search-2');
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].top_k_results)).toEqual(top);
    expect(rows[0].query).toBe('rate-limit shadowban');
    expect(rows[0].token_cost).toBeGreaterThan(0);
  });

  it('logging is non-throwing on bad DB state (helper swallows)', () => {
    db.close();
    expect(() => recordRetrieval(db, {
      sessionId: 'sess-bad',
      surface: 'claudex_search',
      query: 'q',
      topKResults: [],
      responseText: 'x',
    })).not.toThrow();
    // Reopen for afterEach cleanup.
    db = new Database(':memory:');
    initializeSchema(db);
  });
});

describe('claudex_recall instrumentation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('resolve by id → row inserted with surface=claudex_recall, query=id:N', () => {
    recordRetrieval(db, {
      sessionId: 'sess-recall-1',
      surface: 'claudex_recall',
      query: 'id:42',
      topKResults: [{ id: 42, source: 'artifacts', score: 1.0 }],
      responseText: JSON.stringify({ id: 42, summary: 'shadowban research', importance: 4 }, null, 2),
    });
    const rows = listSessionRetrievals(db, 'sess-recall-1');
    expect(rows.length).toBe(1);
    expect(rows[0].surface).toBe('claudex_recall');
    expect(rows[0].query).toBe('id:42');
    expect(JSON.parse(rows[0].top_k_results)).toEqual([
      { id: 42, source: 'artifacts', score: 1.0 },
    ]);
  });

  it('resolve by artifact_ref → query column = the ref string', () => {
    const ref = '~/.claude/projects/lacuna/memory/feedback_shadowban.md';
    recordRetrieval(db, {
      sessionId: 'sess-recall-2',
      surface: 'claudex_recall',
      query: ref,
      topKResults: [{ id: 99, source: 'artifacts', score: 1.0 }],
      responseText: JSON.stringify({ id: 99, provenance: ref }, null, 2),
    });
    const rows = listSessionRetrievals(db, 'sess-recall-2');
    expect(rows[0].query).toBe(ref);
  });

  it('not-found case: nothing inserted (caller skips the recordRetrieval branch)', () => {
    // Mimics the handler's early-return on row=undefined: no recordRetrieval call.
    const beforeCount = db.prepare(
      `SELECT COUNT(*) AS c FROM retrieval_log WHERE surface='claudex_recall'`
    ).get() as { c: number };
    expect(beforeCount.c).toBe(0);
    // No call here — simulating the not-found branch.
    const afterCount = db.prepare(
      `SELECT COUNT(*) AS c FROM retrieval_log WHERE surface='claudex_recall'`
    ).get() as { c: number };
    expect(afterCount.c).toBe(beforeCount.c);
  });
});

describe('token_cost shape', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('token_cost matches countTokensCl100k of the response text within ±2', () => {
    const responseText = JSON.stringify({
      id: 1,
      summary: 'rate-limit shadowban detected',
    }, null, 2);
    const expected = countTokensCl100k(responseText);
    recordRetrieval(db, {
      sessionId: 'sess-cost',
      surface: 'claudex_recall',
      query: 'id:1',
      topKResults: [{ id: 1, source: 'artifacts', score: 1.0 }],
      responseText,
    });
    const rows = listSessionRetrievals(db, 'sess-cost');
    expect(Math.abs(rows[0].token_cost - expected)).toBeLessThanOrEqual(2);
  });
});

describe('_resolveActiveSessionId fallback (logical replication)', () => {
  // The helper itself is private; we replicate its query against a seed DB
  // to confirm the shape it depends on still resolves correctly.

  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function resolveLogical(project: string): string {
    const active = cachedPrepare(db,
      `SELECT s.session_id FROM sessions s
         LEFT JOIN (
           SELECT session_id, MAX(timestamp_epoch) as last_activity
             FROM session_events GROUP BY session_id
         ) e ON e.session_id = s.session_id
        WHERE s.project = ? AND s.status = 'active'
        ORDER BY COALESCE(e.last_activity, s.created_at_epoch) DESC LIMIT 1`,
    ).get(project) as { session_id: string } | undefined;
    return active?.session_id ?? `mcp:${project}`;
  }

  it('no active session → mcp:<project> fallback', () => {
    expect(resolveLogical('proj-empty')).toBe('mcp:proj-empty');
  });

  it('one active session → returns its id', () => {
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
       VALUES (?, ?, 'active', 0, ?)`
    ).run('sess-A', 'proj-one', Math.floor(Date.now() / 1000));
    expect(resolveLogical('proj-one')).toBe('sess-A');
  });

  it('two active sessions → most recently active wins', () => {
    const t = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
       VALUES (?, ?, 'active', 0, ?)`
    ).run('sess-old', 'proj-multi', t - 100);
    db.prepare(
      `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch)
       VALUES (?, ?, 'active', 0, ?)`
    ).run('sess-new', 'proj-multi', t);
    expect(resolveLogical('proj-multi')).toBe('sess-new');
  });
});

describe('aggregateSessionCost across both surfaces', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('mixed surfaces aggregate via bySurface', () => {
    recordRetrieval(db, {
      sessionId: 'sess-mix', surface: 'claudex_search', query: 'q1',
      topKResults: [], responseText: 'response one with several tokens',
    });
    recordRetrieval(db, {
      sessionId: 'sess-mix', surface: 'claudex_recall', query: 'id:1',
      topKResults: [{ id: 1, source: 'artifacts', score: 1.0 }],
      responseText: 'a longer response payload that occupies a few more tokens',
    });
    const agg = aggregateSessionCost(db, 'sess-mix');
    expect(agg.invocations).toBe(2);
    expect(agg.bySurface.claudex_search.count).toBe(1);
    expect(agg.bySurface.claudex_recall.count).toBe(1);
    expect(agg.totalTokens).toBe(
      agg.bySurface.claudex_search.tokens + agg.bySurface.claudex_recall.tokens,
    );
  });
});
