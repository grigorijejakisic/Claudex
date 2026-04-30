/**
 * Phase 8.5 Plan 05 — /claudex-why CLI tests.
 *
 * Strategy: exercise the format helpers directly + a small integration
 * test against the in-memory DB. Subprocess testing is out of scope —
 * format helpers carry the logic, integration is one hop away.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  formatTPlus,
  formatQuery,
  formatSurfaceCall,
  formatLine,
  formatFooter,
  HRULE,
} from '../../cli/why.js';
import {
  recordRetrieval,
  listSessionRetrievals,
} from '../../intelligence/retrieval-log.js';

describe('formatTPlus', () => {
  const start = 1_700_000_000_000;

  it('returns T+0:00 for the same instant', () => {
    expect(formatTPlus(start, start)).toBe('T+0:00');
  });

  it('returns T+0:23 after 23 seconds', () => {
    expect(formatTPlus(start + 23_000, start)).toBe('T+0:23');
  });

  it('returns T+10:05 for 605 seconds', () => {
    expect(formatTPlus(start + 605_000, start)).toBe('T+10:05');
  });

  it('crosses to NNh+ format at 100 minutes', () => {
    expect(formatTPlus(start + 100 * 60 * 1000, start)).toBe('T+01h+');
  });

  it('returns T+02h+ at 130 minutes', () => {
    expect(formatTPlus(start + 130 * 60 * 1000, start)).toBe('T+02h+');
  });

  it('clamps negative skew to T+0:00', () => {
    expect(formatTPlus(start - 1000, start)).toBe('T+0:00');
  });
});

describe('formatQuery', () => {
  it('null → "(no query)"', () => {
    expect(formatQuery(null)).toBe('(no query)');
  });

  it('empty string → "(no query)"', () => {
    expect(formatQuery('')).toBe('(no query)');
  });

  it('short query passes through', () => {
    expect(formatQuery('rate limit')).toBe('rate limit');
  });

  it('exactly 60 chars passes through unchanged', () => {
    const q60 = 'a'.repeat(60);
    expect(formatQuery(q60)).toBe(q60);
  });

  it('61 chars → first 57 + "..."', () => {
    const q61 = 'a'.repeat(61);
    const out = formatQuery(q61);
    expect(out.length).toBe(60);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('formatSurfaceCall', () => {
  it('claudex_search → claudex_search("<query>")', () => {
    expect(formatSurfaceCall('claudex_search', 'rate limit', '[]'))
      .toBe('claudex_search("rate limit")');
  });

  it('claudex_recall → claudex_recall(<query>)', () => {
    expect(formatSurfaceCall('claudex_recall', 'id:3074', '[]'))
      .toBe('claudex_recall(id:3074)');
  });

  it('pointer_surface picks the source from topK', () => {
    const tk = JSON.stringify([{ id: 1, source: 'lesson', score: 0.9 }]);
    expect(formatSurfaceCall('pointer_surface', null, tk))
      .toBe('pointer_surface(lesson)');
  });

  it('pointer_surface with empty topK → pointer_surface(pointer)', () => {
    expect(formatSurfaceCall('pointer_surface', null, '[]'))
      .toBe('pointer_surface(pointer)');
  });

  it('mcp_other with null query renders the placeholder', () => {
    expect(formatSurfaceCall('mcp_other', null, '[]'))
      .toBe('mcp_other((no query))');
  });
});

describe('formatLine', () => {
  it('renders a complete row with the expected layout', () => {
    const start = 1_700_000_000_000;
    const row = {
      id: 1,
      session_id: 'sess',
      invoked_at_epoch_ms: start + 23_000,
      surface: 'claudex_search' as const,
      query: 'rate limit',
      top_k_results: '[{"id":1,"source":"artifacts","score":0.9},{"id":2,"source":"learning","score":0.6}]',
      used_in_output: 1 as const,
      token_cost: 487,
    };
    const out = formatLine(row, start);
    expect(out).toBe('[T+0:23] claudex_search("rate limit") → 2 results, 1 used, 487 tokens');
  });

  it('singularizes "1 result"', () => {
    const start = 1_700_000_000_000;
    const row = {
      id: 1,
      session_id: 'sess',
      invoked_at_epoch_ms: start,
      surface: 'claudex_recall' as const,
      query: 'id:42',
      top_k_results: '[{"id":42,"source":"artifacts","score":1.0}]',
      used_in_output: 0 as const,
      token_cost: 100,
    };
    const out = formatLine(row, start);
    expect(out).toBe('[T+0:00] claudex_recall(id:42) → 1 result, 0 used, 100 tokens');
  });
});

describe('formatFooter', () => {
  it('3 invocations, 2 used, 888 tokens → 67%', () => {
    const out = formatFooter(3, 2, 888);
    expect(out).toContain('3 invocations · hit rate 67% · 888 tokens total');
    expect(out).toContain(HRULE);
  });

  it('1 invocation, 1 used → 100%', () => {
    const out = formatFooter(1, 1, 50);
    expect(out).toContain('1 invocation · hit rate 100% · 50 tokens total');
  });

  it('2 invocations, 0 used → 0%', () => {
    const out = formatFooter(2, 0, 0);
    expect(out).toContain('2 invocations · hit rate 0% · 0 tokens total');
  });
});

describe('integration: empty session + seeded session', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('empty session has no rows (CLI prints "No retrievals this session.")', () => {
    expect(listSessionRetrievals(db, 'never').length).toBe(0);
  });

  it('seeded session: row formats correctly via formatLine', () => {
    recordRetrieval(db, {
      sessionId: 'sess-W',
      surface: 'claudex_search',
      query: 'shadowban',
      topKResults: [{ id: 1, source: 'artifacts', score: 0.9 }],
      responseText: 'shadowban research summary',
      invokedAtEpochMs: 1_700_000_000_000,
    });
    const rows = listSessionRetrievals(db, 'sess-W');
    expect(rows.length).toBe(1);
    const out = formatLine(rows[0], rows[0].invoked_at_epoch_ms);
    expect(out).toContain('[T+0:00]');
    expect(out).toContain('claudex_search("shadowban")');
    expect(out).toContain('1 result');
  });
});
