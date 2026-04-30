/**
 * Phase 8.5 Plan 04 — /endsession token-cost CLI tests.
 *
 * Strategy: exercise the helper functions directly (formatBlock,
 * readSessionStartCost, readUpsTurnsCost, readExplicitRetrievalCost) so
 * we don't pay subprocess overhead for unit-level coverage. The CLI's
 * main() is wired in build.ts to dist/cli/session-token-cost.cjs but is
 * out-of-scope for this test (subprocess test would also import + run
 * main on require).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  formatBlock,
  readExplicitRetrievalCost,
  readSessionStartCost,
  readUpsTurnsCost,
  type CostLine,
} from '../../cli/session-token-cost.js';
import { recordRetrieval } from '../../intelligence/retrieval-log.js';

describe('formatBlock', () => {
  it('all zeros → block with all 0 tokens and total 0 tokens', () => {
    const lines: CostLine[] = [
      { label: 'session-start', tokens: 0 },
      { label: 'UPS turns', tokens: 0 },
      { label: 'explicit retrieval', tokens: 0 },
    ];
    const out = formatBlock(lines);
    expect(out).toContain('Memory cost this session:');
    expect(out).toContain('  session-start: 0 tokens');
    expect(out).toContain('  UPS turns: 0 tokens');
    expect(out).toContain('  explicit retrieval: 0 tokens');
    expect(out).toContain('  total: 0 tokens');
    expect(out).not.toContain('(unavailable)');
  });

  it('one unavailable line → "(unavailable)" + total qualifier', () => {
    const lines: CostLine[] = [
      { label: 'session-start', tokens: null },
      { label: 'UPS turns', tokens: 100 },
      { label: 'explicit retrieval', tokens: 50, detail: '2 invocations' },
    ];
    const out = formatBlock(lines);
    expect(out).toContain('  session-start: (unavailable)');
    expect(out).toContain('  UPS turns: 100 tokens');
    expect(out).toContain('  explicit retrieval: 50 tokens (2 invocations)');
    expect(out).toContain('  total: 150 tokens (+ some unavailable)');
  });

  it('all three available → total is the sum', () => {
    const lines: CostLine[] = [
      { label: 'session-start', tokens: 320 },
      { label: 'UPS turns', tokens: 800, detail: 'avg 100/turn × 8 turns' },
      { label: 'explicit retrieval', tokens: 240, detail: '3 invocations' },
    ];
    const out = formatBlock(lines);
    expect(out).toContain('  total: 1360 tokens');
    expect(out).not.toContain('(+ some unavailable)');
  });
});

describe('readExplicitRetrievalCost', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('empty session → tokens=0, detail="0 invocations"', () => {
    const ln = readExplicitRetrievalCost(db, 'never-existed');
    expect(ln.label).toBe('explicit retrieval');
    expect(ln.tokens).toBe(0);
    expect(ln.detail).toBe('0 invocations');
  });

  it('one retrieval → tokens > 0, detail="1 invocation"', () => {
    recordRetrieval(db, {
      sessionId: 'sess-X',
      surface: 'claudex_search',
      query: 'q',
      topKResults: [],
      responseText: 'a few tokens of response payload here',
    });
    const ln = readExplicitRetrievalCost(db, 'sess-X');
    expect(ln.tokens).toBeGreaterThan(0);
    expect(ln.detail).toBe('1 invocation');
  });

  it('three retrievals → detail="3 invocations"', () => {
    for (let i = 0; i < 3; i++) {
      recordRetrieval(db, {
        sessionId: 'sess-Y',
        surface: 'claudex_search',
        query: `q${i}`,
        topKResults: [],
        responseText: `response ${i}`,
      });
    }
    const ln = readExplicitRetrievalCost(db, 'sess-Y');
    expect(ln.detail).toBe('3 invocations');
    expect(ln.tokens).toBeGreaterThan(0);
  });
});

describe('readSessionStartCost', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns null when no telemetry row exists', () => {
    const ln = readSessionStartCost(db, 'never');
    expect(ln.tokens).toBeNull();
  });

  it('reads total_tokens from injection trigger=session_start', () => {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
       VALUES (?, 'injection', ?, NULL, 'cc-hooks')`,
    ).run(
      'sess-S',
      JSON.stringify({ trigger: 'session_start', total_tokens: 423 }),
    );
    const ln = readSessionStartCost(db, 'sess-S');
    expect(ln.tokens).toBe(423);
  });
});

describe('readUpsTurnsCost', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns null when no UPS telemetry rows exist', () => {
    const ln = readUpsTurnsCost(db, 'never');
    expect(ln.tokens).toBeNull();
  });

  it('sums total_tokens across gauge/topic_shift/post_compaction triggers', () => {
    const insert = db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
       VALUES (?, 'injection', ?, NULL, 'cc-hooks')`,
    );
    insert.run('sess-U', JSON.stringify({ trigger: 'gauge', total_tokens: 100 }));
    insert.run('sess-U', JSON.stringify({ trigger: 'topic_shift', total_tokens: 200 }));
    insert.run('sess-U', JSON.stringify({ trigger: 'post_compaction', total_tokens: 300 }));
    const ln = readUpsTurnsCost(db, 'sess-U');
    expect(ln.tokens).toBe(600);
    expect(ln.detail).toBe('avg 200/turn × 3 turns');
  });

  it('ignores session_start trigger (different bucket)', () => {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, latency_ms, adapter)
       VALUES (?, 'injection', ?, NULL, 'cc-hooks')`,
    ).run(
      'sess-only-start',
      JSON.stringify({ trigger: 'session_start', total_tokens: 500 }),
    );
    const ln = readUpsTurnsCost(db, 'sess-only-start');
    expect(ln.tokens).toBeNull();
  });
});
