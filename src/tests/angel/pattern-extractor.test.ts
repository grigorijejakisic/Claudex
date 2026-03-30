import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { getSessionTurns } from '../../angel/pattern-extractor.js';

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
