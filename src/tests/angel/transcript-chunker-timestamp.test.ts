/**
 * Regression tests for Phase 4.1 CUR-14 timestamp-precision lock.
 *
 * conversation_turns.timestamp_epoch is unixepoch() (10-digit seconds).
 * Phase 4.1 locks artifact.created_at_epoch as ms-precision (13-digit).
 * The transcript_chunker writer must upscale by * 1000 at insert time.
 *
 * Without the fix, transcript_chunk rows carry seconds-precision values
 * which silently misorder against ms-precision peers in recency-weighted
 * retrieval paths.
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
  baseEpochSec: number,
): void {
  for (let i = 1; i <= count; i++) {
    db.prepare(
      `INSERT INTO conversation_turns(session_id, project, turn_number, user_text, assistant_text, timestamp_epoch)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, project, i, `user ${i}`, `assistant ${i}`, baseEpochSec + i);
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

  it('writes ms-precision created_at_epoch (>= 1e12) on new chunks', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    insertTurnsWithTs(db, sessionId, project, 3, nowSec);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [{ start: 1, end: 3, topic_label: 'now' }],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBeGreaterThan(0);

    const rows = db.prepare(
      `SELECT created_at_epoch FROM artifact WHERE kind='transcript_chunk' AND session_id = ?`,
    ).all(sessionId) as Array<{ created_at_epoch: number }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // ms-precision lower bound: any time after 2001-09-09 is >= 1e12.
      expect(row.created_at_epoch).toBeGreaterThanOrEqual(1e12);
      // Upper sanity bound: turns are inserted at nowSec+1..+3 seconds; the
      // chunker uses the LAST turn's timestamp_epoch * 1000 — allow a 10s
      // window past Date.now() to cover turn insertion offsets.
      expect(row.created_at_epoch).toBeLessThanOrEqual(Date.now() + 10_000);
    }
  });

  it('matches expected upscale factor (1000) for known input timestamps', async () => {
    const fixedSec = 1745923400; // a known seconds-precision value (~2025)
    insertTurnsWithTs(db, sessionId, project, 3, fixedSec);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [{ start: 1, end: 3, topic_label: 'fixed' }],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(1);

    const row = db.prepare(
      `SELECT created_at_epoch FROM artifact WHERE kind='transcript_chunk' AND session_id = ?`,
    ).get(sessionId) as { created_at_epoch: number };

    // The chunker uses the LAST in-segment turn's timestamp_epoch.
    // For 3 turns starting at fixedSec+1, last is fixedSec+3.
    expect(row.created_at_epoch).toBe((fixedSec + 3) * 1000);
  });

  it('multi-segment chunks all carry ms-precision timestamps', async () => {
    const baseSec = 1700000000;
    insertTurnsWithTs(db, sessionId, project, 30, baseSec);
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      segments: [
        { start: 1, end: 15, topic_label: 'a' },
        { start: 16, end: 30, topic_label: 'b' },
      ],
    }));

    const r = await chunkSessionTranscript(db, sessionId, project);
    expect(r.inserted).toBe(2);

    const rows = db.prepare(
      `SELECT created_at_epoch FROM artifact WHERE kind='transcript_chunk' AND session_id = ? ORDER BY created_at_epoch ASC`,
    ).all(sessionId) as Array<{ created_at_epoch: number }>;

    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.created_at_epoch).toBeGreaterThanOrEqual(1e12);
    }
    // Segment a ends at turn 15, so created_at_epoch = (baseSec + 15) * 1000
    expect(rows[0].created_at_epoch).toBe((baseSec + 15) * 1000);
    // Segment b ends at turn 30, so created_at_epoch = (baseSec + 30) * 1000
    expect(rows[1].created_at_epoch).toBe((baseSec + 30) * 1000);
  });
});
