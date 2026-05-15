/**
 * Tests for Phase 4.1 process_* salience triggers (CONTEXT.md 2-of-5 rule).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { evaluateProcessTriggers } from '../../angel/process-trigger.js';

function ensureSession(db: Database.Database, sessionId: string, project: string, opts: { ended?: number } = {}): void {
  // Create a session row covering the test's required fields. Default
  // ended_at_epoch_ms unset; tests can pass `ended` for T5.
  // _epoch_ms columns store milliseconds — multiply seconds constants by 1000.
  const created = 1700000000 * 1000; // ms
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status, created_at_epoch_ms, ended_at_epoch_ms)
     VALUES (?, ?, 'completed', ?, ?)`,
  ).run(sessionId, project, created, opts.ended ?? null);
}

function recordEvt(db: Database.Database, sessionId: string, project: string, event_type: string, entity = 'x', action = 'a', detail: string | null = null): void {
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, project, event_type, entity, action, detail);
}

describe('process-trigger evaluateProcessTriggers (Phase 4.1)', () => {
  let db: Database.Database;
  const project = 'pt-proj';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('empty session: all triggers false, fireCount=0', () => {
    ensureSession(db, 'sess-empty', project);
    const set = evaluateProcessTriggers(db, 'sess-empty');
    expect(set.fireCount).toBe(0);
    expect(set.corrections.fired).toBe(false);
    expect(set.framing_break.fired).toBe(false);
    expect(set.pivots.fired).toBe(false);
    expect(set.novel_pattern.fired).toBe(false);
    expect(set.long_form.fired).toBe(false);
  });

  it('T1: 3 corrections → corrections.fired = true', () => {
    ensureSession(db, 'sess-T1', project);
    recordEvt(db, 'sess-T1', project, 'correction_detected');
    recordEvt(db, 'sess-T1', project, 'correction_detected');
    recordEvt(db, 'sess-T1', project, 'correction_detected');
    const set = evaluateProcessTriggers(db, 'sess-T1');
    expect(set.corrections.fired).toBe(true);
    expect(set.corrections.detail).toContain('3 corrections');
  });

  it('T2: 1 correction + topic_shift → only fires when T1 also fires (≥2 corrections)', () => {
    ensureSession(db, 'sess-T2-low', project);
    recordEvt(db, 'sess-T2-low', project, 'correction_detected');
    recordEvt(db, 'sess-T2-low', project, 'topic_shift');
    const setLow = evaluateProcessTriggers(db, 'sess-T2-low');
    expect(setLow.framing_break.fired).toBe(false); // 1 correction insufficient

    ensureSession(db, 'sess-T2-hit', project);
    recordEvt(db, 'sess-T2-hit', project, 'correction_detected');
    recordEvt(db, 'sess-T2-hit', project, 'correction_detected');
    recordEvt(db, 'sess-T2-hit', project, 'topic_shift');
    const setHit = evaluateProcessTriggers(db, 'sess-T2-hit');
    expect(setHit.framing_break.fired).toBe(true);
  });

  it('T3: 4 topic_shift events → pivots.fired = true', () => {
    ensureSession(db, 'sess-T3', project);
    for (let i = 0; i < 4; i++) recordEvt(db, 'sess-T3', project, 'topic_shift');
    const set = evaluateProcessTriggers(db, 'sess-T3');
    expect(set.pivots.fired).toBe(true);
    expect(set.pivots.detail).toContain('4 pivots');
  });

  it('T4: shape_candidate without canonical match → novel_pattern.fired = true', () => {
    ensureSession(db, 'sess-T4', project);
    db.prepare(
      `INSERT INTO shape_candidates (field, value, session_id, project, proposed_at_epoch)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task_shape', 'novel-thing', 'sess-T4', project, Date.now());
    const set = evaluateProcessTriggers(db, 'sess-T4');
    expect(set.novel_pattern.fired).toBe(true);
  });

  it('T4 negative: shape_candidate with canonical match → novel_pattern.fired = false', () => {
    ensureSession(db, 'sess-T4-neg', project);
    db.prepare(
      `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES (?, ?, ?, ?)`,
    ).run('task_shape', 'canonical-thing', Date.now(), 3);
    db.prepare(
      `INSERT INTO shape_candidates (field, value, session_id, project, proposed_at_epoch)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task_shape', 'canonical-thing', 'sess-T4-neg', project, Date.now());
    const set = evaluateProcessTriggers(db, 'sess-T4-neg');
    expect(set.novel_pattern.fired).toBe(false);
  });

  it('T5: 35min duration + 25 turns + low action ratio → long_form.fired = true', () => {
    const created = 1700000000 * 1000; // ms
    const ended = created + 35 * 60 * 1000; // 35 min in ms
    ensureSession(db, 'sess-T5', project, { ended });

    // Insert 25 conversation turns
    for (let i = 1; i <= 25; i++) {
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-T5', project, i, `u${i}`, `a${i}`, created + i);
    }
    // 5 file_edit events (5/25 = 0.2 < 0.5 → conversation-shaped)
    for (let i = 0; i < 5; i++) recordEvt(db, 'sess-T5', project, 'file_edit');

    const set = evaluateProcessTriggers(db, 'sess-T5');
    expect(set.long_form.fired).toBe(true);
    expect(set.long_form.detail).toContain('35min');
  });

  it('T5 negative: high action ratio → long_form.fired = false', () => {
    const created = 1700000000 * 1000; // ms
    const ended = created + 35 * 60 * 1000; // 35 min in ms
    ensureSession(db, 'sess-T5-neg', project, { ended });

    for (let i = 1; i <= 25; i++) {
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-T5-neg', project, i, `u${i}`, `a${i}`, created + i);
    }
    // 20 file_edit events (20/25 = 0.8 > 0.5 → action-shaped)
    for (let i = 0; i < 20; i++) recordEvt(db, 'sess-T5-neg', project, 'file_edit');

    const set = evaluateProcessTriggers(db, 'sess-T5-neg');
    expect(set.long_form.fired).toBe(false);
  });

  it('2-of-5 boundary: corrections + pivots fires → fireCount=2', () => {
    ensureSession(db, 'sess-2of5', project);
    recordEvt(db, 'sess-2of5', project, 'correction_detected');
    recordEvt(db, 'sess-2of5', project, 'correction_detected');
    for (let i = 0; i < 3; i++) recordEvt(db, 'sess-2of5', project, 'topic_shift');
    const set = evaluateProcessTriggers(db, 'sess-2of5');
    // T1 (corrections >= 2) ✓, T2 (correction + topic_shift) ✓, T3 (>= 3 pivots) ✓ → fireCount = 3
    expect(set.fireCount).toBeGreaterThanOrEqual(2);
  });

  it('5-of-5 maximum: all triggers fire', () => {
    const created = 1700000000 * 1000; // ms
    const ended = created + 35 * 60 * 1000; // 35 min in ms
    ensureSession(db, 'sess-5of5', project, { ended });

    // T1 + T2: 3 corrections + 3 topic_shift events
    for (let i = 0; i < 3; i++) recordEvt(db, 'sess-5of5', project, 'correction_detected');
    for (let i = 0; i < 3; i++) recordEvt(db, 'sess-5of5', project, 'topic_shift');

    // T4: novel shape candidate
    db.prepare(
      `INSERT INTO shape_candidates (field, value, session_id, project, proposed_at_epoch)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task_shape', 'novel', 'sess-5of5', project, Date.now());

    // T5: 25 turns, low action ratio
    for (let i = 1; i <= 25; i++) {
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-5of5', project, i, `u${i}`, `a${i}`, created + i);
    }
    for (let i = 0; i < 3; i++) recordEvt(db, 'sess-5of5', project, 'file_edit');

    const set = evaluateProcessTriggers(db, 'sess-5of5');
    expect(set.fireCount).toBe(5);
  });
});
