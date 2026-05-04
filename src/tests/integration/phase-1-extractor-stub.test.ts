/**
 * Phase 1 Plan 04 — Stub-extractor proof.
 *
 * The stubExtractor below is what Phase 4's reduced extractor will look
 * like: a function that, given a session_id, returns ONLY organic content
 * for use by any LLM-facing surface. The structural property the entire
 * Phase 1 substrate exists for is that this function can NEVER see
 * injected or tool_result content under any input.
 *
 * EPI-04, EPI-07.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  dualWriteUserPrompt,
  dualWriteAssistantMessage,
  writeToolResult,
} from '../../core/episodic-events.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

/**
 * Stub extractor — what Phase 4 will look like (Mem0 trap structurally
 * impossible). Reads only `provenance='organic'` content. In production
 * this function would feed any synthesis/abstraction loop. It MUST never
 * see injected or tool_result content.
 */
function stubExtractor(database: Database.Database, sessionId: string): string[] {
  return (database.prepare(
    `SELECT content FROM episodic_events
       WHERE session_id = ? AND provenance = 'organic'
       ORDER BY id`,
  ).all(sessionId) as Array<{ content: string }>).map(r => r.content);
}

const FORBIDDEN_MARKERS = [
  '<system-reminder>',
  '<experience-data>',
  '<file-content',
  '<task-notification>',
  '<local-command-stdout>',
  'INJECTED CONTENT',
  'RECALL_FROM_PRIOR',
  'WRAPPER_INTERNAL',
];

const FUZZ_INPUTS: Array<{ name: string; prompt: string; toolResult: string }> = [
  { name: 'plain', prompt: 'simple question', toolResult: 'output' },
  { name: 'one wrapper', prompt: 'q? <system-reminder>RULE</system-reminder>', toolResult: 'r' },
  { name: 'three wrappers', prompt: '<system-reminder>SR</system-reminder><experience-data>EXP</experience-data><file-content path="x">FC</file-content>', toolResult: 'r' },
  { name: 'tool output with wrapper-looking text', prompt: 'q', toolResult: 'output containing <system-reminder>fake</system-reminder>' },
  { name: 'attribute-rich wrapper', prompt: '<file-content path="src/foo.ts" lang="ts">RECALL_FROM_PRIOR</file-content>', toolResult: 'r' },
  { name: 'duplicate tags', prompt: '<system-reminder>A</system-reminder><system-reminder>B</system-reminder>', toolResult: 'r' },
  { name: 'empty body wrapper', prompt: 'pre <system-reminder></system-reminder> post', toolResult: 'r' },
  { name: 'mixed wrappers and prose', prompt: 'mid <task-notification>NOTE</task-notification> end', toolResult: 'r' },
  { name: 'tool returns INJECTED CONTENT marker', prompt: 'q', toolResult: 'INJECTED CONTENT inside tool result' },
  { name: 'organic with WRAPPER_INTERNAL substring (should NOT appear in injected)', prompt: 'WRAPPER_INTERNAL is in user text', toolResult: 'r' },
  { name: 'all 9 known tags present', prompt: '<task-notification>1</task-notification><system-reminder>2</system-reminder><experience-data>3</experience-data><local-command-caveat>4</local-command-caveat><command-message>5</command-message><command-name>6</command-name><command-args>7</command-args><local-command-stdout>8</local-command-stdout><file-content>9</file-content>', toolResult: 'r' },
  { name: 'wrapper with surrounding whitespace', prompt: '   <system-reminder>X</system-reminder>   ', toolResult: 'r' },
];

