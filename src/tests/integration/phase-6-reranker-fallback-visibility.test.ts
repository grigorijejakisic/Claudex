/**
 * Phase 6 Plan 04 — Reranker hard-required: telemetry + visibility (RETR-08).
 *
 * The cross-encoder (BGE-v2-m3 on port 7439) is load-bearing infrastructure.
 * The bi-encoder (snowflake-arctic-embed2 cosine via Ollama) is a degraded
 * mode. Whenever production retrieval falls from cross-encoder to bi-encoder,
 * one row is written to `telemetry` with `event_kind='reranker_fallback'`
 * carrying the failure reason — so the count is visible to the session-start
 * assembler and to operators tailing the DB.
 *
 * This test stubs `globalThis.fetch` to drive the four failure modes and
 * the happy path, asserting that:
 *   - cross-encoder unreachable    → 1 row, reason=unreachable
 *   - cross-encoder 502            → 1 row, reason=non_2xx
 *   - cross-encoder timeout        → 1 row, reason=timeout
 *   - cross-encoder ok+empty       → 1 row, reason=empty_response
 *   - cross-encoder ok+scores      → 0 rows (happy path; no fallback)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession } from '../helpers/test-db.js';
import { createArtifact } from '../../core/artifacts.js';
import { hybridSearchAsync } from '../../core/hybrid-retrieval.js';
import {
  incrementRerankerFallbackCounter,
  readRerankerFallbackCount,
} from '../../core/telemetry-counters.js';
import { formatRerankerHealthSection } from '../../assembly/sections.js';

const originalFetch = globalThis.fetch;

function setFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

function readFallbackRows(db: ReturnType<typeof createTestDbWithSession>['db']) {
  return db.prepare(
    `SELECT session_id, event_kind, detail, adapter
       FROM telemetry
      WHERE event_kind = 'reranker_fallback'
      ORDER BY id ASC`,
  ).all() as Array<{ session_id: string; event_kind: string; detail: string; adapter: string }>;
}

function seedSomeArtifacts(
  db: ReturnType<typeof createTestDbWithSession>['db'],
  sessionId: string,
  project: string,
): void {
  // Seed enough artifacts so the cross-encoder block runs (>1 candidate).
  const summaries = [
    'Backend X 60-poll shadowban — 15-min IP ban after window',
    'Generic backoff strategies cataloged',
    'Polling cadence design notes',
    'Rate limiting middleware overview',
    'Token bucket vs leaky bucket comparison',
  ];
  for (const s of summaries) {
    createArtifact(db, sessionId, project, 'observation', null, s, s.toLowerCase(), 3);
  }
}

describe('Phase 6 reranker fallback visibility (RETR-08)', () => {
  beforeEach(() => {
    // Reset to original fetch before each test.
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('cross-encoder unreachable → 1 fallback row with reason=unreachable', async () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rr-unreach');
    seedSomeArtifacts(db, sessionId, project);

    setFetch(async (url) => {
      if (url.includes('127.0.0.1:7439')) {
        // Network failure: simulate ECONNREFUSED-style throw.
        throw new TypeError('fetch failed');
      }
      // Bi-encoder URL: return a valid empty-embedding response so the
      // bi-encoder block doesn't blow up and we end the test cleanly.
      return new Response(JSON.stringify({ embeddings: [] }), { status: 200 });
    });

    const results = await hybridSearchAsync(db, 'rate limit polls window', project, {
      limit: 5,
      sessionId,
    });
    expect(results.length).toBeGreaterThan(0);

    const rows = readFallbackRows(db);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe(sessionId);
    expect(rows[0].adapter).toBe('hybrid-retrieval');
    expect(JSON.parse(rows[0].detail).reason).toBe('unreachable');
    expect(readRerankerFallbackCount(db, 86400)).toBe(1);

    db.close();
  });

  it('cross-encoder 502 → 1 fallback row with reason=non_2xx', async () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rr-502');
    seedSomeArtifacts(db, sessionId, project);

    setFetch(async (url) => {
      if (url.includes('127.0.0.1:7439')) {
        return new Response('Bad Gateway', { status: 502 });
      }
      return new Response(JSON.stringify({ embeddings: [] }), { status: 200 });
    });

    await hybridSearchAsync(db, 'rate limit polls window', project, {
      limit: 5,
      sessionId,
    });

    const rows = readFallbackRows(db);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].detail).reason).toBe('non_2xx');

    db.close();
  });

  it('cross-encoder timeout → 1 fallback row with reason=timeout', async () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rr-timeout');
    seedSomeArtifacts(db, sessionId, project);

    setFetch(async (url) => {
      if (url.includes('127.0.0.1:7439')) {
        // Mimic the AbortSignal.timeout(3000) path — throw a DOMException-shaped
        // error with name='TimeoutError'. Node's fetch/abort plumbing produces
        // either TimeoutError or AbortError depending on runtime; the production
        // code accepts both.
        const err = new Error('aborted') as Error & { name: string };
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(JSON.stringify({ embeddings: [] }), { status: 200 });
    });

    await hybridSearchAsync(db, 'rate limit polls window', project, {
      limit: 5,
      sessionId,
    });

    const rows = readFallbackRows(db);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].detail).reason).toBe('timeout');

    db.close();
  });

  it('cross-encoder ok with empty scores → 1 fallback row with reason=empty_response', async () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rr-empty');
    seedSomeArtifacts(db, sessionId, project);

    setFetch(async (url) => {
      if (url.includes('127.0.0.1:7439')) {
        return new Response(JSON.stringify({ scores: [], indices: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ embeddings: [] }), { status: 200 });
    });

    await hybridSearchAsync(db, 'rate limit polls window', project, {
      limit: 5,
      sessionId,
    });

    const rows = readFallbackRows(db);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].detail).reason).toBe('empty_response');

    db.close();
  });

  it('cross-encoder ok with scores → no fallback row (happy path)', async () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rr-ok');
    seedSomeArtifacts(db, sessionId, project);

    setFetch(async (url) => {
      if (url.includes('127.0.0.1:7439')) {
        // Return non-empty scores so the cross-encoder branch wins (no fallback).
        // Indices 0..4 cover the 5 seeded artifacts.
        return new Response(
          JSON.stringify({ scores: [0.9, 0.6, 0.5, 0.4, 0.2], indices: [0, 1, 2, 3, 4] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ embeddings: [] }), { status: 200 });
    });

    await hybridSearchAsync(db, 'rate limit polls window', project, {
      limit: 5,
      sessionId,
    });

    expect(readFallbackRows(db).length).toBe(0);
    expect(readRerankerFallbackCount(db, 86400)).toBe(0);

    db.close();
  });

  it('formatRerankerHealthSection returns null when no fallbacks in 24h', () => {
    const { db } = createTestDbWithSession('sess-health-zero');
    expect(formatRerankerHealthSection(db)).toBeNull();
    db.close();
  });

  it('formatRerankerHealthSection emits an observational line when count > 0', () => {
    const { db, sessionId } = createTestDbWithSession('sess-health-nonzero');

    incrementRerankerFallbackCounter(db, sessionId, 'unreachable');
    incrementRerankerFallbackCounter(db, sessionId, 'timeout');
    incrementRerankerFallbackCounter(db, sessionId, 'non_2xx');

    const out = formatRerankerHealthSection(db);
    expect(out).not.toBeNull();
    expect(out).toContain('## Reranker Health');
    expect(out).toContain('3 times');
    expect(out).toContain('cross-encoder');
    expect(out).toContain('bi-encoder');
    expect(out).toContain('BGE-v2-m3');
    expect(out).toContain('port 7439');
    // Descriptive, not imperative — should NOT contain WARNING/MUST/Apply this:
    expect(out).not.toMatch(/\bWARNING\b/);
    expect(out).not.toMatch(/\bMUST\b/);
    expect(out).not.toMatch(/Apply this:/);

    db.close();
  });

  it('formatRerankerHealthSection uses singular "time" for n=1', () => {
    const { db, sessionId } = createTestDbWithSession('sess-health-one');
    incrementRerankerFallbackCounter(db, sessionId, 'unreachable');

    const out = formatRerankerHealthSection(db);
    expect(out).not.toBeNull();
    expect(out).toContain('1 time');
    expect(out).not.toContain('1 times');

    db.close();
  });

  it('falls back with sessionId="unknown-session" when caller does not pass sessionId', async () => {
    const { db, sessionId, project } = createTestDbWithSession('sess-rr-noid');
    seedSomeArtifacts(db, sessionId, project);

    setFetch(async (url) => {
      if (url.includes('127.0.0.1:7439')) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify({ embeddings: [] }), { status: 200 });
    });

    // Note: no sessionId option passed.
    await hybridSearchAsync(db, 'rate limit polls window', project, { limit: 5 });

    const rows = readFallbackRows(db);
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('unknown-session');

    db.close();
  });
});
