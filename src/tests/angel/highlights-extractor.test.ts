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
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { migrateV37toV38 } from '../../core/migration-steps.js';
// Phase 14 Plan 14-00 (2026-05-15): the Opus path is now gated by either
// a test hook or the ANTHROPIC_API_KEY env var. Tests that exercise the
// Opus path set _setOpusCallableForTest, which opens the gate. Tests for
// the env-var-unset behavior verify ANTHROPIC_API_KEY is unset and that
// no Opus call is attempted.
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
  timestamp_epoch_ms INTEGER DEFAULT (strftime('%s','now'))
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
  let savedApiKey: string | undefined;

  beforeEach(() => {
    db = makeDb();
    _setOpusCallableForTest(null);
    _setFallbackCallableForTest(null);
    // Phase 14 Plan 14-00: protect tests from the host environment having
    // ANTHROPIC_API_KEY set. Each test that needs Opus opens the gate via
    // the test hook explicitly; tests that need env-var-unset behavior
    // delete it explicitly. Save and restore so we don't leak across tests.
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    _setOpusCallableForTest(null);
    _setFallbackCallableForTest(null);
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
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

  // ---------------------------------------------------------------------------
  // Phase 14 Plan 14-00 (2026-05-15) — API-key-gated Opus path.
  // RCA-2 found that the original OAuth path returned HTTP 429 globally.
  // The new contract: Opus is opt-in via ANTHROPIC_API_KEY; default path
  // is local-LLM-as-primary with degraded=0 on success.
  // ---------------------------------------------------------------------------

  it('env-var-unset: skips Opus, calls local LLM as primary, degraded=false', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      let opusCalled = false;
      _setOpusCallableForTest(async () => {
        opusCalled = true;
        return { mental_model: 'opus should NOT be called' };
      });
      // Note: opusCallableForTest is set, which opens the gate — to test
      // the env-var-unset shortcut we instead clear the test hook AND keep
      // the env var unset.
      _setOpusCallableForTest(null);
      _setFallbackCallableForTest(async () => ({
        mental_model: 'local LLM is primary',
        open_questions: [],
        reframes: [],
        tools_introduced: [],
        decisions_not_made: [],
      }));

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir,
        config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row).not.toBeNull();
      expect(row?.degraded).toBe(false);
      expect(row?.degraded_reason).toBeUndefined();
      expect(row?.mental_model).toBe('local LLM is primary');
      expect(opusCalled).toBe(false);

      // No telemetry row — local-as-primary success is not a "fallback"
      const tel = db.prepare(`SELECT * FROM telemetry WHERE event_kind='frame_extraction_fallback'`).all();
      expect(tel).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('env-var-set-empty: treated as unset (local LLM primary path)', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      process.env.ANTHROPIC_API_KEY = '';
      _setFallbackCallableForTest(async () => ({
        mental_model: 'local primary on empty env var',
      }));

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir,
        config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row).not.toBeNull();
      expect(row?.degraded).toBe(false);
      expect(row?.mental_model).toBe('local primary on empty env var');
    } finally {
      cleanup();
    }
  });

  it('env-var-set-whitespace: trimmed to empty, treated as unset', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      process.env.ANTHROPIC_API_KEY = '   ';
      _setFallbackCallableForTest(async () => ({
        mental_model: 'whitespace key is empty after trim',
      }));

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir,
        config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row?.degraded).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('opus 429 captured in telemetry detail.http_status', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      _setOpusCallableForTest(async () => {
        const err: Error & { degradedReason?: string; httpStatus?: number } = new Error('HTTP 429');
        err.degradedReason = 'opus_non_2xx';
        err.httpStatus = 429;
        throw err;
      });
      _setFallbackCallableForTest(async () => ({
        mental_model: 'fallback after 429',
      }));

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir,
        config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const tel = db.prepare(`SELECT detail FROM telemetry WHERE event_kind='frame_extraction_fallback'`).all() as Array<{ detail: string }>;
      expect(tel).toHaveLength(1);
      const det = JSON.parse(tel[0].detail);
      expect(det.reason).toBe('opus_non_2xx');
      expect(det.http_status).toBe(429);
      expect(det.fallback_model).toBe('glm-5.1:cloud');

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row?.degraded).toBe(true);
      expect(row?.degraded_reason).toBe('opus_non_2xx');
      expect(row?.mental_model).toBe('fallback after 429');
    } finally {
      cleanup();
    }
  });

  it('opus error without httpStatus omits the field from telemetry', async () => {
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      _setOpusCallableForTest(async () => {
        const err: Error & { degradedReason?: string } = new Error('Timeout');
        err.degradedReason = 'opus_timeout';
        throw err;
      });
      _setFallbackCallableForTest(async () => ({ mental_model: 'fallback' }));

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir,
        config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const tel = db.prepare(`SELECT detail FROM telemetry WHERE event_kind='frame_extraction_fallback'`).all() as Array<{ detail: string }>;
      expect(tel).toHaveLength(1);
      const det = JSON.parse(tel[0].detail);
      expect(det.reason).toBe('opus_timeout');
      expect(det).not.toHaveProperty('http_status');
    } finally {
      cleanup();
    }
  });

  it('local-as-primary failure: degraded=true with local_llm_failed reason', async () => {
    // env var unset → local is primary → if local fails, we have nowhere to go.
    // Should produce a degraded row with the new local_llm_failed reason
    // AND a telemetry row (so substrate health surface can flag it).
    const { projectDir, sessionId, cleanup } = makeTmpProject();
    try {
      _setFallbackCallableForTest(async () => {
        throw new Error('Ollama down');
      });

      await extractHighlightsForSession({
        db, sessionId, project: 'p1', projectDir,
        config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      const row = getHighlightsBySessionId(db, sessionId, 'p1');
      expect(row).not.toBeNull();
      expect(row?.degraded).toBe(true);
      expect(row?.degraded_reason).toBe('local_llm_failed');
      expect(row?.degraded_model).toBe('glm-5.1:cloud');
      expect(row?.mental_model).toBeUndefined();

      // Telemetry: surface the failure with reason='local_llm_failed'
      const tel = db.prepare(`SELECT detail FROM telemetry WHERE event_kind='frame_extraction_fallback'`).all() as Array<{ detail: string }>;
      expect(tel).toHaveLength(1);
      const det = JSON.parse(tel[0].detail);
      expect(det.reason).toBe('local_llm_failed');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 14-07d extracted_from soft-link emission
// ---------------------------------------------------------------------------

function buildV38HighlightsDb(): DatabaseType {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyV17DDL(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
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
      timestamp_epoch_ms INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
  `);
  migrateV37toV38(db);
  return db;
}

function makeTmpProjectForV38(): { projectDir: string; sessionId: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-extractor-v38-'));
  const sessionId = 'v38-session-' + Math.random().toString(36).slice(2, 8);
  const sessDir = path.join(tmp, 'Sessions');
  fs.mkdirSync(sessDir);
  fs.writeFileSync(
    path.join(sessDir, `2026-05-17_${sessionId}.md`),
    `## User\n_2026-05-17T10:00:00+02:00_\n\nHow does the link graph work?\n\n## Assistant\n_2026-05-17T10:00:05+02:00_\n\nSoft links commit autonomously; hard links require operator confirmation.\n`,
    'utf8',
  );
  return {
    projectDir: tmp,
    sessionId,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('Phase 14-07d extracted_from emission', () => {
  let savedApiKey07d: string | undefined;

  beforeEach(() => {
    _setOpusCallableForTest(null);
    _setFallbackCallableForTest(null);
    savedApiKey07d = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    _setOpusCallableForTest(null);
    _setFallbackCallableForTest(null);
    if (savedApiKey07d === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey07d;
  });

  it('successful extraction with N highlights: extracted_from soft_link emitted (when artifacts exist)', async () => {
    const db = buildV38HighlightsDb();
    const { projectDir, sessionId, cleanup } = makeTmpProjectForV38();
    try {
      _setFallbackCallableForTest(async () => ({
        mental_model: 'soft-link graph is the new substrate',
        open_questions: [{ question: 'is BGE reranker healthy?', context: 'Angel logs' }],
        reframes: [],
        tools_introduced: [],
        decisions_not_made: [],
      }));

      // Pre-seed V17 artifact rows so the extracted_from link can be emitted.
      db.prepare(
        `INSERT INTO artifact(id, kind, session_id, project, body, created_at_epoch_ms, updated_at_epoch_ms)
         VALUES ('highlight-v38-001', 'session_highlight', ?, 'p1', 'highlight body', ?, ?)`
      ).run(sessionId, Date.now(), Date.now());
      db.prepare(
        `INSERT INTO artifact(id, kind, session_id, project, body, created_at_epoch_ms, updated_at_epoch_ms)
         VALUES ('session-log-v38-001', 'session_log', ?, 'p1', 'session log body', ?, ?)`
      ).run(sessionId, Date.now(), Date.now());

      await extractHighlightsForSession({
        db: db as unknown as DatabaseType, sessionId, project: 'p1', projectDir, config: DEFAULT_ANGEL_CONFIG,
      });

      // Verify the extraction succeeded (not degraded)
      const row = getHighlightsBySessionId(db as unknown as DatabaseType, sessionId, 'p1');
      expect(row?.degraded).toBe(false);

      // Verify extracted_from soft_link was emitted
      const links = db.prepare(
        `SELECT type, src_artifact_id, dst_artifact_id FROM soft_link WHERE type = 'extracted_from'`
      ).all() as Array<{ type: string; src_artifact_id: string; dst_artifact_id: string }>;

      expect(links).toHaveLength(1);
      expect(links[0].src_artifact_id).toBe('highlight-v38-001');
      expect(links[0].dst_artifact_id).toBe('session-log-v38-001');
    } finally {
      cleanup();
      db.close();
    }
  });

  it('degraded extraction: no soft_links emitted', async () => {
    const db = buildV38HighlightsDb();
    const { projectDir, sessionId, cleanup } = makeTmpProjectForV38();
    try {
      // Both LLM paths fail → degraded=true, empty result
      _setFallbackCallableForTest(async () => {
        throw new Error('local LLM down in 07d test');
      });

      await extractHighlightsForSession({
        db: db as unknown as DatabaseType, sessionId, project: 'p1', projectDir,
        config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'glm-5.1:cloud' },
      });

      // Verify degraded=true
      const row = getHighlightsBySessionId(db as unknown as DatabaseType, sessionId, 'p1');
      expect(row?.degraded).toBe(true);

      // No soft_link rows — degraded extraction produces no links
      const linkCount = (db.prepare(`SELECT COUNT(*) AS n FROM soft_link`).get() as { n: number }).n;
      expect(linkCount).toBe(0);
    } finally {
      cleanup();
      db.close();
    }
  });
});