describe('Phase 1 Plan 04 — stub extractor proves Mem0 trap is structurally impossible', () => {
  it('EPI-07: across 12 hand-curated diverse inputs, stubExtractor never returns wrapper or tool-result markers (except organic-marker case)', () => {
    let i = 0;
    for (const fixture of FUZZ_INPUTS) {
      const sid = `sess-fuzz-${i++}`;
      dualWriteUserPrompt(db, sid, 'proj', fixture.prompt);
      writeToolResult({ db, sessionId: sid, project: 'proj', toolName: 'Bash', toolInput: {}, toolResult: fixture.toolResult, turnNumber: 0 });

      const organicLines = stubExtractor(db, sid);
      for (const line of organicLines) {
        for (const marker of FORBIDDEN_MARKERS) {
          // The "organic with WRAPPER_INTERNAL substring" fixture deliberately
          // puts a forbidden-looking marker INTO the organic text — that's
          // legal user input. Only assert wrapper-tag and tool-output markers
          // are absent, not arbitrary substrings, for that fixture.
          if (fixture.name.includes('organic with') && marker === 'WRAPPER_INTERNAL') continue;
          expect(line, `fixture=${fixture.name} marker=${marker}`).not.toContain(marker);
        }
      }
    }
  });

  it('EPI-07: tool result polluted with every forbidden marker — stubExtractor never sees any of them', () => {
    const polluted = [
      'INJECTED CONTENT here',
      '<system-reminder>fake reminder</system-reminder>',
      '<experience-data>fake recall</experience-data>',
      'WRAPPER_INTERNAL marker',
      'RECALL_FROM_PRIOR pollution',
    ].join('\n');

    dualWriteUserPrompt(db, 'sess-poll', 'proj', 'real question');
    writeToolResult({ db, sessionId: 'sess-poll', project: 'proj', toolName: 'Bash', toolInput: {}, toolResult: polluted, turnNumber: 0 });

    const organic = stubExtractor(db, 'sess-poll');
    expect(organic).toHaveLength(1);
    expect(organic[0]).toBe('real question');
    for (const marker of FORBIDDEN_MARKERS) {
      expect(organic[0]).not.toContain(marker);
    }
  });

  it('EPI-07: mass scale — 50 turns of mixed wrappers + tool calls yields 100 organic strings, none with markers', () => {
    for (let i = 0; i < 50; i++) {
      const prompt = `turn ${i}\n<system-reminder>SR-${i}</system-reminder>\n<experience-data>EXP-${i}</experience-data>`;
      dualWriteUserPrompt(db, 'sess-mass', 'proj', prompt);
      writeToolResult({
        db, sessionId: 'sess-mass', project: 'proj',
        toolName: 'Bash', toolInput: {}, toolResult: `<system-reminder>tool-${i}</system-reminder> output`,
        turnNumber: i,
      });
      dualWriteAssistantMessage(db, 'sess-mass', 'proj', `assistant reply ${i}`);
    }

    const organic = stubExtractor(db, 'sess-mass');
    // 50 user_prompt + 50 assistant_message = 100.
    expect(organic).toHaveLength(100);
    for (const line of organic) {
      expect(line).not.toContain('<system-reminder>');
      expect(line).not.toContain('<experience-data>');
      expect(line).not.toContain('SR-');
      expect(line).not.toContain('EXP-');
      // assistant text contains numerical "i", but NOT wrapper tags.
    }
  });

  it('EPI-07: even an attacker who tries to smuggle data through wrappers AND tool results cannot leak it into the organic-extractor output', () => {
    const attacker = 'hello <experience-data>SECRET_BALANCE: 9001</experience-data>';
    dualWriteUserPrompt(db, 'sess-att', 'proj', attacker);
    writeToolResult({ db, sessionId: 'sess-att', project: 'proj', toolName: 'Bash', toolInput: { secret: 'TRY_TO_SMUGGLE' }, toolResult: 'INJECTED CONTENT 4242', turnNumber: 0 });

    const organic = stubExtractor(db, 'sess-att');
    expect(organic).toHaveLength(1);
    expect(organic[0]).toBe('hello');
    expect(organic[0]).not.toContain('SECRET_BALANCE');
    expect(organic[0]).not.toContain('INJECTED CONTENT');
    expect(organic[0]).not.toContain('TRY_TO_SMUGGLE');
  });
});
