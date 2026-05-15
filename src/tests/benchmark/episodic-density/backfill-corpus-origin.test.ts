/**
 * Phase 2.1 Plan 02.1-01 — three-tier corpus_origin classification tests
 * (CONTEXT.md decision 1c).
 *
 * Asserts:
 *   - classifyCorpusOrigin is pure: provenance dominates, ts_epoch
 *     boundary inclusive on the pre-side.
 *   - Backfill on an in-memory fixture DB assigns the new tiers correctly:
 *     organic events on either side of PHASE2_CLOSE_TS_EPOCH split
 *     pre/post; v4 artifact rows always map to v4_backfill regardless
 *     of timestamp.
 *   - Re-running backfill is idempotent: row count + corpus_origin
 *     assignments are byte-equal between runs.
 *   - No corpus_origin row falls through (all sidecar rows carry one of
 *     the three tier values).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { writeToolResult } from '../../../core/episodic-events.js';
import {
  classifyCorpusOrigin,
  runBackfill,
} from '../../../benchmark/episodic-density/backfill.js';
import {
  PHASE1_SHIP_TS_EPOCH,
  PHASE2_CLOSE_TS_EPOCH,
} from '../../../benchmark/episodic-density/types.js';

const STACK_TRACE = `TypeError: x is not a function
    at fnA (a.js:1:1)
    at fnB (a.js:2:1)
    at fnC (a.js:3:1)
    at fnD (a.js:4:1)
    at fnE (a.js:5:1)`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe('classifyCorpusOrigin (pure — Plan 02.1-01 Task 1)', () => {
  it('provenance organic + ts_epoch < boundary -> phase1_organic_pre_phase2_close', () => {
    expect(classifyCorpusOrigin('organic', PHASE2_CLOSE_TS_EPOCH - 1)).toBe(
      'phase1_organic_pre_phase2_close',
    );
  });

  it('provenance organic + ts_epoch == boundary -> phase1_organic_pre_phase2_close (boundary inclusive on pre-side)', () => {
    expect(classifyCorpusOrigin('organic', PHASE2_CLOSE_TS_EPOCH)).toBe(
      'phase1_organic_pre_phase2_close',
    );
  });

  it('provenance organic + ts_epoch > boundary -> phase1_organic_post_phase2_close', () => {
    expect(classifyCorpusOrigin('organic', PHASE2_CLOSE_TS_EPOCH + 1)).toBe(
      'phase1_organic_post_phase2_close',
    );
  });

  it('non-organic provenance -> v4_backfill regardless of ts_epoch', () => {
    expect(classifyCorpusOrigin('environmental', 0)).toBe('v4_backfill');
    expect(classifyCorpusOrigin('environmental', PHASE2_CLOSE_TS_EPOCH + 1)).toBe(
      'v4_backfill',
    );
    expect(classifyCorpusOrigin('tool_result', 9999999999)).toBe('v4_backfill');
    expect(classifyCorpusOrigin('injected', 0)).toBe('v4_backfill');
  });

  it('provenance dominates ts_epoch — non-organic post-boundary still v4_backfill', () => {
    expect(classifyCorpusOrigin('environmental', PHASE2_CLOSE_TS_EPOCH + 1000)).toBe(
      'v4_backfill',
    );
  });
});

describe('Backfill integration — three-tier corpus_origin assignment', () => {
  function seedV4ArtifactRow(id: number, ts: number, project: string, content: string): void {
    db.prepare(
      `INSERT INTO artifacts
         (id, session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance, timestamp_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'fresh', 0, 1, ?)`,
    ).run(id, `old-${id}`, project, 'observation', `old-${id}`, 's', content, ts);
  }

  it('classifies organic rows on either side of PHASE2_CLOSE_TS_EPOCH and v4 artifacts as v4_backfill', async () => {
    // Two organic tool_result rows pre-boundary, one post-boundary.
    writeToolResult({
      db,
      sessionId: 'pre-1',
      project: 'p1',
      toolName: 'Bash',
      toolInput: {},
      toolResult: STACK_TRACE,
      turnNumber: 0,
      errorFingerprintEnabled: false,
    });
    writeToolResult({
      db,
      sessionId: 'pre-2',
      project: 'p2',
      toolName: 'Bash',
      toolInput: {},
      toolResult: STACK_TRACE,
      turnNumber: 1,
      errorFingerprintEnabled: false,
    });
    writeToolResult({
      db,
      sessionId: 'post-1',
      project: 'p3',
      toolName: 'Bash',
      toolInput: {},
      toolResult: STACK_TRACE,
      turnNumber: 2,
      errorFingerprintEnabled: false,
    });
    // Force the timestamps deterministically: pre rows below boundary,
    // post row strictly above.
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ? WHERE session_id IN ('pre-1', 'pre-2')`).run(
      PHASE2_CLOSE_TS_EPOCH - 100,
    );
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ? WHERE session_id = 'post-1'`).run(
      PHASE2_CLOSE_TS_EPOCH + 100,
    );

    // v4 artifact rows: one pre-boundary timestamp, one post-boundary
    // timestamp; both must classify as v4_backfill.
    seedV4ArtifactRow(101, PHASE2_CLOSE_TS_EPOCH - 5000, 'p4', STACK_TRACE);
    seedV4ArtifactRow(102, PHASE2_CLOSE_TS_EPOCH + 5000, 'p5', STACK_TRACE);

    await runBackfill(db, { dryRun: false });

    const counts = db.prepare(`
      SELECT corpus_origin, COUNT(*) as n
        FROM episodic_index_error_fingerprint
       GROUP BY corpus_origin
       ORDER BY corpus_origin
    `).all() as Array<{ corpus_origin: string; n: number }>;

    const byOrigin = new Map(counts.map(c => [c.corpus_origin, c.n]));
    expect(byOrigin.get('phase1_organic_pre_phase2_close') ?? 0).toBeGreaterThan(0);
    expect(byOrigin.get('phase1_organic_post_phase2_close') ?? 0).toBeGreaterThan(0);
    expect(byOrigin.get('v4_backfill') ?? 0).toBeGreaterThan(0);

    // Per-event-id classification spot-check.
    const preIds = db.prepare(
      `SELECT id FROM episodic_events WHERE session_id IN ('pre-1', 'pre-2')`,
    ).all() as Array<{ id: number }>;
    const postIds = db.prepare(
      `SELECT id FROM episodic_events WHERE session_id = 'post-1'`,
    ).all() as Array<{ id: number }>;
    const preTiers = db.prepare(
      `SELECT DISTINCT corpus_origin FROM episodic_index_error_fingerprint WHERE episode_event_id IN (${preIds.map(() => '?').join(',')})`,
    ).all(...preIds.map(r => r.id)) as Array<{ corpus_origin: string }>;
    const postTiers = db.prepare(
      `SELECT DISTINCT corpus_origin FROM episodic_index_error_fingerprint WHERE episode_event_id IN (${postIds.map(() => '?').join(',')})`,
    ).all(...postIds.map(r => r.id)) as Array<{ corpus_origin: string }>;
    expect(preTiers.map(r => r.corpus_origin)).toEqual(['phase1_organic_pre_phase2_close']);
    expect(postTiers.map(r => r.corpus_origin)).toEqual(['phase1_organic_post_phase2_close']);
  });

  it('no row falls through — every sidecar row has corpus_origin in the three-tier set', async () => {
    writeToolResult({
      db,
      sessionId: 'sess-1',
      project: 'p',
      toolName: 'Bash',
      toolInput: {},
      toolResult: STACK_TRACE,
      turnNumber: 0,
      errorFingerprintEnabled: false,
    });
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
    seedV4ArtifactRow(1, 1700000000, 'p', STACK_TRACE);
    await runBackfill(db, { dryRun: false });

    const fallthrough = db.prepare(
      `SELECT COUNT(*) AS n FROM episodic_index_error_fingerprint
        WHERE corpus_origin NOT IN ('v4_backfill', 'phase1_organic_pre_phase2_close', 'phase1_organic_post_phase2_close')`,
    ).get() as { n: number };
    expect(fallthrough.n).toBe(0);
  });

  it('idempotent on re-run: per-row corpus_origin assignments byte-equal across two runs', async () => {
    writeToolResult({
      db,
      sessionId: 'pre-A',
      project: 'p1',
      toolName: 'Bash',
      toolInput: {},
      toolResult: STACK_TRACE,
      turnNumber: 0,
      errorFingerprintEnabled: false,
    });
    writeToolResult({
      db,
      sessionId: 'post-A',
      project: 'p2',
      toolName: 'Bash',
      toolInput: {},
      toolResult: STACK_TRACE,
      turnNumber: 1,
      errorFingerprintEnabled: false,
    });
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ? WHERE session_id = 'pre-A'`).run(
      PHASE2_CLOSE_TS_EPOCH - 1,
    );
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ? WHERE session_id = 'post-A'`).run(
      PHASE2_CLOSE_TS_EPOCH + 1,
    );
    seedV4ArtifactRow(1, 1700000000, 'p3', STACK_TRACE);

    await runBackfill(db, { dryRun: false });
    // Sort by content (not autoincrement id, which the existing backfill
    // re-issues on every delete-then-insert cycle) so idempotency means
    // "identical content set", not "identical autoincrement ids".
    const snapshot1 = db.prepare(
      `SELECT episode_event_id, corpus_origin, shingle_hash
         FROM episodic_index_error_fingerprint
         ORDER BY episode_event_id, shingle_hash`,
    ).all();
    const count1 = (db.prepare(`SELECT COUNT(*) as n FROM episodic_index_error_fingerprint`).get() as { n: number }).n;

    await runBackfill(db, { dryRun: false });
    const snapshot2 = db.prepare(
      `SELECT episode_event_id, corpus_origin, shingle_hash
         FROM episodic_index_error_fingerprint
         ORDER BY episode_event_id, shingle_hash`,
    ).all();
    const count2 = (db.prepare(`SELECT COUNT(*) as n FROM episodic_index_error_fingerprint`).get() as { n: number }).n;

    expect(count2).toBe(count1);
    expect(JSON.stringify(snapshot2)).toBe(JSON.stringify(snapshot1));
  });
});
