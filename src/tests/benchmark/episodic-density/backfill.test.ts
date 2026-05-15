/**
 * Phase 2 Plan 03 — backfill module tests (IDX-01).
 *
 * Covers:
 *   - Idempotency: re-runs do not duplicate sidecar rows or shadow rows
 *   - conversation_turns is NEVER read (SQL-trace spy)
 *   - corpus_origin tagging is correct per source
 *   - Floor check (>=50 fingerprinted AND >=3 projects)
 *   - Phase 1 organic row body byte-identical post-backfill (only metadata_json mutates)
 *   - Non-error content stays clean (no fingerprint added)
 *   - Shadow row created exactly once per fingerprinted v4 artifact
 *   - dryRun=true: counters populated, DB byte-identical
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { runBackfill, backfillPhase1Organic, backfillV4Artifacts } from '../../../benchmark/episodic-density/backfill.js';
import { writeToolResult } from '../../../core/episodic-events.js';
import { PHASE1_SHIP_TS_EPOCH } from '../../../benchmark/episodic-density/types.js';

const STACK_TRACE_A = `TypeError: x is not a function
    at fnA (a.js:1:1)
    at fnB (a.js:2:1)
    at fnC (a.js:3:1)
    at fnD (a.js:4:1)
    at fnE (a.js:5:1)`;

const STACK_TRACE_B = `KeyError: 'missing-token'
    at python_fn1 (b.py:10:1)
    at python_fn2 (b.py:20:1)
    at python_fn3 (b.py:30:1)`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  // initializeSchema already creates the production `artifacts` table.
});

afterEach(() => {
  db.close();
});

function seedOrganicTraceRows(): void {
  // Three stack-trace tool_result rows + two non-error tool_result rows
  for (let i = 0; i < 3; i++) {
    writeToolResult({
      db,
      sessionId: `sess-${i}`,
      project: i === 0 ? 'projA' : i === 1 ? 'projB' : 'projC',
      toolName: 'Bash',
      toolInput: { command: 'cmd' },
      toolResult: i === 1 ? STACK_TRACE_B : STACK_TRACE_A,
      turnNumber: i,
      errorFingerprintEnabled: false, // disable ingest-time so backfill is the only writer
    });
  }
  for (let i = 0; i < 2; i++) {
    writeToolResult({
      db,
      sessionId: `sess-clean-${i}`,
      project: 'projA',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResult: 'plain log line',
      turnNumber: 100 + i,
      errorFingerprintEnabled: false,
    });
  }
  // Force ts_epoch to be >= PHASE1_SHIP_TS_EPOCH (the writer used unixepoch())
  db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
}

function seedV4ArtifactRows(): void {
  // Seed the production `artifacts` schema. Required-NOT-NULL columns
  // (session_id, project, artifact_type, summary, state, ttl, importance,
  // timestamp_epoch_ms) all populated; everything else takes table defaults.
  const stmt = db.prepare(
    `INSERT INTO artifacts
       (id, session_id, project, artifact_type, artifact_ref, summary, content, state, ttl, importance, timestamp_epoch_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'fresh', 0, 1, ?)`,
  );
  stmt.run(1, 'old-1', 'projC', 'observation', 'old-1', 's', STACK_TRACE_A, 1700000000);
  stmt.run(2, 'old-2', 'projD', 'observation', 'old-2', 's', STACK_TRACE_B, 1700001000);
  stmt.run(3, 'old-3', 'projA', 'observation', 'old-3', 's', 'plain old observation', 1700002000);
  stmt.run(4, 'old-4', 'projA', 'observation', 'old-4', 's', 'another plain observation', 1700003000);
  stmt.run(5, 'old-5', 'projE', 'flow', 'old-5', 's', STACK_TRACE_A, 1700004000); // wrong artifact_type
}

describe('Phase 2 Plan 03 — backfill module (IDX-01)', () => {
  it('is idempotent — sidecar row count and metadata_json are byte-identical across two runs', async () => {
    seedOrganicTraceRows();
    seedV4ArtifactRows();

    await runBackfill(db, { dryRun: false });

    const sidecarBefore = db.prepare(`SELECT COUNT(*) AS n FROM episodic_index_error_fingerprint`).get() as { n: number };
    const orgRowsBefore = db.prepare(
      `SELECT id, metadata_json FROM episodic_events WHERE provenance='tool_result' ORDER BY id`,
    ).all() as Array<{ id: number; metadata_json: string }>;
    const shadowsBefore = db.prepare(
      `SELECT COUNT(*) AS n FROM episodic_events WHERE source = 'backfill/v4-artifact'`,
    ).get() as { n: number };

    // Second run
    await runBackfill(db, { dryRun: false });

    const sidecarAfter = db.prepare(`SELECT COUNT(*) AS n FROM episodic_index_error_fingerprint`).get() as { n: number };
    const orgRowsAfter = db.prepare(
      `SELECT id, metadata_json FROM episodic_events WHERE provenance='tool_result' ORDER BY id`,
    ).all() as Array<{ id: number; metadata_json: string }>;
    const shadowsAfter = db.prepare(
      `SELECT COUNT(*) AS n FROM episodic_events WHERE source = 'backfill/v4-artifact'`,
    ).get() as { n: number };

    expect(sidecarAfter.n).toBe(sidecarBefore.n);
    expect(shadowsAfter.n).toBe(shadowsBefore.n);
    expect(JSON.stringify(orgRowsAfter)).toBe(JSON.stringify(orgRowsBefore));
  });

  it('NEVER reads conversation_turns (SQL-trace spy)', async () => {
    seedOrganicTraceRows();
    seedV4ArtifactRows();
    const compiledSql: string[] = [];
    const origPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      compiledSql.push(sql);
      return origPrepare(sql);
    });

    await runBackfill(db, { dryRun: false });
    spy.mockRestore();

    const offending = compiledSql.filter(s => /conversation_turns/i.test(s));
    expect(offending).toEqual([]);
  });

  it('tags every sidecar row with the correct corpus_origin', async () => {
    seedOrganicTraceRows();
    seedV4ArtifactRows();
    await runBackfill(db, { dryRun: false });

    // Phase 1 organic sidecar rows always point to a tool_result row.
    const organicCheck = db.prepare(`
      SELECT s.corpus_origin AS origin, e.provenance
        FROM episodic_index_error_fingerprint s
        JOIN episodic_events e ON e.id = s.episode_event_id
       WHERE s.corpus_origin = 'phase1_organic_pre_phase2_close'
    `).all() as Array<{ origin: string; provenance: string }>;
    expect(organicCheck.length).toBeGreaterThan(0);
    for (const row of organicCheck) {
      expect(row.provenance).toBe('tool_result');
    }

    // v4 backfill sidecar rows always point to a shadow row.
    const v4Check = db.prepare(`
      SELECT s.corpus_origin AS origin, e.source, e.provenance
        FROM episodic_index_error_fingerprint s
        JOIN episodic_events e ON e.id = s.episode_event_id
       WHERE s.corpus_origin = 'v4_backfill'
    `).all() as Array<{ origin: string; source: string; provenance: string }>;
    expect(v4Check.length).toBeGreaterThan(0);
    for (const row of v4Check) {
      expect(row.source).toBe('backfill/v4-artifact');
      expect(row.provenance).toBe('environmental');
    }
  });

  it('floor check: false at <50 fingerprinted, true at >=50 with >=3 projects', async () => {
    // Seed exactly 49 fingerprinted across 3 projects
    for (let i = 0; i < 49; i++) {
      writeToolResult({
        db,
        sessionId: `sess-${i}`,
        project: i < 17 ? 'p1' : i < 34 ? 'p2' : 'p3',
        toolName: 'Bash',
        toolInput: {},
        toolResult: STACK_TRACE_A,
        turnNumber: i,
        errorFingerprintEnabled: false,
      });
    }
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
    let summary = await runBackfill(db, { dryRun: true });
    expect(summary.total_fingerprinted).toBe(49);
    expect(summary.total_projects).toBe(3);
    expect(summary.floor_met).toBe(false);

    writeToolResult({
      db,
      sessionId: 'sess-50',
      project: 'p3',
      toolName: 'Bash',
      toolInput: {},
      toolResult: STACK_TRACE_A,
      turnNumber: 50,
      errorFingerprintEnabled: false,
    });
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
    summary = await runBackfill(db, { dryRun: true });
    expect(summary.total_fingerprinted).toBe(50);
    expect(summary.floor_met).toBe(true);
  });

  it('floor check: false at >=50 fingerprinted but <3 projects', async () => {
    for (let i = 0; i < 51; i++) {
      writeToolResult({
        db,
        sessionId: `sess-${i}`,
        project: i < 26 ? 'p1' : 'p2',
        toolName: 'Bash',
        toolInput: {},
        toolResult: STACK_TRACE_A,
        turnNumber: i,
        errorFingerprintEnabled: false,
      });
    }
    db.prepare(`UPDATE episodic_events SET ts_epoch_ms = ?`).run(PHASE1_SHIP_TS_EPOCH + 60);
    const summary = await runBackfill(db, { dryRun: true });
    expect(summary.total_fingerprinted).toBeGreaterThanOrEqual(50);
    expect(summary.total_projects).toBe(2);
    expect(summary.floor_met).toBe(false);
  });

  it('Phase 1 organic content/provenance/source/ts_epoch unchanged post-backfill', async () => {
    seedOrganicTraceRows();
    const before = db.prepare(
      `SELECT id, content, provenance, source, ts_epoch_ms FROM episodic_events WHERE provenance='tool_result' ORDER BY id`,
    ).all() as Array<{ id: number; content: string; provenance: string; source: string; ts_epoch_ms: number }>;
    await runBackfill(db, { dryRun: false });
    const after = db.prepare(
      `SELECT id, content, provenance, source, ts_epoch_ms FROM episodic_events WHERE provenance='tool_result' ORDER BY id`,
    ).all() as Array<{ id: number; content: string; provenance: string; source: string; ts_epoch_ms: number }>;

    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].id).toBe(before[i].id);
      expect(after[i].content).toBe(before[i].content);
      expect(after[i].provenance).toBe(before[i].provenance);
      expect(after[i].source).toBe(before[i].source);
      expect(after[i].ts_epoch_ms).toBe(before[i].ts_epoch_ms);
    }
  });

  it('non-error organic rows do NOT receive metadata_json.error_fingerprint', async () => {
    seedOrganicTraceRows();
    await runBackfill(db, { dryRun: false });
    const cleanRows = db.prepare(
      `SELECT metadata_json FROM episodic_events WHERE session_id LIKE 'sess-clean-%'`,
    ).all() as Array<{ metadata_json: string }>;
    expect(cleanRows.length).toBe(2);
    for (const row of cleanRows) {
      const md = JSON.parse(row.metadata_json) as Record<string, unknown>;
      expect('error_fingerprint' in md).toBe(false);
    }
  });

  it('exactly one shadow row per fingerprinted v4 artifact (idempotent across two runs)', async () => {
    seedV4ArtifactRows();
    await runBackfill(db, { dryRun: false });
    await runBackfill(db, { dryRun: false });
    const shadows = db.prepare(
      `SELECT COUNT(*) AS n FROM episodic_events WHERE source = 'backfill/v4-artifact'`,
    ).get() as { n: number };
    // 2 of the 5 v4 rows had stack-trace content + correct artifact_type
    expect(shadows.n).toBe(2);
  });

  it('dryRun=true reports the same counts as a real run but does NOT mutate the DB', async () => {
    seedOrganicTraceRows();
    seedV4ArtifactRows();

    const sidecarStart = db.prepare(`SELECT COUNT(*) AS n FROM episodic_index_error_fingerprint`).get() as { n: number };
    const orgRowsStart = db.prepare(
      `SELECT id, metadata_json FROM episodic_events WHERE provenance='tool_result' ORDER BY id`,
    ).all() as Array<{ id: number; metadata_json: string }>;
    const shadowsStart = db.prepare(
      `SELECT COUNT(*) AS n FROM episodic_events WHERE source = 'backfill/v4-artifact'`,
    ).get() as { n: number };

    const dry = await runBackfill(db, { dryRun: true });

    const sidecarEnd = db.prepare(`SELECT COUNT(*) AS n FROM episodic_index_error_fingerprint`).get() as { n: number };
    const orgRowsEnd = db.prepare(
      `SELECT id, metadata_json FROM episodic_events WHERE provenance='tool_result' ORDER BY id`,
    ).all() as Array<{ id: number; metadata_json: string }>;
    const shadowsEnd = db.prepare(
      `SELECT COUNT(*) AS n FROM episodic_events WHERE source = 'backfill/v4-artifact'`,
    ).get() as { n: number };

    expect(sidecarEnd.n).toBe(sidecarStart.n);
    expect(shadowsEnd.n).toBe(shadowsStart.n);
    expect(JSON.stringify(orgRowsEnd)).toBe(JSON.stringify(orgRowsStart));

    // Dry run still reports counts as if real
    expect(dry.total_fingerprinted).toBe(5); // 3 organic stack-traces + 2 v4 stack-traces
    expect(dry.phase1_organic.fingerprinted).toBe(3);
    expect(dry.v4_backfill.fingerprinted).toBe(2);
  });

  it('per-source helpers backfillPhase1Organic and backfillV4Artifacts return populated counters', () => {
    seedOrganicTraceRows();
    seedV4ArtifactRows();

    const organic = backfillPhase1Organic(db, { dryRun: true });
    expect(organic.fingerprinted).toBe(3);
    expect(organic.projects.sort()).toEqual(['projA', 'projB', 'projC'].sort());

    const v4 = backfillV4Artifacts(db, { dryRun: true });
    expect(v4.fingerprinted).toBe(2);
    expect(v4.projects.sort()).toEqual(['projC', 'projD'].sort());
  });
});
