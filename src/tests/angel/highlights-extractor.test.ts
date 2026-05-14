/**
 * Phase 13 Plan 03: highlights-extractor degraded-flag discipline tests.
 *
 * Mocks both the Opus OAuth callable and the local-LLM fallback via the
 * exported _setOpusCallableForTest / _setFallbackCallableForTest hooks.
 * Tests the three load-bearing paths:
 *   1. Opus succeeds → degraded=false, parsed fields land in DB
 *   2. Opus times out, fallback succeeds → degraded=true, opus_timeout reason, fallback model recorded
 *   3. Both fail → degraded=true, minimal row written (session doesn't stay pending forever)
 *
 * Sessions/ markdown is written to a tmp dir to mirror the real path the
 * extractor reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  extractHighlightsForSession,
  _setOpusCallableForTest,
  _setFallbackCallableForTest,
} from '../../angel/highlights-extractor.js';
import { getHighlightsBySessionId } from '../../intelligence/session-highlights.js';
import { DEFAULT_ANGEL_CONFIG } from '../../angel/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, project TEXT NOT NULL,
  mental_model TEXT, open_questions TEXT, reframes TEXT,
  tools_introduced TEXT, decisions_not_made TEXT, posture_context TEXT,
  degraded INTEGER NOT NULL DEFAULT 0, degraded_reason TEXT, degraded_model TEXT,
  created_at_epoch_ms INTEGER NOT NULL, re_extracted_at_epoch_ms INTEGER,
  UNIQUE(session_id, project)
);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, event_kind TEXT, detail TEXT,
  latency_ms INTEGER, adapter TEXT,
  timestamp_epoch INTEGER DEFAULT (strftime('%s','now'))
);
`;

function makeDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function makeTmpProject(): { projectDir: string; sessionId: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-extractor-test-'));
  const sessionId = 'test-session-' + Math.random().toString(36).slice(2, 8);
  const sessDir = path.join(tmp, 'Sessions');
  fs.mkdirSync(sessDir);
  fs.writeFileSync(
    path.join(sessDir, `2026-05-14_${sessionId}.md`),
    `## User\n_2026-05-14T10:00:00+02:00_\n\nHow does the indexer work?\n\n## Assistant\n_2026-05-14T10:00:05+02:00_\n\nThe Angel heartbeat re-indexes Sessions/ markdown.\n`,
    'utf8',
  );
  return {
    projectDir: tmp,
    sessionId,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('extractHighlightsForSession — degraded-flag discipline', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = makeDb();
    _setOpusCallableForTest(null);
    _setFallbackCallableForTest(null);
  });

  afterEach(() => {
    _setOpusCallableForTest(null);
    _setFallbackCallableForTest(null);
    db.close();
  });

  it('Opus success path: degraded=false, fields land in DB', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      _setOpusCallableForTest(async () => ({
        mental_model: 'sessions-indexer is the recovery path',
        open_questions: [{ question: 'mtime-skip race?', context: 'discussed' }],
        reframes: [],
        tools_introduced: [{ path: 'src/angel/sessions-indexer.ts', purpose: 'index Sessions/' }],
        decisions_not_made: [],
        posture_context: 'energized',
      }));

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir, config: DEFAULT_ANGEL_CONFIG,
      });

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row).not.toBeNull();
      expect(row?.degraded).toBe(false);
      expect(row?.mental_model).toBe('sessions-indexer is the recovery path');
      expect(row?.tools_introduced?.[0].path).toBe('src/angel/sessions-indexer.ts');
    } finally {
      cleanup();
    }
  });

  it('Opus timeout + fallback success: degraded=true, opus_timeout reason, fallback model recorded', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      _setOpusCallableForTest(async () => {
        const err: Error & { degradedReason?: string } = new Error('Timeout');
        err.degradedReason = 'opus_timeout';
        throw err;
      });
      _setFallbackCallableForTest(async () => ({
        mental_model: 'fallback model says: indexer is the recovery path',
        open_questions: [],
        reframes: [],
        tools_introduced: [],
        decisions_not_made: [],
      }));

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir, config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row).not.toBeNull();
      expect(row?.degraded).toBe(true);
      expect(row?.degraded_reason).toBe('opus_timeout');
      expect(row?.degraded_model).toBe('glm-5.1:cloud');
      expect(row?.mental_model).toContain('fallback model');

      // Telemetry row written
      const tel = db.prepare(`SELECT event_kind, detail FROM telemetry WHERE event_kind = 'frame_extraction_fallback'`).all() as Array<{ event_kind: string; detail: string }>;
      expect(tel).toHaveLength(1);
      const det = JSON.parse(tel[0].detail);
      expect(det.reason).toBe('opus_timeout');
      expect(det.fallback_model).toBe('glm-5.1:cloud');
    } finally {
      cleanup();
    }
  });

  it('Both fail: degraded=true, minimal row written, session no longer pending forever', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      _setOpusCallableForTest(async () => {
        const err: Error & { degradedReason?: string } = new Error('No creds');
        err.degradedReason = 'opus_auth_failed';
        throw err;
      });
      _setFallbackCallableForTest(async () => {
        throw new Error('local LLM down');
      });

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir, config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row).not.toBeNull();
      expect(row?.degraded).toBe(true);
      expect(row?.degraded_reason).toBe('opus_auth_failed');
      // Minimal row — no fields populated, but row exists so pending-sweep
      // surfaces it (degraded=1) on the next tick rather than re-extracting blindly
      expect(row?.mental_model).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('no Sessions/ file for the session: extractor returns without writing a row', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-extractor-empty-'));
    try {
      // Sessions/ dir does not exist — extractor returns gracefully
      await extractHighlightsForSession({
        db, sessionId: 'no-file-session', project: 'p1', projectDir: tmp, config: DEFAULT_ANGEL_CONFIG,
      });
      const row = getHighlightsBySessionId(db, 'no-file-session', 'p1');
      expect(row).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('empty Sessions/ markdown: extractor returns without writing a row', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-extractor-empty-md-'));
    try {
      const sid = 'empty-md-session';
      const sessDir = path.join(tmp, 'Sessions');
      fs.mkdirSync(sessDir);
      fs.writeFileSync(path.join(sessDir, `2026-05-14_${sid}.md`), '   \n  \n', 'utf8');

      await extractHighlightsForSession({
        db, sessionId: sid, project: 'p1', projectDir: tmp, config: DEFAULT_ANGEL_CONFIG,
      });
      const row = getHighlightsBySessionId(db, sid, 'p1');
      expect(row).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
