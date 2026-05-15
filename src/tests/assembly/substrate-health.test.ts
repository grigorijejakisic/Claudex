/**
 * Phase 13.1 Fix #5 (2026-05-15) — Substrate Health surface tests.
 *
 * Covers:
 *   - readLastHeartbeatTickEpochMs reads MAX of metadata_json.tick_started
 *   - readLastHighlightsEpochMs filters by project AND non-degraded
 *   - formatSubstrateHealthSection threshold semantics + cascade with both signals
 *   - Returns null on the happy path (cache stability)
 *   - Returns text when heartbeat is stale, when highlights are stale, or both
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  readLastHeartbeatTickEpochMs,
  readLastHighlightsEpochMs,
  readRecentPhase2Failures,
} from '../../core/substrate-health.js';
import { formatSubstrateHealthSection } from '../../assembly/sections.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS episodic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT,
  turn_number INTEGER,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT,
  provenance TEXT,
  parent_event_id INTEGER,
  content_hash TEXT,
  metadata_json TEXT,
  ts_epoch INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  mental_model TEXT,
  open_questions TEXT,
  reframes TEXT,
  tools_introduced TEXT,
  decisions_not_made TEXT,
  posture_context TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  degraded_reason TEXT,
  degraded_model TEXT,
  created_at_epoch_ms INTEGER NOT NULL,
  re_extracted_at_epoch_ms INTEGER,
  UNIQUE(session_id, project)
);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  latency_ms REAL,
  timestamp_epoch INTEGER NOT NULL DEFAULT 0,
  adapter TEXT
);
`;

function insertPhase2Failure(
  db: DatabaseType,
  opts: {
    subsystem: 'extract_directives' | 'classify_domains';
    session_id_short: string;
    reason?: 'timeout' | 'other';
    ageSeconds?: number;
  },
): void {
  const tsEpoch = Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0);
  const detail = JSON.stringify({
    subsystem: `heartbeat/phase2_${opts.subsystem}_failed`,
    session_id_short: opts.session_id_short,
    reason: opts.reason ?? 'other',
  });
  db.prepare(
    `INSERT INTO telemetry (session_id, event_kind, detail, timestamp_epoch, adapter)
     VALUES ('angel-heartbeat', 'error', ?, ?, 'angel-heartbeat')`,
  ).run(detail, tsEpoch);
}

function makeDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertHeartbeatTick(db: DatabaseType, tickEpochMs: number): void {
  db.prepare(
    `INSERT INTO episodic_events (session_id, type, source, metadata_json)
     VALUES ('angel-heartbeat', 'environmental_event', 'angel/heartbeat', ?)`,
  ).run(JSON.stringify({ tick_started_epoch_ms: tickEpochMs }));
}

function insertHighlight(
  db: DatabaseType,
  session_id: string,
  project: string,
  created_at_epoch_ms: number,
  degraded: boolean = false,
): void {
  db.prepare(
    `INSERT INTO session_highlights (session_id, project, created_at_epoch_ms, degraded)
     VALUES (?, ?, ?, ?)`,
  ).run(session_id, project, created_at_epoch_ms, degraded ? 1 : 0);
}

describe('readLastHeartbeatTickEpochMs', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('returns null when no heartbeat rows exist', () => {
    expect(readLastHeartbeatTickEpochMs(db)).toBeNull();
  });

  it('returns MAX(tick_started_epoch_ms) across heartbeat rows', () => {
    insertHeartbeatTick(db, 1_000);
    insertHeartbeatTick(db, 5_000);
    insertHeartbeatTick(db, 3_000);
    expect(readLastHeartbeatTickEpochMs(db)).toBe(5_000);
  });

  it('ignores rows from other sources', () => {
    insertHeartbeatTick(db, 1_000);
    db.prepare(
      `INSERT INTO episodic_events (session_id, type, source, metadata_json)
       VALUES ('some-session', 'environmental_event', 'cc-hooks/session-start', ?)`,
    ).run(JSON.stringify({ tick_started_epoch_ms: 9_999_999 }));
    expect(readLastHeartbeatTickEpochMs(db)).toBe(1_000);
  });

  it('returns null on missing/zero tick_started_epoch_ms', () => {
    db.prepare(
      `INSERT INTO episodic_events (session_id, type, source, metadata_json)
       VALUES ('angel-heartbeat', 'environmental_event', 'angel/heartbeat', ?)`,
    ).run(JSON.stringify({ other_field: 'x' }));
    expect(readLastHeartbeatTickEpochMs(db)).toBeNull();
  });
});

describe('readLastHighlightsEpochMs', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('returns null when no highlights exist for project', () => {
    expect(readLastHighlightsEpochMs(db, 'p1')).toBeNull();
  });

  it('returns MAX(created_at_epoch_ms) filtered by project', () => {
    insertHighlight(db, 's1', 'p1', 1_000);
    insertHighlight(db, 's2', 'p1', 5_000);
    insertHighlight(db, 's3', 'p2', 9_999); // different project
    expect(readLastHighlightsEpochMs(db, 'p1')).toBe(5_000);
    expect(readLastHighlightsEpochMs(db, 'p2')).toBe(9_999);
  });

  it('excludes degraded rows', () => {
    insertHighlight(db, 's1', 'p1', 1_000, false);
    insertHighlight(db, 's2', 'p1', 9_999, true);   // degraded — ignored
    expect(readLastHighlightsEpochMs(db, 'p1')).toBe(1_000);
  });

  it('returns null when all rows for the project are degraded', () => {
    insertHighlight(db, 's1', 'p1', 1_000, true);
    insertHighlight(db, 's2', 'p1', 5_000, true);
    expect(readLastHighlightsEpochMs(db, 'p1')).toBeNull();
  });
});

describe('formatSubstrateHealthSection', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('returns null when both signals are within threshold (happy path)', () => {
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 1_000); // 1s ago — fresh
    insertHighlight(db, 's1', 'p1', now - 1_000); // 1s ago — fresh
    expect(formatSubstrateHealthSection(db, 'p1', now)).toBeNull();
  });

  it('surfaces heartbeat-stale line when heartbeat last tick is >10min old', () => {
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 11 * 60 * 1000); // 11m ago
    insertHighlight(db, 's1', 'p1', now - 1_000);  // fresh — should not surface
    const out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).not.toBeNull();
    expect(out).toContain('## Substrate Health');
    expect(out).toContain('Angel heartbeat is not ticking');
    expect(out).toContain('last tick 11m ago');
    expect(out).not.toContain('session_highlights extraction is lagging');
  });

  it('surfaces "no recorded ticks" when heartbeat has never written', () => {
    const now = 100_000_000;
    insertHighlight(db, 's1', 'p1', now - 1_000);
    const out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).not.toBeNull();
    expect(out).toContain('no recorded ticks');
  });

  it('surfaces highlights-stale line when last extraction is >24h old', () => {
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 1_000); // fresh
    insertHighlight(db, 's1', 'p1', now - 25 * 60 * 60 * 1000); // 25h ago
    const out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).not.toBeNull();
    expect(out).toContain('session_highlights extraction is lagging');
    expect(out).toContain('25h ago');
    expect(out).not.toContain('Angel heartbeat is not ticking');
  });

  it('stays null when highlights are missing but heartbeat is fresh', () => {
    // A new project that has not yet produced any session_highlights row
    // is NOT degraded — extraction simply has not had anything to chew on
    // yet. Only stale-successful-extraction triggers the lagging line.
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 1_000);
    // No highlight rows at all for this project.
    expect(formatSubstrateHealthSection(db, 'empty-project', now)).toBeNull();
  });

  it('returns null when both signals are entirely absent (cold-start DB)', () => {
    // Empty DB. No heartbeat rows, no highlight rows. The signal is "we
    // expected data and it is stale"; a brand-new DB hasn't had time to
    // produce anything, so this surface would be pure noise.
    expect(formatSubstrateHealthSection(db, 'cold-project')).toBeNull();
  });

  it('surfaces both notes when both signals are stale', () => {
    // 'now' must be large enough that `now - 48h` stays positive, otherwise
    // the readLastHighlightsEpochMs `v > 0` guard rejects the row.
    const now = 1_000_000_000_000;
    insertHeartbeatTick(db, now - 60 * 60 * 1000); // 1h ago
    insertHighlight(db, 's1', 'p1', now - 48 * 60 * 60 * 1000); // 2d ago
    const out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).not.toBeNull();
    expect(out).toContain('Angel heartbeat');
    expect(out).toContain('1h ago');
    expect(out).toContain('session_highlights extraction is lagging');
    expect(out).toContain('2d ago');
  });

  it('is non-throwing when tables are missing', () => {
    const emptyDb = new Database(':memory:');
    expect(() => formatSubstrateHealthSection(emptyDb, 'p1')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 13.1 Fix #7 (2026-05-15) — Phase 2 failure localization
// ---------------------------------------------------------------------------
describe('readRecentPhase2Failures', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('returns zero-state when telemetry has no phase-2 rows', () => {
    const summary = readRecentPhase2Failures(db);
    expect(summary).toEqual({
      count: 0,
      subsystems: [],
      latestSessionShort: null,
      hadTimeout: false,
    });
  });

  it('counts rows, dedups subsystems, and surfaces latest session_id_short', () => {
    insertPhase2Failure(db, { subsystem: 'extract_directives', session_id_short: 'oldsess1', ageSeconds: 1000 });
    insertPhase2Failure(db, { subsystem: 'classify_domains',   session_id_short: 'midsess1', ageSeconds: 500 });
    insertPhase2Failure(db, { subsystem: 'extract_directives', session_id_short: 'newsess1', ageSeconds: 10 });
    const summary = readRecentPhase2Failures(db);
    expect(summary.count).toBe(3);
    expect(summary.subsystems).toEqual(['classify_domains', 'extract_directives']);
    expect(summary.latestSessionShort).toBe('newsess1');
    expect(summary.hadTimeout).toBe(false);
  });

  it('flags hadTimeout when any row reason=timeout', () => {
    insertPhase2Failure(db, { subsystem: 'extract_directives', session_id_short: 's1', reason: 'other' });
    insertPhase2Failure(db, { subsystem: 'classify_domains',   session_id_short: 's2', reason: 'timeout' });
    const summary = readRecentPhase2Failures(db);
    expect(summary.hadTimeout).toBe(true);
  });

  it('excludes rows older than the window', () => {
    insertPhase2Failure(db, { subsystem: 'extract_directives', session_id_short: 'fresh', ageSeconds: 100 });
    insertPhase2Failure(db, { subsystem: 'extract_directives', session_id_short: 'old',   ageSeconds: 100_000 });
    const summary = readRecentPhase2Failures(db, 86_400); // 24h window
    expect(summary.count).toBe(1);
    expect(summary.latestSessionShort).toBe('fresh');
  });

  it('skips telemetry rows from non-phase-2 subsystems', () => {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, timestamp_epoch, adapter)
       VALUES ('x', 'error', ?, ?, 'reranker')`,
    ).run(JSON.stringify({ subsystem: 'reranker/unreachable' }), Math.floor(Date.now() / 1000));
    expect(readRecentPhase2Failures(db).count).toBe(0);
  });

  it('tolerates malformed detail JSON', () => {
    db.prepare(
      `INSERT INTO telemetry (session_id, event_kind, detail, timestamp_epoch, adapter)
       VALUES ('angel-heartbeat', 'error', 'not-json', ?, 'angel-heartbeat')`,
    ).run(Math.floor(Date.now() / 1000));
    // The LIKE filter on json_extract returns nothing for non-JSON; row drops out cleanly.
    expect(readRecentPhase2Failures(db).count).toBe(0);
  });
});

describe('formatSubstrateHealthSection — Phase 2 narrative branch', () => {
  let db: DatabaseType;
  beforeEach(() => { db = makeDb(); });

  it('surfaces phase-2 line even when heartbeat + highlights are fresh', () => {
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 1_000);
    insertHighlight(db, 's1', 'p1', now - 1_000);
    insertPhase2Failure(db, { subsystem: 'extract_directives', session_id_short: 'failsess', reason: 'timeout' });
    const out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).not.toBeNull();
    expect(out).toContain('Phase 2 has logged');
    expect(out).toContain('extract_directives');
    expect(out).toContain('failsess');
    expect(out).toContain('per-await timeout');
    // Other notes stay silent because their signals are fresh.
    expect(out).not.toContain('Angel heartbeat is not ticking');
    expect(out).not.toContain('session_highlights extraction is lagging');
  });

  it('uses singular "failure" when count=1 and plural otherwise', () => {
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 1_000);
    insertPhase2Failure(db, { subsystem: 'classify_domains', session_id_short: 's1' });
    let out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).toContain('1 failure ');
    insertPhase2Failure(db, { subsystem: 'classify_domains', session_id_short: 's2' });
    out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).toContain('2 failures');
  });

  it('omits the timeout tag when no row is reason=timeout', () => {
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 1_000);
    insertPhase2Failure(db, { subsystem: 'extract_directives', session_id_short: 's1', reason: 'other' });
    const out = formatSubstrateHealthSection(db, 'p1', now);
    expect(out).not.toBeNull();
    expect(out).not.toContain('per-await timeout');
  });

  it('still returns null when phase-2 count is 0 and other signals fresh', () => {
    const now = 100_000_000;
    insertHeartbeatTick(db, now - 1_000);
    insertHighlight(db, 's1', 'p1', now - 1_000);
    expect(formatSubstrateHealthSection(db, 'p1', now)).toBeNull();
  });
});
