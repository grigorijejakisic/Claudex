/**
 * Phase 1 Plan 01-02 — dual-write tests for the Stop hook
 * (assistant_message episodic row).
 *
 * Covers:
 *   - Pending turn from a prior UserPromptSubmit gets filled in:
 *     conversation_turns row's assistant_text is UPDATEd; one new episodic
 *     row with type='assistant_message' / provenance='organic' / matching
 *     turn_number is INSERTed.
 *   - No pending turn (fallback): a fresh conversation_turns row with
 *     user_text=NULL is INSERTed; one new episodic_message row.
 *   - Assistant text containing wrapper-tag-looking strings is NOT split
 *     (parser is only invoked for user prompts; assistant output is raw
 *     organic).
 *   - Atomicity: rollback yields zero new rows + one telemetry row.
 *
 * EPI-03, EPI-04.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../core/migrations.js';
import { dualWriteUserPrompt, dualWriteAssistantMessage } from '../../../core/episodic-events.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

describe('Phase 1 Plan 01-02 — dualWriteAssistantMessage (EPI-03, EPI-04)', () => {
  it('EPI-03: pending turn from UserPromptSubmit gets filled — UPDATE legacy + INSERT episodic', () => {
    dualWriteUserPrompt(db, 'sess-A', 'proj', 'how does X work?');
    const result = dualWriteAssistantMessage(db, 'sess-A', 'proj', 'X works like this.');
    expect(result.updatedLegacy).toBe(true);

    const ct = db.prepare('SELECT user_text, assistant_text, turn_number FROM conversation_turns WHERE session_id=?').get('sess-A') as { user_text: string; assistant_text: string; turn_number: number };
    expect(ct.user_text).toBe('how does X work?');
    expect(ct.assistant_text).toBe('X works like this.');

    const epRows = db.prepare(
      `SELECT type, provenance, content, turn_number FROM episodic_events
        WHERE session_id='sess-A' ORDER BY id`,
    ).all() as Array<{ type: string; provenance: string; content: string; turn_number: number }>;
    expect(epRows).toHaveLength(2);
    expect(epRows[0].type).toBe('user_prompt');
    expect(epRows[1].type).toBe('assistant_message');
    expect(epRows[1].provenance).toBe('organic');
    expect(epRows[1].content).toBe('X works like this.');
    expect(epRows[1].turn_number).toBe(epRows[0].turn_number);
    expect(epRows[1].turn_number).toBe(ct.turn_number);
  });

  it('EPI-03: no pending turn fallback — INSERT fresh conversation_turns + INSERT episodic', () => {
    const result = dualWriteAssistantMessage(db, 'sess-fallback', 'proj', 'standalone reply');
    expect(result.updatedLegacy).toBe(false);

    const ct = db.prepare('SELECT user_text, assistant_text FROM conversation_turns WHERE session_id=?').all('sess-fallback') as Array<{ user_text: string | null; assistant_text: string }>;
    expect(ct).toHaveLength(1);
    expect(ct[0].user_text).toBeNull();
    expect(ct[0].assistant_text).toBe('standalone reply');

    const ep = db.prepare(
      `SELECT type, provenance, content FROM episodic_events WHERE session_id='sess-fallback'`,
    ).all() as Array<{ type: string; provenance: string; content: string }>;
    expect(ep).toHaveLength(1);
    expect(ep[0].type).toBe('assistant_message');
    expect(ep[0].provenance).toBe('organic');
    expect(ep[0].content).toBe('standalone reply');
  });

  it('EPI-04: assistant text containing wrapper-tag strings is NOT split (raw organic)', () => {
    const text = 'I think <system-reminder> is a wrapper tag, not a real reminder';
    dualWriteAssistantMessage(db, 'sess-noparse', 'proj', text);

    const ep = db.prepare(
      `SELECT content, provenance FROM episodic_events WHERE session_id='sess-noparse'`,
    ).all() as Array<{ content: string; provenance: string }>;
    expect(ep).toHaveLength(1);
    expect(ep[0].provenance).toBe('organic');
    expect(ep[0].content).toBe(text);
    // No injected rows.
    const inj = db.prepare(
      `SELECT COUNT(*) AS c FROM episodic_events WHERE session_id='sess-noparse' AND provenance='injected'`,
    ).get() as { c: number };
    expect(inj.c).toBe(0);
  });

  it('Atomicity: failure rolls back ALL writes and records one episodic_write_failure telemetry row', () => {
    db.exec('DROP TABLE episodic_events;');

    const ctBefore = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    const telBefore = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;

    expect(() => dualWriteAssistantMessage(db, 'sess-fail', 'proj', 'will fail')).toThrow();

    const ctAfter = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    const telAfter = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;

    expect(ctAfter - ctBefore).toBe(0);
    expect(telAfter - telBefore).toBe(1);
  });

  it('Atomicity: telemetry detail includes hook=stop and non-empty error_message', () => {
    db.exec('DROP TABLE episodic_events;');
    expect(() => dualWriteAssistantMessage(db, 'sess-detail', 'proj', 'failing')).toThrow();
    const row = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind='episodic_write_failure' ORDER BY id DESC LIMIT 1`,
    ).get() as { detail: string };
    const parsed = JSON.parse(row.detail);
    expect(parsed.hook).toBe('stop');
    expect(parsed.error_message.length).toBeGreaterThan(0);
  });
});
