/**
 * Tests for Phase 4.1 lesson proposer (CONTEXT.md /endsession curation flow).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { proposeLessonsForSession, harvestTelemetry } from '../../angel/lesson-proposer.js';

function ensureSession(db: Database.Database, sessionId: string, project: string, opts: { ended?: number } = {}): void {
  const created = 1700000000;
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status, created_at_epoch_ms, ended_at_epoch_ms)
     VALUES (?, ?, 'completed', ?, ?)`,
  ).run(sessionId, project, created, opts.ended ?? null);
}

function recordEvt(db: Database.Database, sessionId: string, project: string, event_type: string, entity = 'x', detail: string | null = null): void {
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
     VALUES (?, ?, ?, ?, 'a', ?)`,
  ).run(sessionId, project, event_type, entity, detail);
}

describe('lesson-proposer proposeLessonsForSession (Phase 4.1)', () => {
  let db: Database.Database;
  const project = 'lp-proj';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('empty session (no events) returns []', () => {
    ensureSession(db, 'sess-empty', project);
    const proposals = proposeLessonsForSession(db, 'sess-empty');
    expect(proposals).toEqual([]);
  });

  it('1 correction → 1 feedback proposal', () => {
    ensureSession(db, 'sess-1corr', project);
    recordEvt(db, 'sess-1corr', project, 'correction_detected', 'agent', JSON.stringify({ directive_text: 'Always check existing dependencies' }));
    const proposals = proposeLessonsForSession(db, 'sess-1corr');
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe('feedback');
    expect(proposals[0].proposed_body).toContain('Always check existing dependencies');
  });

  it('3 corrections → ≤2 feedback proposals (cap), no process_* if fireCount<2', () => {
    ensureSession(db, 'sess-3corr', project);
    recordEvt(db, 'sess-3corr', project, 'correction_detected', 'agent', JSON.stringify({ directive_text: 'Rule A' }));
    recordEvt(db, 'sess-3corr', project, 'correction_detected', 'agent', JSON.stringify({ directive_text: 'Rule B' }));
    recordEvt(db, 'sess-3corr', project, 'correction_detected', 'agent', JSON.stringify({ directive_text: 'Rule C' }));
    const proposals = proposeLessonsForSession(db, 'sess-3corr');
    const feedbackCount = proposals.filter(p => p.type === 'feedback').length;
    expect(feedbackCount).toBeLessThanOrEqual(2);
    // T1 fired (3 corrections >= 2). T2 needs topic_shift co-occurrence, didn't happen.
    // fireCount = 1 (only T1) → process_* NOT proposed.
    const processCount = proposals.filter(p => p.type === 'process').length;
    expect(processCount).toBe(0);
  });

  it('1 correction + 1 decision → 1 feedback + 1 project', () => {
    ensureSession(db, 'sess-mixed', project);
    recordEvt(db, 'sess-mixed', project, 'correction_detected', 'agent', JSON.stringify({ directive_text: 'check first' }));
    recordEvt(db, 'sess-mixed', project, 'decision', 'angel', JSON.stringify({ summary: 'Use webhooks not polling' }));
    const proposals = proposeLessonsForSession(db, 'sess-mixed');
    expect(proposals.length).toBe(2);
    expect(proposals.map(p => p.type).sort()).toEqual(['feedback', 'project']);
  });

  it('triggers fireCount=1 → no process_* (below 2-of-5 threshold)', () => {
    ensureSession(db, 'sess-low', project);
    recordEvt(db, 'sess-low', project, 'correction_detected'); // T1 needs >= 2; fireCount stays 0
    const proposals = proposeLessonsForSession(db, 'sess-low');
    const processCount = proposals.filter(p => p.type === 'process').length;
    expect(processCount).toBe(0);
  });

  it('triggers fireCount=3 → at most 1 process_* (max-1-per-session)', () => {
    ensureSession(db, 'sess-3triggers', project);
    // T1 (corrections >= 2) + T2 (correction + topic_shift) + T3 (>= 3 pivots) = 3
    recordEvt(db, 'sess-3triggers', project, 'correction_detected');
    recordEvt(db, 'sess-3triggers', project, 'correction_detected');
    recordEvt(db, 'sess-3triggers', project, 'topic_shift');
    recordEvt(db, 'sess-3triggers', project, 'topic_shift');
    recordEvt(db, 'sess-3triggers', project, 'topic_shift');
    const proposals = proposeLessonsForSession(db, 'sess-3triggers');
    const processCount = proposals.filter(p => p.type === 'process').length;
    expect(processCount).toBe(1);
  });

  it('total cap of 3: feedback(2) + project(1) + process(1) = 4 → returned slice is 3', () => {
    ensureSession(db, 'sess-cap', project);
    // 2 distinct corrections
    recordEvt(db, 'sess-cap', project, 'correction_detected', 'agent', JSON.stringify({ directive_text: 'Rule A' }));
    recordEvt(db, 'sess-cap', project, 'correction_detected', 'agent', JSON.stringify({ directive_text: 'Rule B' }));
    // 1 decision
    recordEvt(db, 'sess-cap', project, 'decision', 'angel', JSON.stringify({ summary: 'A fact' }));
    // 3 topic_shifts (T3 fires → fireCount=2 with T1)
    recordEvt(db, 'sess-cap', project, 'topic_shift');
    recordEvt(db, 'sess-cap', project, 'topic_shift');
    recordEvt(db, 'sess-cap', project, 'topic_shift');

    const proposals = proposeLessonsForSession(db, 'sess-cap');
    expect(proposals.length).toBeLessThanOrEqual(3);
  });

  it('telemetry harvest: tools_used populated when file_edit events exist', () => {
    ensureSession(db, 'sess-telem', project);
    recordEvt(db, 'sess-telem', project, 'file_edit', 'src/x.ts');
    recordEvt(db, 'sess-telem', project, 'file_edit', 'src/y.ts');
    db.prepare(
      `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
       VALUES (?, ?, 1, 'check the dependencies again', 'sure', ?)`,
    ).run('sess-telem', project, 1700000005);
    db.prepare(
      `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
       VALUES (?, ?, 2, 'check the dependencies once more', 'ok', ?)`,
    ).run('sess-telem', project, 1700000010);

    const telem = harvestTelemetry(db, 'sess-telem');
    expect(telem.tools_used).toEqual(expect.arrayContaining(['src/x.ts', 'src/y.ts']));
    expect(telem.files_touched).toEqual(expect.arrayContaining(['src/x.ts', 'src/y.ts']));
    expect(telem.user_framing_tokens).toContain('dependencies');
  });

  it('correction_count in telemetry matches event count', () => {
    ensureSession(db, 'sess-cnt', project);
    recordEvt(db, 'sess-cnt', project, 'correction_detected');
    recordEvt(db, 'sess-cnt', project, 'correction_detected');
    recordEvt(db, 'sess-cnt', project, 'correction_detected');
    const telem = harvestTelemetry(db, 'sess-cnt');
    expect(telem.correction_count).toBe(3);
  });
});
