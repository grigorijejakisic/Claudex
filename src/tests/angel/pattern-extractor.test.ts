import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { getSessionTurns, stripInjectedBlocks } from '../../angel/pattern-extractor.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// Regression: Balanced JSON parse
// The pattern extractor uses balanced brace matching to extract JSON from
// LLM responses. Tests verify it handles: braces in strings, text after JSON,
// nested objects. The old greedy regex /\{[\s\S]*\}/ grabbed from first { to
// last } — wrong when response has text after the JSON object.
// ---------------------------------------------------------------------------

/**
 * Replicate the balanced brace JSON extraction logic from pattern-extractor.ts.
 * This is the exact algorithm used in extractPatternsFromSession().
 */
function extractJsonFromText(text: string): Record<string, unknown> | null {
  const startIdx = text.indexOf('{');
  if (startIdx === -1) return null;
  let depth = 0;
  let endIdx = -1;
  let inString = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) return null;
  return JSON.parse(text.substring(startIdx, endIdx + 1));
}

describe('Balanced JSON extraction (regression)', () => {
  it('handles braces inside JSON strings without premature termination', () => {
    const response = '{"msg": "this has { braces } inside", "count": 1}';
    const parsed = extractJsonFromText(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.msg).toBe('this has { braces } inside');
    expect(parsed!.count).toBe(1);
  });

  it('extracts JSON correctly when text follows after JSON object', () => {
    const response = 'Here is the result: {"patterns": [], "summary": "no corrections"}\n\nLet me know if you need more.';
    const parsed = extractJsonFromText(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe('no corrections');
    expect(Array.isArray(parsed!.patterns)).toBe(true);
  });

  it('handles nested objects correctly', () => {
    const response = '{"patterns": [{"trigger": "test", "inner": {"deep": true}}], "summary": "found"}';
    const parsed = extractJsonFromText(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe('found');
    const patterns = parsed!.patterns as Array<{ trigger: string; inner: { deep: boolean } }>;
    expect(patterns[0].trigger).toBe('test');
    expect(patterns[0].inner.deep).toBe(true);
  });

  it('handles escaped quotes inside strings', () => {
    const response = '{"msg": "She said \\"hello\\" and left", "ok": true}';
    const parsed = extractJsonFromText(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.ok).toBe(true);
  });

  it('returns null when no JSON object present', () => {
    const response = 'No JSON here, just plain text with no braces.';
    expect(extractJsonFromText(response)).toBeNull();
  });

  it('returns null for unbalanced braces', () => {
    const response = '{"patterns": [{"incomplete": true}';
    expect(extractJsonFromText(response)).toBeNull();
  });

  it('does not grab text between separate JSON objects (greedy regex bug)', () => {
    const response = '{"first": 1} some text {"second": 2}';
    const parsed = extractJsonFromText(response);
    expect(parsed).not.toBeNull();
    // Should only extract the FIRST JSON object, not span to the second
    expect(parsed!.first).toBe(1);
    expect(parsed!).not.toHaveProperty('second');
  });
});

// ---------------------------------------------------------------------------
// stripInjectedBlocks — Mem0 feedback loop defense
//
// Conversation turns capture full UserPromptSubmit prompts including the
// system-reminder / experience-data / file-content blocks that hooks inject.
// If those blocks reach the pattern-extractor LLM verbatim, it re-extracts
// patterns it just saw injected — score inflates via the dedup gate, and
// helpful_count exceeds times_triggered (the production smoking gun).
// stripInjectedBlocks runs before the LLM ever sees the text.
// ---------------------------------------------------------------------------

describe('stripInjectedBlocks (Mem0 feedback loop defense)', () => {
  it('returns empty string for null/undefined/empty input', () => {
    expect(stripInjectedBlocks(null)).toBe('');
    expect(stripInjectedBlocks(undefined)).toBe('');
    expect(stripInjectedBlocks('')).toBe('');
  });

  it('passes through clean text unchanged', () => {
    const clean = 'I want you to always run tests before committing.';
    expect(stripInjectedBlocks(clean)).toBe(clean);
  });

  it('strips a multi-line <experience-data> block while preserving real user content', () => {
    const input = [
      'Real user request: please fix the auth bug.',
      '<experience-data>',
      '## Past Experience — Relevant Patterns',
      '### Past pattern: never trust mocks',
      'Outcome learned: integration tests must hit real DB.',
      'Surfaced 426/303 times (100% helpful).',
      '</experience-data>',
      'And one more thing — keep the diff small.',
    ].join('\n');

    const out = stripInjectedBlocks(input);

    expect(out).toContain('Real user request: please fix the auth bug.');
    expect(out).toContain('And one more thing — keep the diff small.');
    expect(out).toContain('[injected:experience-data]');
    expect(out).not.toContain('Past pattern: never trust mocks');
    expect(out).not.toContain('Surfaced 426/303 times');
  });

  it('strips <system-reminder> blocks (the most common injection wrapper)', () => {
    const input = '<system-reminder>UserPromptSubmit hook additional context: ## Critical Reminders\n- Stop and verify before multi-file changes</system-reminder>\nlet me ship this';
    const out = stripInjectedBlocks(input);
    expect(out).toContain('let me ship this');
    expect(out).toContain('[injected:system-reminder]');
    expect(out).not.toContain('Critical Reminders');
    expect(out).not.toContain('Stop and verify');
  });

  it('strips <file-content> blocks (CLAUDE.md / project file inlines)', () => {
    const input = '<file-content source="CLAUDE.md">\n# Rules\nnever skip hooks\n</file-content>\n\nactual user message';
    const out = stripInjectedBlocks(input);
    expect(out).toContain('actual user message');
    expect(out).toContain('[injected:file-content]');
    expect(out).not.toContain('never skip hooks');
  });

  it('strips <task-notification>, <command-message>, <command-name> wrappers', () => {
    const input = [
      '<task-notification><task-id>abc</task-id><tool-use-id>x</tool-use-id></task-notification>',
      '<command-message>starthere</command-message>',
      '<command-name>/starthere</command-name>',
      'genuine user prompt here',
    ].join('\n');
    const out = stripInjectedBlocks(input);
    expect(out).toContain('genuine user prompt here');
    expect(out).toContain('[injected:task-notification]');
    expect(out).toContain('[injected:command-message]');
    expect(out).toContain('[injected:command-name]');
    expect(out).not.toContain('<task-id>');
  });

  it('strips multiple instances of the same wrapper independently', () => {
    const input = '<system-reminder>first</system-reminder>middle<system-reminder>second</system-reminder>end';
    const out = stripInjectedBlocks(input);
    expect(out).toBe('[injected:system-reminder]middle[injected:system-reminder]end');
  });

  it('handles wrapper tags with attributes', () => {
    const input = '<file-content source="path/to.md" type="md">body</file-content>after';
    const out = stripInjectedBlocks(input);
    expect(out).toBe('[injected:file-content]after');
  });

  it('is case-insensitive on tag names', () => {
    const input = '<System-Reminder>x</System-Reminder>okay';
    const out = stripInjectedBlocks(input);
    expect(out).toBe('[injected:system-reminder]okay');
  });

  it('does not strip directive keywords appearing in clean text', () => {
    // Directive scanner relies on keywords like "always", "never", "from now on"
    // — those must survive when the user genuinely types them outside any wrapper.
    const input = 'from now on, always commit before pushing. never use --no-verify.';
    expect(stripInjectedBlocks(input)).toBe(input);
  });

  it('prevents directive false positives from injected experience-data', () => {
    // The Mem0 failure mode: an experience-data block contains "always X"; the
    // directive pre-scanner sees "always" and flags this turn as a candidate;
    // the LLM then "extracts" the pattern that was already in storage.
    const input = '<experience-data>### Past pattern: always run tests\nOutcome: catches regressions</experience-data>\nthe user actually said: hi how are you';
    const out = stripInjectedBlocks(input);
    expect(out.toLowerCase().includes('always run tests')).toBe(false);
    expect(out).toContain('hi how are you');
  });
});

describe('Angel Pattern Extractor', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  describe('getSessionTurns', () => {
    it('returns empty array for non-existent session', () => {
      expect(getSessionTurns(db, 'nonexistent')).toEqual([]);
    });

    it('returns turns ordered by turn_number', () => {
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text) VALUES (?, ?, ?, ?, ?)`
      ).run('s1', 'proj', 2, 'second user msg', 'second assistant msg');
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text) VALUES (?, ?, ?, ?, ?)`
      ).run('s1', 'proj', 1, 'first user msg', 'first assistant msg');

      const turns = getSessionTurns(db, 's1');
      expect(turns.length).toBe(2);
      expect(turns[0].turn_number).toBe(1);
      expect(turns[0].user_text).toBe('first user msg');
      expect(turns[1].turn_number).toBe(2);
    });

    it('returns only turns for the requested session', () => {
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text) VALUES (?, ?, ?, ?)`
      ).run('s1', 'proj', 1, 'session 1');
      db.prepare(
        `INSERT INTO conversation_turns (session_id, project, turn_number, user_text) VALUES (?, ?, ?, ?)`
      ).run('s2', 'proj', 1, 'session 2');

      const turns = getSessionTurns(db, 's1');
      expect(turns.length).toBe(1);
      expect(turns[0].user_text).toBe('session 1');
    });
  });
});
