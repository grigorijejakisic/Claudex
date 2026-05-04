/**
 * Phase 1 Plan 01-02 — dual-write tests for UserPromptSubmit.
 *
 * Covers:
 *   - Plain prompts produce 1 organic + 0 injected.
 *   - Wrapped prompts produce 1 organic + N injected with parent_event_id
 *     linking each injected row to the organic row.
 *   - Same tag repeated produces distinct injected rows.
 *   - EPI-07 — the structural Mem0-trap-impossibility proof: reading
 *     `WHERE provenance='organic'` never returns wrapper-block content.
 *   - Legacy conversation_turns row preserves the RAW prompt (wrappers
 *     intact) — the v4 backwards-compat invariant.
 *   - Atomicity (rollback yields telemetry row + zero new rows).
 *   - Per-session turn_number isolation.
 *
 * EPI-04, EPI-07.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { dualWriteUserPrompt } from '../../../core/episodic-events.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function rowsForSession(sessionId: string): Array<{
  id: number;
  turn_number: number | null;
  type: string;
  source: string;
  content: string;
  provenance: string;
  parent_event_id: number | null;
  metadata_json: string | null;
}> {
  return db.prepare(
    `SELECT id, turn_number, type, source, content, provenance, parent_event_id, metadata_json
       FROM episodic_events
      WHERE session_id = ? ORDER BY id`,
  ).all(sessionId) as Array<{
    id: number;
    turn_number: number | null;
    type: string;
    source: string;
    content: string;
    provenance: string;
    parent_event_id: number | null;
    metadata_json: string | null;
  }>;
}

describe('Phase 1 Plan 01-02 — dualWriteUserPrompt (EPI-04, EPI-07)', () => {
  it('EPI-04: plain prompt produces 1 organic + 0 injected episodic rows + 1 conversation_turns row', () => {
    dualWriteUserPrompt(db, 'sess-A', 'proj', 'simple question');

    const rows = rowsForSession('sess-A');
    expect(rows).toHaveLength(1);
    expect(rows[0].provenance).toBe('organic');
    expect(rows[0].type).toBe('user_prompt');
    expect(rows[0].content).toBe('simple question');

    const ct = db.prepare('SELECT user_text FROM conversation_turns WHERE session_id=?').all('sess-A') as Array<{ user_text: string }>;
    expect(ct).toHaveLength(1);
    expect(ct[0].user_text).toBe('simple question');
  });

  it('EPI-04: one <experience-data> wrapper produces 1 organic + 1 injected linked via parent_event_id', () => {
    dualWriteUserPrompt(db, 'sess-A', 'proj', 'q? <experience-data>RECALL</experience-data>');

    const rows = rowsForSession('sess-A');
    expect(rows).toHaveLength(2);
    const organic = rows.find(r => r.provenance === 'organic')!;
    const injected = rows.find(r => r.provenance === 'injected')!;
    expect(organic.content).toBe('q?');
    expect(injected.content).toBe('RECALL');
    expect(injected.source).toBe('wrapper:experience-data');
    expect(injected.parent_event_id).toBe(organic.id);
    expect(injected.turn_number).toBe(organic.turn_number);
    expect(organic.parent_event_id).toBeNull();
    const meta = JSON.parse(injected.metadata_json!) as { tag: string; attributes: string | null };
    expect(meta.tag).toBe('experience-data');
  });

  it('EPI-04: three different wrappers produce 1 organic + 3 injected, all linked, in document order', () => {
    const prompt = 'pre <system-reminder>SR</system-reminder> mid <experience-data>EXP</experience-data> tail <file-content path="x.ts">FC</file-content>';
    dualWriteUserPrompt(db, 'sess-A', 'proj', prompt);

    const rows = rowsForSession('sess-A');
    expect(rows).toHaveLength(4);
    const organic = rows.find(r => r.provenance === 'organic')!;
    const injected = rows.filter(r => r.provenance === 'injected');
    expect(injected).toHaveLength(3);

    expect(injected.map(r => r.source)).toEqual([
      'wrapper:system-reminder',
      'wrapper:experience-data',
      'wrapper:file-content',
    ]);
    expect(injected.map(r => r.content)).toEqual(['SR', 'EXP', 'FC']);
    for (const r of injected) {
      expect(r.parent_event_id).toBe(organic.id);
      expect(r.turn_number).toBe(organic.turn_number);
    }

    const fileMeta = JSON.parse(injected[2].metadata_json!) as { tag: string; attributes: string | null };
    expect(fileMeta.attributes).toBe('path="x.ts"');
  });

  it('EPI-04: same tag repeated produces 2 distinct injected rows', () => {
    dualWriteUserPrompt(db, 'sess-A', 'proj', '<system-reminder>A</system-reminder> sep <system-reminder>B</system-reminder>');

    const injected = rowsForSession('sess-A').filter(r => r.provenance === 'injected');
    expect(injected).toHaveLength(2);
    expect(injected.map(r => r.content)).toEqual(['A', 'B']);
  });

  it('EPI-07: Mem0 trap is structurally impossible — organic-filtered SELECTs never return wrapper content', () => {
    const prompt = 'real question\n<experience-data>RECALLED FROM PRIOR SESSION</experience-data>';
    dualWriteUserPrompt(db, 'sess-trap', 'proj', prompt);

    const organic = db.prepare(
      `SELECT content FROM episodic_events WHERE session_id='sess-trap' AND provenance='organic'`,
    ).all() as Array<{ content: string }>;

    expect(organic).toHaveLength(1);
    expect(organic[0].content).not.toMatch(/RECALLED/);
    expect(organic[0].content).not.toMatch(/<experience-data>/);
    expect(organic[0].content).toBe('real question');
  });

  it('EPI-06: legacy conversation_turns row preserves the RAW prompt with wrappers intact', () => {
    const raw = 'q? <experience-data>RECALL</experience-data>';
    dualWriteUserPrompt(db, 'sess-A', 'proj', raw);

    const ct = db.prepare('SELECT user_text FROM conversation_turns WHERE session_id=?').get('sess-A') as { user_text: string };
    expect(ct.user_text).toBe(raw);
    expect(ct.user_text).toMatch(/<experience-data>/);
  });

  it('Atomicity: failure rolls back ALL writes and records exactly one episodic_write_failure telemetry row', () => {
    const ctBefore = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    const eeBefore = (db.prepare('SELECT COUNT(*) AS c FROM episodic_events').get() as { c: number }).c;
    const telBefore = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;

    // Drop the table partway to force a rollback during the second INSERT.
    // The first INSERT into conversation_turns succeeds, then the helper
    // tries to INSERT into episodic_events which suddenly does not exist.
    // db.transaction() catches the throw and rolls back the conversation_turns
    // row too. The telemetry write happens AFTER the transaction (in the
    // catch path) and persists.
    db.exec('DROP TABLE episodic_events;');

    expect(() => dualWriteUserPrompt(db, 'sess-fail', 'proj', 'will fail')).toThrow();

    const ctAfter = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    const telAfter = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;

    expect(ctAfter - ctBefore).toBe(0);
    expect(telAfter - telBefore).toBe(1);

    // Bring the table back so afterEach runs cleanly.
    void eeBefore;
  });

  it('Atomicity: telemetry row carries non-empty JSON detail with hook + error_message', () => {
    db.exec('DROP TABLE episodic_events;');
    expect(() => dualWriteUserPrompt(db, 'sess-detail', 'proj', 'failing')).toThrow();
    const row = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind='episodic_write_failure' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail: string };
    const parsed = JSON.parse(row.detail);
    expect(parsed.hook).toBe('user-prompt-submit');
    expect(typeof parsed.error_message).toBe('string');
    expect(parsed.error_message.length).toBeGreaterThan(0);
  });

  it('turn_number is monotonic per session (0 then 1 for two prompts)', () => {
    dualWriteUserPrompt(db, 'sess-mono', 'proj', 'first');
    dualWriteUserPrompt(db, 'sess-mono', 'proj', 'second');

    const turns = db.prepare(
      `SELECT turn_number FROM episodic_events WHERE session_id='sess-mono' AND provenance='organic' ORDER BY id`,
    ).all() as Array<{ turn_number: number }>;
    expect(turns.map(t => t.turn_number)).toEqual([0, 1]);
  });

  it('per-session isolation: sess-A and sess-B both start at turn_number 0', () => {
    dualWriteUserPrompt(db, 'sess-A', 'proj', 'A1');
    dualWriteUserPrompt(db, 'sess-B', 'proj', 'B1');

    const a = db.prepare("SELECT turn_number FROM episodic_events WHERE session_id='sess-A' AND provenance='organic'").get() as { turn_number: number };
    const b = db.prepare("SELECT turn_number FROM episodic_events WHERE session_id='sess-B' AND provenance='organic'").get() as { turn_number: number };
    expect(a.turn_number).toBe(0);
    expect(b.turn_number).toBe(0);
  });
});
