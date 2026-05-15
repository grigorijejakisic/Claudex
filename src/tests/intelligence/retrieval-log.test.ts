/**
 * Phase 8.5 — retrieval-log helper module tests.
 *
 * Covers:
 *   - recordRetrieval (insert / token cost / null query / topK JSON)
 *   - listSessionRetrievals (ordering / scoping / empty)
 *   - aggregateSessionCost (empty / mixed / multi-surface)
 *   - markRetrievalUsed (basic / empty / idempotency)
 *   - reconcileUsedInOutput (light coverage; full integration in Plan 04)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  recordRetrieval,
  listSessionRetrievals,
  aggregateSessionCost,
  markRetrievalUsed,
  reconcileUsedInOutput,
  distinctiveTokens,
} from '../../intelligence/retrieval-log.js';

describe('retrieval-log helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // recordRetrieval
  // -------------------------------------------------------------------------

  it('recordRetrieval: inserts with token_cost > 0 for non-empty responseText', () => {
    const id = recordRetrieval(db, {
      sessionId: 's1',
      surface: 'claudex_search',
      query: 'rate-limit',
      topKResults: [{ id: 1, source: 'artifacts', score: 0.9 }],
      responseText: 'A reasonably long response payload that the agent receives.',
    });
    expect(id).toBeGreaterThan(0);
    const rows = listSessionRetrievals(db, 's1');
    expect(rows.length).toBe(1);
    expect(rows[0].token_cost).toBeGreaterThan(0);
  });

  it('recordRetrieval: empty responseText yields token_cost = 0', () => {
    const id = recordRetrieval(db, {
      sessionId: 's1',
      surface: 'claudex_search',
      query: 'q',
      topKResults: [],
      responseText: '',
    });
    expect(id).toBeGreaterThan(0);
    const rows = listSessionRetrievals(db, 's1');
    expect(rows[0].token_cost).toBe(0);
  });

  it('recordRetrieval: null query is persisted as NULL', () => {
    const id = recordRetrieval(db, {
      sessionId: 's1',
      surface: 'pointer_surface',
      query: null,
      topKResults: [{ id: 7, source: 'lesson', score: 1.0 }],
      responseText: 'pointer body',
    });
    expect(id).toBeGreaterThan(0);
    const rows = listSessionRetrievals(db, 's1');
    expect(rows[0].query).toBeNull();
  });

  it('recordRetrieval: topKResults JSON round-trips intact', () => {
    const top = [
      { id: 1, source: 'artifacts', score: 0.95 },
      { id: 2, source: 'journal_flow', score: 0.4 },
    ];
    recordRetrieval(db, {
      sessionId: 's1',
      surface: 'claudex_search',
      query: 'q',
      topKResults: top,
      responseText: 'body',
    });
    const rows = listSessionRetrievals(db, 's1');
    expect(JSON.parse(rows[0].top_k_results)).toEqual(top);
  });

  // -------------------------------------------------------------------------
  // listSessionRetrievals
  // -------------------------------------------------------------------------

  it('listSessionRetrievals: empty session returns []', () => {
    expect(listSessionRetrievals(db, 'never-existed')).toEqual([]);
  });

  it('listSessionRetrievals: returns rows ascending by invoked_at', () => {
    recordRetrieval(db, {
      sessionId: 's1',
      surface: 'claudex_search',
      query: 'q1',
      topKResults: [],
      responseText: 'a',
      invokedAtEpochMs: 3000,
    });
    recordRetrieval(db, {
      sessionId: 's1',
      surface: 'claudex_search',
      query: 'q2',
      topKResults: [],
      responseText: 'b',
      invokedAtEpochMs: 1000,
    });
    recordRetrieval(db, {
      sessionId: 's1',
      surface: 'claudex_search',
      query: 'q3',
      topKResults: [],
      responseText: 'c',
      invokedAtEpochMs: 2000,
    });
    const rows = listSessionRetrievals(db, 's1');
    expect(rows.map(r => r.query)).toEqual(['q2', 'q3', 'q1']);
  });

  it('listSessionRetrievals: scoped to session_id', () => {
    recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'a',
      topKResults: [], responseText: 'a',
    });
    recordRetrieval(db, {
      sessionId: 's2', surface: 'claudex_search', query: 'b',
      topKResults: [], responseText: 'b',
    });
    expect(listSessionRetrievals(db, 's1').length).toBe(1);
    expect(listSessionRetrievals(db, 's2').length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // aggregateSessionCost
  // -------------------------------------------------------------------------

  it('aggregateSessionCost: empty session', () => {
    const agg = aggregateSessionCost(db, 'never');
    expect(agg.invocations).toBe(0);
    expect(agg.totalTokens).toBe(0);
    expect(agg.usedCount).toBe(0);
    expect(agg.hitRate).toBe(0);
    expect(agg.bySurface).toEqual({});
  });

  it('aggregateSessionCost: 2 invocations, 1 used → hitRate=0.5', () => {
    const a = recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'q1',
      topKResults: [], responseText: 'aaaa bbbb cccc dddd',
    });
    recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'q2',
      topKResults: [], responseText: 'eeee ffff gggg hhhh',
    });
    markRetrievalUsed(db, [a]);
    const agg = aggregateSessionCost(db, 's1');
    expect(agg.invocations).toBe(2);
    expect(agg.usedCount).toBe(1);
    expect(agg.hitRate).toBeCloseTo(0.5, 5);
    expect(agg.totalTokens).toBeGreaterThan(0);
  });

  it('aggregateSessionCost: bySurface aggregates across surfaces', () => {
    recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'q1',
      topKResults: [], responseText: 'response one',
    });
    recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_recall', query: 'id:1',
      topKResults: [], responseText: 'response two larger text',
    });
    recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_recall', query: 'id:2',
      topKResults: [], responseText: 'three',
    });
    const agg = aggregateSessionCost(db, 's1');
    expect(agg.bySurface.claudex_search.count).toBe(1);
    expect(agg.bySurface.claudex_recall.count).toBe(2);
    expect(agg.bySurface.claudex_search.tokens).toBeGreaterThan(0);
    expect(agg.bySurface.claudex_recall.tokens).toBeGreaterThan(
      agg.bySurface.claudex_search.tokens,
    );
  });

  // -------------------------------------------------------------------------
  // markRetrievalUsed
  // -------------------------------------------------------------------------

  it('markRetrievalUsed: marks specified rows and returns rows changed', () => {
    const a = recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'q',
      topKResults: [], responseText: 'x',
    });
    const b = recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'q',
      topKResults: [], responseText: 'y',
    });
    expect(markRetrievalUsed(db, [a, b])).toBe(2);
    const rows = listSessionRetrievals(db, 's1');
    expect(rows.every(r => r.used_in_output === 1)).toBe(true);
  });

  it('markRetrievalUsed: empty list returns 0 with no SQL', () => {
    expect(markRetrievalUsed(db, [])).toBe(0);
  });

  it('markRetrievalUsed: idempotent — second call on already-marked rows changes 0', () => {
    const a = recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'q',
      topKResults: [], responseText: 'x',
    });
    expect(markRetrievalUsed(db, [a])).toBe(1);
    expect(markRetrievalUsed(db, [a])).toBe(0);
  });

  // -------------------------------------------------------------------------
  // distinctiveTokens
  // -------------------------------------------------------------------------

  it('distinctiveTokens: filters short / stopwords', () => {
    const tokens = distinctiveTokens('The shadowban detected during a long investigation.');
    expect(tokens.has('shadowban')).toBe(true);
    expect(tokens.has('detected')).toBe(true);
    expect(tokens.has('investigation')).toBe(true);
    // 'the' / 'a' / 'long' all filtered (stopwords or under length threshold)
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('a')).toBe(false);
  });

  it('distinctiveTokens: null/empty/undefined yields empty set', () => {
    expect(distinctiveTokens(null).size).toBe(0);
    expect(distinctiveTokens(undefined).size).toBe(0);
    expect(distinctiveTokens('').size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // reconcileUsedInOutput (light coverage)
  // -------------------------------------------------------------------------

  it('reconcileUsedInOutput: empty session returns rowsUpdated=0', () => {
    const out = reconcileUsedInOutput(db, 'never-existed');
    expect(out.rowsUpdated).toBe(0);
  });

  it('reconcileUsedInOutput: session with retrievals but no transcript chunks returns 0', () => {
    recordRetrieval(db, {
      sessionId: 's1', surface: 'claudex_search', query: 'q',
      topKResults: [], responseText: 'just some retrieved content',
    });
    const out = reconcileUsedInOutput(db, 's1');
    expect(out.rowsUpdated).toBe(0);
  });

  it('reconcileUsedInOutput: marks row when overlap ≥ 2 with synthetic transcript_chunk', () => {
    // Insert a retrieval with a query that carries 2+ distinctive tokens.
    const id = recordRetrieval(db, {
      sessionId: 's1',
      surface: 'claudex_search',
      query: 'shadowban rate-limit Mozzart investigation',
      topKResults: [],
      responseText: 'shadowban rate-limit Mozzart investigation results',
      invokedAtEpochMs: 1000,
    });
    // Insert a transcript_chunk artifact that echoes 2+ tokens.
    db.prepare(
      `INSERT INTO artifact (kind, title, body, scope, status, confidence,
                             created_at_epoch, updated_at_epoch, session_id, project, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'transcript_chunk',
      'investigation segment',
      'We need to apply the shadowban rate-limit detection on Mozzart investigation runs.',
      null, 'active', null,
      2000, 2000, 's1', 'p', '{}',
    );
    const out = reconcileUsedInOutput(db, 's1');
    expect(out.rowsUpdated).toBe(1);
    const rows = listSessionRetrievals(db, 's1');
    const updated = rows.find(r => r.id === id);
    expect(updated?.used_in_output).toBe(1);
  });
});
