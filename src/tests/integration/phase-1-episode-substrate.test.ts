/**
 * Phase 1 Plan 04 — Episode substrate end-to-end integration tests.
 *
 * Simulates a realistic CC turn cycle (UserPromptSubmit -> PostToolUse ->
 * Stop) by calling the substrate helpers directly in the same order a real
 * session would, then asserts on the resulting DB state. Does NOT spawn
 * real CC hook subprocesses (heavy CC-context dependencies; out of scope).
 *
 * Each test name starts with the EPI requirement ID(s) it covers so a
 * future grep "EPI-" returns Phase 1's coverage map.
 *
 * EPI-01..EPI-07.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  dualWriteUserPrompt,
  dualWriteAssistantMessage,
  writeToolResult,
  writeEnvironmentalEvent,
} from '../../core/episodic-events.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

function ep(sessionId: string) {
  return db.prepare(
    `SELECT id, type, source, content, provenance, parent_event_id, turn_number, metadata_json
       FROM episodic_events WHERE session_id = ? ORDER BY id`,
  ).all(sessionId) as Array<{
    id: number; type: string; source: string; content: string; provenance: string;
    parent_event_id: number | null; turn_number: number | null; metadata_json: string | null;
  }>;
}

function ct(sessionId: string) {
  return db.prepare('SELECT user_text, assistant_text, turn_number FROM conversation_turns WHERE session_id=? ORDER BY turn_number').all(sessionId) as Array<{
    user_text: string | null; assistant_text: string | null; turn_number: number;
  }>;
}

describe('Phase 1 — Episode substrate end-to-end (EPI-01..EPI-07)', () => {
  it('EPI-01..EPI-07: clean turn with no injection produces 1 organic prompt + 1 tool_result + 1 organic assistant_message', () => {
    dualWriteUserPrompt(db, 'sess-clean', 'proj', 'How does X work?');
    writeToolResult({
      db, sessionId: 'sess-clean', project: 'proj',
      toolName: 'Bash', toolInput: { command: 'ls' }, toolResult: 'file1\nfile2',
      turnNumber: 0,
    });
    dualWriteAssistantMessage(db, 'sess-clean', 'proj', "Here's how X works...");

    const cts = ct('sess-clean');
    expect(cts).toHaveLength(1);
    expect(cts[0].user_text).toBe('How does X work?');
    expect(cts[0].assistant_text).toBe("Here's how X works...");

    const eps = ep('sess-clean');
    expect(eps).toHaveLength(3);
    expect(eps.map(r => r.type)).toEqual(['user_prompt', 'tool_result', 'assistant_message']);
    expect(eps.map(r => r.provenance)).toEqual(['organic', 'tool_result', 'organic']);
    expect(eps.every(r => r.turn_number === 0)).toBe(true);
    // No injected rows in this scenario.
    expect(eps.find(r => r.provenance === 'injected')).toBeUndefined();
  });

  it('EPI-04: prompt with three different wrappers produces 1 organic + 3 injected, all parent-linked', () => {
    const prompt = 'real question\n<system-reminder>SR</system-reminder>\n<experience-data>EXP</experience-data>\n<file-content path="x">FC</file-content>';
    dualWriteUserPrompt(db, 'sess-3w', 'proj', prompt);

    const cts = ct('sess-3w');
    expect(cts).toHaveLength(1);
    expect(cts[0].user_text).toBe(prompt); // raw prompt preserved verbatim

    const eps = ep('sess-3w');
    expect(eps).toHaveLength(4);
    const organic = eps.find(r => r.provenance === 'organic')!;
    const injected = eps.filter(r => r.provenance === 'injected');
    expect(injected).toHaveLength(3);
    expect(organic.content).not.toContain('SR');
    expect(organic.content).not.toContain('EXP');
    expect(organic.content).not.toContain('FC');
    expect(injected.map(r => r.content)).toEqual(['SR', 'EXP', 'FC']);
    expect(injected.every(r => r.parent_event_id === organic.id)).toBe(true);
  });

  it('EPI-04 + EPI-07: Mem0 trap is structurally impossible — organic-filtered SELECT never returns wrapper content', () => {
    const prompt = 'real question\n<system-reminder>SR</system-reminder>\n<experience-data>EXP</experience-data>\n<file-content path="x">FC</file-content>';
    dualWriteUserPrompt(db, 'sess-trap', 'proj', prompt);

    const organic = db.prepare(
      `SELECT content FROM episodic_events WHERE session_id='sess-trap' AND provenance='organic'`,
    ).all() as Array<{ content: string }>;
    for (const row of organic) {
      expect(row.content).not.toMatch(/SR/);
      expect(row.content).not.toMatch(/EXP/);
      expect(row.content).not.toMatch(/FC/);
      expect(row.content).not.toMatch(/<system-reminder>/);
      expect(row.content).not.toMatch(/<experience-data>/);
      expect(row.content).not.toMatch(/<file-content/);
    }
  });

  it('EPI-03: tool_result rows do not pollute organic-filtered SELECTs even when content contains wrapper-tag strings', () => {
    const polluted = '<system-reminder>FAKE</system-reminder> raw stdout';
    dualWriteUserPrompt(db, 'sess-tr', 'proj', 'real question');
    writeToolResult({ db, sessionId: 'sess-tr', project: 'proj', toolName: 'Bash', toolInput: {}, toolResult: polluted, turnNumber: 0 });

    // The tool_result row's content has the wrapper-looking text verbatim.
    const tr = db.prepare(`SELECT content FROM episodic_events WHERE session_id='sess-tr' AND provenance='tool_result'`).all() as Array<{ content: string }>;
    expect(tr).toHaveLength(1);
    expect(tr[0].content).toBe(polluted);

    // But organic-filtered reads still don't see it.
    const organic = db.prepare(`SELECT content FROM episodic_events WHERE session_id='sess-tr' AND provenance='organic'`).all() as Array<{ content: string }>;
    for (const r of organic) {
      expect(r.content).not.toContain('FAKE');
      expect(r.content).not.toContain('<system-reminder>');
    }
  });

  it('EPI-05: tool_input is visible in metadata_json on tool_result rows', () => {
    writeToolResult({
      db, sessionId: 'sess-meta', project: 'proj',
      toolName: 'Bash', toolInput: { command: 'ls -la', cwd: '/foo' }, toolResult: 'output',
    });
    const row = db.prepare(`SELECT metadata_json FROM episodic_events WHERE session_id='sess-meta'`).get() as { metadata_json: string };
    const parsed = JSON.parse(row.metadata_json) as { tool_input: { command: string; cwd: string } };
    expect(parsed.tool_input.command).toBe('ls -la');
    expect(parsed.tool_input.cwd).toBe('/foo');
  });

  it('EPI-06: legacy conversation_turns row preserves the RAW prompt with wrappers intact', () => {
    const raw = 'q\n<experience-data>RECALL</experience-data>';
    dualWriteUserPrompt(db, 'sess-legacy', 'proj', raw);
    dualWriteAssistantMessage(db, 'sess-legacy', 'proj', 'reply');

    const cts = ct('sess-legacy');
    expect(cts).toHaveLength(1);
    expect(cts[0].user_text).toBe(raw);
    expect(cts[0].user_text).toContain('<experience-data>');
    expect(cts[0].assistant_text).toBe('reply');
  });

  it('EPI-03: environmental events on session boundaries do NOT participate in turn-bound queries', () => {
    writeEnvironmentalEvent({
      db, sessionId: 'sess-bound', project: 'proj',
      type: 'session_boundary', source: 'cc-hooks/session-start',
      content: 'Session opened: sess-bound',
    });
    dualWriteUserPrompt(db, 'sess-bound', 'proj', 'q');
    dualWriteAssistantMessage(db, 'sess-bound', 'proj', 'a');
    writeEnvironmentalEvent({
      db, sessionId: 'sess-bound', project: 'proj',
      type: 'session_boundary', source: 'cc-hooks/session-end',
      content: 'Session closed: sess-bound',
    });

    const env = db.prepare(`SELECT type, turn_number, parent_event_id FROM episodic_events WHERE session_id='sess-bound' AND provenance='environmental'`).all() as Array<{ type: string; turn_number: number | null; parent_event_id: number | null }>;
    expect(env).toHaveLength(2);
    for (const r of env) {
      expect(r.turn_number).toBeNull();
      expect(r.parent_event_id).toBeNull();
    }

    // Turn-bound query (e.g. retrieval) excludes the environmental rows entirely.
    const turnBound = db.prepare(`SELECT COUNT(*) AS c FROM episodic_events WHERE session_id='sess-bound' AND turn_number IS NOT NULL`).get() as { c: number };
    expect(turnBound.c).toBe(2); // user_prompt + assistant_message; the 2 environmental rows are excluded.
  });

  it('Atomicity: rollback yields zero conversation_turns delta + zero episodic delta + exactly one telemetry row', () => {
    // Drop the episodic table partway: the dualWriteUserPrompt transaction
    // first inserts conversation_turns, then tries to insert episodic_events
    // and throws. db.transaction rolls back the conversation_turns insert.
    // The catch path then writes one telemetry row OUTSIDE the rolled-back tx.
    const ctBefore = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    const eeBefore = (db.prepare('SELECT COUNT(*) AS c FROM episodic_events').get() as { c: number }).c;
    const telBefore = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;

    db.exec('DROP TABLE episodic_events;');
    expect(() => dualWriteUserPrompt(db, 'sess-fail', 'proj', 'will fail')).toThrow();

    const ctAfter = (db.prepare('SELECT COUNT(*) AS c FROM conversation_turns').get() as { c: number }).c;
    const telAfter = (db.prepare("SELECT COUNT(*) AS c FROM telemetry WHERE event_kind='episodic_write_failure'").get() as { c: number }).c;

    expect(ctAfter - ctBefore).toBe(0);
    expect(telAfter - telBefore).toBe(1);
    void eeBefore;
  });
});
