/**
 * Unit tests for the telemetry counter helpers (Phase 6 P5 — RETR-08).
 *
 * Covers:
 *   - incrementRerankerFallbackCounter writes one telemetry row with the
 *     expected event_kind, detail, and adapter.
 *   - readRerankerFallbackCount returns the count over the window.
 *   - Both helpers are non-throwing on a closed DB and on a pre-V20 DB
 *     (where the CHECK enum doesn't accept 'reranker_fallback').
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, createTestDbWithSession } from '../helpers/test-db.js';
import {
  incrementRerankerFallbackCounter,
  readRerankerFallbackCount,
  type RerankerFallbackReason,
} from '../../core/telemetry-counters.js';

describe('incrementRerankerFallbackCounter', () => {
  it('writes one row with event_kind=reranker_fallback and the reason in detail', () => {
    const { db, sessionId } = createTestDbWithSession();

    incrementRerankerFallbackCounter(db, sessionId, 'unreachable');

    const rows = db.prepare(
      `SELECT session_id, event_kind, detail, adapter
         FROM telemetry
        WHERE event_kind = 'reranker_fallback'`,
    ).all() as Array<{ session_id: string; event_kind: string; detail: string; adapter: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe(sessionId);
    expect(rows[0].event_kind).toBe('reranker_fallback');
    expect(rows[0].adapter).toBe('hybrid-retrieval');

    const detail = JSON.parse(rows[0].detail) as { reason: RerankerFallbackReason };
    expect(detail.reason).toBe('unreachable');

    db.close();
  });

  it('writes one row per call (no dedup; the count IS the signal)', () => {
    const { db, sessionId } = createTestDbWithSession();

    for (const reason of ['unreachable', 'non_2xx', 'timeout', 'empty_response'] as RerankerFallbackReason[]) {
      incrementRerankerFallbackCounter(db, sessionId, reason);
    }
    incrementRerankerFallbackCounter(db, sessionId, 'unreachable');

    const count = (db.prepare(
      `SELECT COUNT(*) AS n FROM telemetry WHERE event_kind = 'reranker_fallback'`,
    ).get() as { n: number }).n;
    expect(count).toBe(5);

    db.close();
  });

  it('is non-throwing on a closed DB', () => {
    const db = new Database(':memory:');
    db.close();

    expect(() => {
      incrementRerankerFallbackCounter(db, 'sess-x', 'timeout');
    }).not.toThrow();
  });

  it('is non-throwing on a pre-V20 DB (CHECK violation swallowed)', () => {
    // Bypass initializeSchema so the V20 enum extension never runs;
    // create a minimal V19-shape telemetry table where 'reranker_fallback'
    // is not in the CHECK enum.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('hook_invocation', 'error')),
        detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
        latency_ms REAL,
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        adapter TEXT DEFAULT 'unknown'
      );
    `);

    expect(() => {
      incrementRerankerFallbackCounter(db, 'sess-x', 'unreachable');
    }).not.toThrow();

    const count = (db.prepare(
      `SELECT COUNT(*) AS n FROM telemetry WHERE event_kind = 'reranker_fallback'`,
    ).get() as { n: number }).n;
    expect(count).toBe(0); // CHECK rejected the insert; counter swallowed.

    db.close();
  });
});

describe('readRerankerFallbackCount', () => {
  it('returns 0 on a fresh DB with no fallback events', () => {
    const db = createTestDb();
    expect(readRerankerFallbackCount(db, 86400)).toBe(0);
    db.close();
  });

  it('counts events in the default 24h window', () => {
    const { db, sessionId } = createTestDbWithSession();

    for (let i = 0; i < 7; i += 1) {
      incrementRerankerFallbackCounter(db, sessionId, 'timeout');
    }

    expect(readRerankerFallbackCount(db)).toBe(7);
    expect(readRerankerFallbackCount(db, 86400)).toBe(7);

    db.close();
  });

  it('respects the window argument — events outside the window are excluded', () => {
    const { db, sessionId } = createTestDbWithSession();

    // Insert one row inside the window (now) and one outside (2 hours ago).
    incrementRerankerFallbackCounter(db, sessionId, 'unreachable');
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, timestamp_epoch, adapter)
       VALUES (?, 'reranker_fallback', '{"reason":"unreachable"}', unixepoch() - 7200, 'hybrid-retrieval')`,
    ).run(sessionId);

    expect(readRerankerFallbackCount(db, 86400)).toBe(2);
    expect(readRerankerFallbackCount(db, 3600)).toBe(1); // 1 hour window excludes the 2h-old one

    db.close();
  });

  it('returns 0 on a closed DB (non-throwing fallback)', () => {
    const db = new Database(':memory:');
    db.close();
    expect(readRerankerFallbackCount(db, 86400)).toBe(0);
  });

  it('returns 0 on a DB without the telemetry table (non-throwing)', () => {
    const db = new Database(':memory:'); // No initializeSchema.
    expect(readRerankerFallbackCount(db, 86400)).toBe(0);
    db.close();
  });
});
