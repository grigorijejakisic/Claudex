/**
 * Regression tests for V35 CUR-14 timestamp-precision lock.
 *
 * conversation_turns.timestamp_epoch_ms stores milliseconds (V35 migration).
 * artifact.created_at_epoch_ms is also ms-precision (13-digit).
 * The transcript_chunker writer stores the turn's timestamp directly.
 *
 * Test fixtures insert ms-precision values into timestamp_epoch_ms and verify
 * that artifact.created_at_epoch_ms reflects the same ms values.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';

const mockCallLocalLLM = vi.fn<(opts: unknown) => Promise<string>>();

vi.mock('../../angel/llama-client.js', () => ({
  callLocalLLM: (opts: unknown) => mockCallLocalLLM(opts),
}));

import { chunkSessionTranscript } from '../../angel/transcript-chunker.js';

function setupDb(): { db: TestDatabase; sessionId: string; project: string } {
  const ctx = createTestDbWithSession('tc-ts-sess', 'tc-ts-proj');
  applyV17DDL(ctx.db);
  return ctx;
}

function insertTurnsWithTs(
  db: TestDatabase,
  sessionId: string,
  project: string,
  count: number,
  baseEpochMs: number,
): void {
  for (let i = 1; i <= count; i++) {
    db.prepare(
      `INSERT INTO conversation_turns(session_id, project, turn_number, user_text, assistant_text, timestamp_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, project, i, `user ${i}`, `assistant ${i}`, baseEpochMs + i);
  }
}

describe('transcript-chunker timestamp precision (CUR-14)', () => {
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

  it('writes ms-precision created_at_epoch_ms (>= 1e12) on new chunks', async () => {
    const nowMs = Date.now();
    insertTurnsWithTs(db, sessionId, project, 3, nowMs);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [{ start: 1, end: 3, topic_label: 'now' }],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBeGreaterThan(0);

    const rows = db.prepare(
      `SELECT created_at_epoch_ms FROM artifact WHERE kind='transcript_chunk' AND session_id = ?`,
    ).all(sessionId) as Array<{ created_at_epoch_ms: number }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // ms-precision lower bound: any time after 2001-09-09 is >= 1e12.
      expect(row.created_at_epoch_ms).toBeGreaterThanOrEqual(1e12);
      // Upper sanity bound: allow a 10s window past nowMs to cover turn insertion offsets.
      expect(row.created_at_epoch_ms).toBeLessThanOrEqual(nowMs + 10_000);
    }
  });

  it('matches expected upscale factor (1000) for known input timestamps', async () => {
    const fixedMs = 1745923400 * 1000; // ms-precision: a known value (~2025)
    insertTurnsWithTs(db, sessionId, project, 3, fixedMs);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [{ start: 1, end: 3, topic_label: 'fixed' }],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(1);

    const row = db.prepare(
      `SELECT created_at_epoch_ms FROM artifact WHERE kind='transcript_chunk' AND session_id = ?`,
    ).get(sessionId) as { created_at_epoch_ms: number };

    // The chunker uses the LAST in-segment turn's timestamp_epoch_ms directly.
    // For 3 turns starting at fixedMs+1, last is fixedMs+3.
    expect(row.created_at_epoch_ms).toBe(fixedMs + 3);
  });

  it('multi-segment chunks all carry ms-precision timestamps', async () => {
    const baseMs = 1700000000 * 1000; // ms-precision
    insertTurnsWithTs(db, sessionId, project, 30, baseMs);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [
        { start: 1, end: 15, topic_label: 'a' },
        { start: 16, end: 30, topic_label: 'b' },
      ],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(2);

    const rows = db.prepare(
      `SELECT created_at_epoch_ms FROM artifact WHERE kind='transcript_chunk' AND session_id = ? ORDER BY created_at_epoch_ms ASC`,
    ).all(sessionId) as Array<{ created_at_epoch_ms: number }>;

    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.created_at_epoch_ms).toBeGreaterThanOrEqual(1e12);
    }
    // Segment a ends at turn 15: created_at_epoch_ms = baseMs + 15
    expect(rows[0].created_at_epoch_ms).toBe(baseMs + 15);
    // Segment b ends at turn 30: created_at_epoch_ms = baseMs + 30
    expect(rows[1].created_at_epoch_ms).toBe(baseMs + 30);
  });
});
