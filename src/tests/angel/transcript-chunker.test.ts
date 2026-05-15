/**
 * Unit tests for the transcript chunker (Plan 04-02).
 *
 * Mocks `callLocalLLM` via `vi.mock` — mirrors the directive-detector test
 * pattern. All DB work uses an in-memory SQLite with legacy `conversation_turns`
 * (from `initializeSchema`) plus V17 DDL for the unified `artifact` table.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';

// ── Mocks (must be declared BEFORE the module under test is imported) ─────
const mockCallLocalLLM = vi.fn<(opts: unknown) => Promise<string>>();

vi.mock('../../angel/llama-client.js', () => ({
  callLocalLLM: (opts: unknown) => mockCallLocalLLM(opts),
}));

// NOTE: import after vi.mock so ESM hoists the mock ahead of the import.
import { chunkSessionTranscript } from '../../angel/transcript-chunker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDb(): { db: TestDatabase; sessionId: string; project: string } {
  const ctx = createTestDbWithSession('tc-sess-1', 'tc-proj');
  applyV17DDL(ctx.db);
  return ctx;
}

function insertTurn(
  db: TestDatabase,
  sessionId: string,
  project: string,
  turnNumber: number,
  userText: string | null,
  assistantText: string | null = null,
): void {
  db.prepare(
    `INSERT INTO conversation_turns(session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, project, turnNumber, userText, assistantText, 1000 + turnNumber);
}

function insertTurns(
  db: TestDatabase,
  sessionId: string,
  project: string,
  count: number,
): void {
  for (let i = 1; i <= count; i++) {
    insertTurn(db, sessionId, project, i, `user ${i}`, `assistant ${i}`);
  }
}

interface ChunkRow {
  id: string;
  kind: string;
  title: string | null;
  body: string;
  data: string;
  session_id: string | null;
  project: string | null;
  embedding_ref: number | null;
  created_at_epoch_ms: number;
}

function listChunks(db: TestDatabase, sessionId: string): ChunkRow[] {
  return db
    .prepare(
      `SELECT id, kind, title, body, data, session_id, project, embedding_ref, created_at_epoch_ms
         FROM artifact
        WHERE kind = 'transcript_chunk' AND session_id = ?
        ORDER BY json_extract(data, '$.turn_range[0]') ASC`,
    )
    .all(sessionId) as ChunkRow[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chunkSessionTranscript', () => {
  let db: TestDatabase;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    const ctx = setupDb();
    db = ctx.db;
    sessionId = ctx.sessionId;
    project = ctx.project;
    mockCallLocalLLM.mockReset();
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('case 1: empty session returns skipped=empty_session', async () => {
    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r).toEqual({ inserted: 0, skipped: 'empty_session', errors: 0 });
    expect(mockCallLocalLLM).not.toHaveBeenCalled();
    expect(listChunks(db, sessionId)).toHaveLength(0);
  });

  it('case 2: already-chunked returns skipped=already_chunked', async () => {
    // Pre-insert one transcript_chunk for the session.
    db.prepare(
      `INSERT INTO artifact(
         id, kind, title, body, scope, status, confidence,
         created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
       ) VALUES ('pre', 'transcript_chunk', 'seed', 'pre-body', NULL, 'active', NULL,
                 1000, 1000, ?, ?, '{}')`,
    ).run(sessionId, project);
    insertTurns(db, sessionId, project, 5);

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r).toEqual({ inserted: 0, skipped: 'already_chunked', errors: 0 });
    expect(mockCallLocalLLM).not.toHaveBeenCalled();
    // Only the pre-seeded row remains.
    expect(listChunks(db, sessionId)).toHaveLength(1);
  });

  it('case 3: single turn bypasses LLM with session- label', async () => {
    insertTurn(db, sessionId, project, 1, 'hello', 'world');

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.skipped).toBeNull();
    expect(r.errors).toBe(0);
    expect(r.inserted).toBe(1);
    expect(mockCallLocalLLM).not.toHaveBeenCalled();

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toMatch(/^session-/);
    const data = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    expect(data.turn_range).toEqual([1, 1]);
    expect(data.topic_label).toMatch(/^session-/);
  });

  it('case 4: 3 turns + LLM one segment yields one chunk with kind_registry row', async () => {
    insertTurns(db, sessionId, project, 3);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [{ start: 1, end: 3, topic_label: 'setup' }],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r).toEqual({ inserted: 1, skipped: null, errors: 0 });

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe('setup');
    expect(chunks[0].embedding_ref).toBeNull();
    expect(chunks[0].session_id).toBe(sessionId);
    expect(chunks[0].project).toBe(project);
    const data = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    expect(data.turn_range).toEqual([1, 3]);
    expect(data.topic_label).toBe('setup');

    // kind_registry populated via V17 AFTER-INSERT trigger.
    const reg = db.prepare(`SELECT kind FROM kind_registry WHERE kind='transcript_chunk'`).get();
    expect(reg).toBeTruthy();
  });

  it('case 5: 30 turns + two segments satisfy coverage invariant', async () => {
    insertTurns(db, sessionId, project, 30);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [
        { start: 1, end: 15, topic_label: 'a' },
        { start: 16, end: 30, topic_label: 'b' },
      ],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r).toEqual({ inserted: 2, skipped: null, errors: 0 });

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(2);

    const d0 = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    const d1 = JSON.parse(chunks[1].data) as { turn_range: number[]; topic_label: string };
    expect(d0.turn_range).toEqual([1, 15]);
    expect(d1.turn_range).toEqual([16, 30]);
    // Coverage invariant: gap-free, full range.
    expect(d0.turn_range[0]).toBe(1);
    expect(d1.turn_range[1]).toBe(30);
    expect(d0.turn_range[1] + 1).toBe(d1.turn_range[0]);
  });

  it('case 6: too-small first segment merges into successor keeping successor label', async () => {
    insertTurns(db, sessionId, project, 10);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [
        { start: 1, end: 2, topic_label: 'tiny' },
        { start: 3, end: 10, topic_label: 'main' },
      ],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r).toEqual({ inserted: 1, skipped: null, errors: 0 });

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(1);
    const data = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    expect(data.turn_range).toEqual([1, 10]);
    // First-segment below soft-min merges INTO successor → label from segment 2.
    expect(data.topic_label).toBe('main');
    expect(chunks[0].title).toBe('main');
  });

  it('case 7: oversize segment splits with (cont.) suffix on continuations', async () => {
    insertTurns(db, sessionId, project, 60);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [{ start: 1, end: 60, topic_label: 'huge' }],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r).toEqual({ inserted: 2, skipped: null, errors: 0 });

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(2);

    const d0 = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    const d1 = JSON.parse(chunks[1].data) as { turn_range: number[]; topic_label: string };
    expect(d0.turn_range).toEqual([1, 30]);
    expect(d1.turn_range).toEqual([31, 60]);
    expect(d0.topic_label).toBe('huge');
    expect(d1.topic_label).toBe('huge (cont.)');
  });

  it('case 8: LLM throws → fallback single chunk, errors=1', async () => {
    insertTurns(db, sessionId, project, 5);
    mockCallLocalLLM.mockRejectedValueOnce(new Error('timeout'));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBeNull();
    expect(r.errors).toBe(1);

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(1);
    const data = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    expect(data.turn_range).toEqual([1, 5]);
    expect(data.topic_label).toMatch(/^session-/);
  });

  it('case 9: LLM returns malformed JSON → fallback single chunk, errors=0', async () => {
    insertTurns(db, sessionId, project, 5);
    mockCallLocalLLM.mockResolvedValueOnce('not json');

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBeNull();
    expect(r.errors).toBe(0);

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(1);
    const data = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    expect(data.topic_label).toMatch(/^session-/);
  });

  it('case 10: LLM returns shape-invalid (gap) → fallback single chunk, errors=0', async () => {
    insertTurns(db, sessionId, project, 10);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [
        { start: 1, end: 3, topic_label: 'a' },
        { start: 5, end: 10, topic_label: 'b' }, // gap at turn 4
      ],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBeNull();
    expect(r.errors).toBe(0);

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(1);
    const data = JSON.parse(chunks[0].data) as { turn_range: number[]; topic_label: string };
    expect(data.turn_range).toEqual([1, 10]);
    expect(data.topic_label).toMatch(/^session-/);
  });

  it('case 11: full turn texts preserved verbatim in chunk body, joined with \\n\\n', async () => {
    const distinct: Array<[string, string]> = [
      ['user-one',   'asst-one'],
      ['user-two',   'asst-two'],
      ['user-three', 'asst-three'],
      ['user-four',  'asst-four'],
      ['user-five',  'asst-five'],
    ];
    for (let i = 0; i < 5; i++) {
      insertTurn(db, sessionId, project, i + 1, distinct[i][0], distinct[i][1]);
    }
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [{ start: 1, end: 5, topic_label: 'whole' }],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(1);

    const chunks = listChunks(db, sessionId);
    expect(chunks).toHaveLength(1);
    const body = chunks[0].body;
    for (const [u, a] of distinct) {
      expect(body).toContain(u);
      expect(body).toContain(a);
    }
    // Expected shape: `u1\na1\n\nu2\na2\n\n...`.
    const expected = distinct.map(([u, a]) => `${u}\n${a}`).join('\n\n');
    expect(body).toBe(expected);
  });
});
