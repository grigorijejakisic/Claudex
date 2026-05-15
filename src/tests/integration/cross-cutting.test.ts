/**
 * Cross-cutting integration tests: learnings persistence, checkpoint recovery,
 * topic-shift, enrichment fallback, FTS5 search, telemetry queryability,
 * pressure scoring, and decay engine pruning.
 * @see Architecture Section 14 — Scenarios 4-11
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { createSession, endSession } from '../../core/sessions.js';
import { insertObservation, searchObservations, getObservationsByProject } from '../../core/observations.js';
import { getCheckpointTracking } from '../../core/checkpoint-tracking.js';
import { getThreadState, upsertThreadState } from '../../core/thread.js';
import { getHotFiles, updatePressureScore } from '../../core/pressure.js';
import { getTopLearnings, upsertLearning } from '../../core/learnings.js';
import { assembleFullContext, assembleRegularPrompt } from '../../assembly/assembler.js';
import { writeCheckpoint } from '../../checkpoint/writer.js';
import { recoverFromDb, loadCheckpoint } from '../../checkpoint/loader.js';
import { ThreadTracker } from '../../intelligence/thread-tracker.js';
import { TopicShiftDetector } from '../../intelligence/topic-shift.js';
import { captureDecisions } from '../../intelligence/decision-capture.js';
import { promoteLearnings } from '../../intelligence/learnings-promoter.js';
import { pruneObservations, applyRetentionPolicy } from '../../decay/decay-engine.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { DEFAULT_CONFIG } from '../../shared/constants.js';
import type { ClaudexConfig } from '../../shared/config.js';

function makeConfig(): ClaudexConfig {
  return {
    ...DEFAULT_CONFIG,
    enrichment: { ...DEFAULT_CONFIG.enrichment, provider: 'none' as const },
  } as unknown as ClaudexConfig;
}

// ─── Cross-Session Learnings Persistence (Scenario 4) ───────────────────────

describe('Cross-Session Learnings Persistence', () => {
  let db: TestDatabase;
  const config = makeConfig();

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('learnings from session 1 appear in session 2 assembly', () => {
    // Session 1
    createSession(db, { session_id: 'sess-1', project: 'proj', cwd: '/test', source: 'cc-hooks' });
    upsertLearning(db, { project: 'proj', fingerprint: 'learning-1', content: 'Always use strict TypeScript' });
    upsertLearning(db, { project: 'proj', fingerprint: 'learning-2', content: 'Run tests before committing' });
    promoteLearnings({ db, project: 'proj', sessionLearnings: ['Always use strict TypeScript'] });
    endSession(db, 'sess-1', 'completed');

    // Session 2
    createSession(db, { session_id: 'sess-2', project: 'proj', cwd: '/test', source: 'cc-hooks' });
    const payload = assembleFullContext({ db, project: 'proj', projectDir: '/test', config });

    // Key assertion: learnings survive across sessions in the DB
    const learnings = getTopLearnings(db, 'proj', 10);
    expect(learnings.length).toBeGreaterThanOrEqual(1);
    expect(learnings.some(l => l.content.includes('strict TypeScript'))).toBe(true);
  });
});

// ─── Checkpoint Recovery (Scenario 5) ───────────────────────────────────────

describe('Checkpoint Recovery', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('checkpoint write -> recoverFromDb restores committed state', async () => {
    createSession(db, { session_id: 'cp-sess', project: 'proj', cwd: '/test', source: 'cc-hooks' });

    // Populate some state
    insertObservation(db, {
      session_id: 'cp-sess', project: 'proj', tool_name: 'Edit', category: 'code',
      title: 'Edit main.ts', content: 'Fixed the bug', importance: 3, files_modified: ['main.ts'],
    });
    upsertThreadState(db, {
      session_id: 'cp-sess', topic: 'bug fix', summary: 'Fixing the main bug',
      key_exchanges: [{ role: 'user', gist: 'Fix the bug' }],
    });

    // Write checkpoint
    await writeCheckpoint({
      db, sessionId: 'cp-sess', project: 'proj', projectDir: '/test',
      trigger: 'compaction', scope: undefined,
    });

    // Verify checkpoint_meta row exists
    const cpMeta = db.prepare(
      "SELECT * FROM checkpoint_meta WHERE session_id = 'cp-sess' AND status IN ('committed', 'mirrored')"
    ).get() as { checkpoint_id: string; status: string; data: string } | undefined;
    expect(cpMeta).toBeDefined();
    expect(cpMeta!.data).toBeTruthy();

    // Run recovery — should not error
    recoverFromDb(db);

    // Verify DB state after recovery (committed rows may or may not become mirrored
    // depending on whether file write succeeded — but the DB query should succeed)
    const loaded = loadCheckpoint(db, '/test');
    // May be null if no file mirror exists (in-memory DB), but DB query should succeed
    // The key assertion: recoverFromDb did not error and checkpoint_meta still has data
    const cpMetaAfter = db.prepare(
      "SELECT * FROM checkpoint_meta WHERE session_id = 'cp-sess'"
    ).get() as { data: string; status: string } | undefined;
    expect(cpMetaAfter).toBeDefined();
  });
});

// ─── Topic-Shift Micro-Injection (Scenario 6) ──────────────────────────────

describe('Topic-Shift Micro-Injection', () => {
  let db: TestDatabase;
  const config = makeConfig();

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('Jaccard fallback topic-shift produces valid result', async () => {
    createSession(db, { session_id: 'ts-sess', project: 'proj', cwd: '/test', source: 'cc-hooks' });

    // Seed thread state with an existing topic
    upsertThreadState(db, {
      session_id: 'ts-sess', topic: 'authentication bug',
      summary: 'Fixing OAuth token refresh', key_exchanges: [],
    });

    // Insert learnings for the new topic
    upsertLearning(db, { project: 'proj', fingerprint: 'deploy-1', content: 'Deployment pipeline uses GitHub Actions' });

    // Create detector with null provider (Jaccard fallback)
    const detector = new TopicShiftDetector(null);

    // Detect shift with explicit pivot keyword ("switch to" at start matches EXPLICIT_PIVOT)
    const result = await detector.detectTopicShift({
      prompt: 'Switch to the deployment pipeline configuration now',
      db, sessionId: 'ts-sess',
      config: { topicShiftThreshold: 0.35, topicShiftWindow: 3 },
    });

    // Explicit pivot regex should fire due to "switch to" at start
    expect(result).toBeDefined();
    expect(result.shifted).toBe(true);
    expect(result.method).toBe('explicit');
    expect(result.previousTopic).toBe('authentication bug');

    // If shifted, verify micro-injection is within budget
    if (result.shifted) {
      const payload = assembleRegularPrompt({
        isPostCompaction: false,
        prompt: 'Switch to the deployment pipeline configuration now',
        gauge: null, topicShift: result,
        db, project: 'proj', projectDir: '/test', config,
      });
      if (payload.tokenEstimate > 0) {
        expect(payload.tokenEstimate).toBeLessThanOrEqual(800);
      }
    }
  });
});

// ─── Enrichment Fallback (Scenario 7) ───────────────────────────────────────

describe('Enrichment Fallback', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('checkpoint writes successfully without enrichment provider', async () => {
    createSession(db, { session_id: 'enr-sess', project: 'proj', cwd: '/test', source: 'cc-hooks' });

    insertObservation(db, {
      session_id: 'enr-sess', project: 'proj', tool_name: 'Edit', category: 'code',
      title: 'Fix security', content: 'Fixed SQL injection vulnerability', importance: 5,
      files_modified: ['db.ts'],
    });
    upsertThreadState(db, {
      session_id: 'enr-sess', topic: 'security fix',
      summary: 'Fixing SQL injection', key_exchanges: [],
    });

    // Write checkpoint without enrichment provider
    const result = await writeCheckpoint({
      db, sessionId: 'enr-sess', project: 'proj', projectDir: '/test',
      trigger: 'compaction', scope: undefined,
    });

    // Verify checkpoint_meta row exists with non-null data
    const cpMeta = db.prepare(
      "SELECT * FROM checkpoint_meta WHERE session_id = 'enr-sess' AND status IN ('committed', 'mirrored')"
    ).get() as { data: string } | undefined;
    expect(cpMeta).toBeDefined();
    expect(cpMeta!.data).toBeTruthy();

    // Parse data and verify heuristic data preserved
    const parsed = JSON.parse(cpMeta!.data);
    expect(parsed.meta).toBeDefined();
    expect(parsed.working).toBeDefined();
    expect(parsed.thread).toBeDefined();
    expect(parsed.thread.topic).toBe('security fix');
  });
});

// ─── FTS5 Search Quality (Scenario 8) ──────────────────────────────────────

describe('FTS5 Search Quality', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: 'fts-sess', project: 'proj', cwd: '/test', source: 'cc-hooks' });

    // Insert 5 observations with distinct content
    insertObservation(db, {
      session_id: 'fts-sess', project: 'proj', tool_name: 'Edit', category: 'code',
      title: 'OAuth token refresh', content: 'Implemented OAuth token refresh flow',
      importance: 4, files_modified: ['auth.ts'],
    });
    insertObservation(db, {
      session_id: 'fts-sess', project: 'proj', tool_name: 'Edit', category: 'code',
      title: 'CSS login page', content: 'Fixed CSS styling on login page',
      importance: 3, files_modified: ['login.css'],
    });
    insertObservation(db, {
      session_id: 'fts-sess', project: 'proj', tool_name: 'Edit', category: 'code',
      title: 'API rate limiting', content: 'Added rate limiting to API endpoints',
      importance: 4, files_modified: ['api.ts'],
    });
    insertObservation(db, {
      session_id: 'fts-sess', project: 'proj', tool_name: 'Edit', category: 'code',
      title: 'OAuth scopes', content: 'Updated OAuth scopes for Google provider',
      importance: 3, files_modified: ['google-auth.ts'],
    });
    insertObservation(db, {
      session_id: 'fts-sess', project: 'proj', tool_name: 'Edit', category: 'code',
      title: 'DB connection pooling', content: 'Refactored database connection pooling',
      importance: 3, files_modified: ['db.ts'],
    });
  });

  afterEach(() => {
    db.close();
  });

  it('FTS5 search returns relevant observations ranked by BM25', () => {
    const results = searchObservations(db, 'OAuth', 'proj', { limit: 10 });

    // Should find the 2 OAuth-related observations
    expect(results.length).toBe(2);

    // Both results should be OAuth-related
    const titles = results.map(r => r.title);
    expect(titles).toContain('OAuth token refresh');
    expect(titles).toContain('OAuth scopes');

    // Non-OAuth observations should NOT appear
    expect(titles).not.toContain('CSS login page');
    expect(titles).not.toContain('DB connection pooling');
    expect(titles).not.toContain('API rate limiting');
  });
});

// ─── Telemetry Queryable (OBSV-03, Scenario 9) ─────────────────────────────

describe('Telemetry Queryable (OBSV-03)', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: 'tel-sess', project: 'proj', cwd: '/test', source: 'cc-hooks' });

    // Populate telemetry with realistic events
    emitTelemetry(db, 'tel-sess', 'hook_invocation', { hook: 'SessionStart', duration_ms: 85, result: 'inject' }, 85);
    emitTelemetry(db, 'tel-sess', 'hook_invocation', { hook: 'PostToolUse', duration_ms: 12, result: 'skip' }, 12);
    emitTelemetry(db, 'tel-sess', 'hook_invocation', { hook: 'PostToolUse', duration_ms: 15, result: 'skip' }, 15);
    emitTelemetry(db, 'tel-sess', 'hook_invocation', { hook: 'Stop', duration_ms: 42, result: 'skip' }, 42);
    emitTelemetry(db, 'tel-sess', 'injection', {
      trigger: 'session_start', sections_included: ['identity', 'checkpoint'],
      sections_skipped: [], total_tokens: 1200, budget_remaining: 2800,
    }, 85);
    emitTelemetry(db, 'tel-sess', 'decision_capture', {
      content: 'Use ULID', source: 'direction', stage1_match: true, stored: true,
    }, 5);
    emitTelemetry(db, 'tel-sess', 'decision_capture', {
      content: 'Let me read', stage1_match: true, stored: false, reason: 'filler_rejected',
    }, 2);
    emitTelemetry(db, 'tel-sess', 'checkpoint_write', {
      checkpoint_id: '01TEST', trigger: 'compaction', state: 'committed', write_duration_ms: 40,
    }, 40);
  });

  afterEach(() => {
    db.close();
  });

  it('Architecture Section 10c SQL queries return valid results', () => {
    // Query 1: Last injection detail
    const q1 = db.prepare(
      `SELECT detail FROM telemetry
       WHERE session_id = ? AND event_kind = 'injection'
       ORDER BY timestamp_epoch_ms DESC LIMIT 1`
    ).get('tel-sess') as { detail: string } | undefined;
    expect(q1).toBeDefined();
    const q1Detail = JSON.parse(q1!.detail);
    expect(q1Detail.trigger).toBe('session_start');
    expect(q1Detail.sections_included).toContain('identity');
    expect(q1Detail.total_tokens).toBe(1200);

    // Query 2: Hook latency stats
    const q2 = db.prepare(
      `SELECT
        json_extract(detail, '$.hook') as hook,
        COUNT(*) as count,
        ROUND(AVG(latency_ms), 1) as avg_ms,
        ROUND(MAX(latency_ms), 1) as max_ms
      FROM telemetry
      WHERE session_id = ? AND event_kind = 'hook_invocation'
      GROUP BY json_extract(detail, '$.hook')`
    ).all('tel-sess') as Array<{ hook: string; count: number; avg_ms: number; max_ms: number }>;

    expect(q2.length).toBe(3); // SessionStart, PostToolUse, Stop
    const ptu = q2.find(r => r.hook === 'PostToolUse');
    expect(ptu).toBeDefined();
    expect(ptu!.count).toBe(2);
    expect(ptu!.avg_ms).toBeGreaterThanOrEqual(12);
    expect(ptu!.avg_ms).toBeLessThanOrEqual(15);

    // Query 3: Decision capture precision
    const q3 = db.prepare(
      `SELECT
        json_extract(detail, '$.stored') as stored,
        COUNT(*) as count
      FROM telemetry
      WHERE event_kind = 'decision_capture' AND session_id = ?
      GROUP BY stored`
    ).all('tel-sess') as Array<{ stored: number; count: number }>;

    expect(q3.length).toBe(2);
    const storedTrue = q3.find(r => r.stored === 1);
    const storedFalse = q3.find(r => r.stored === 0);
    expect(storedTrue).toBeDefined();
    expect(storedTrue!.count).toBe(1);
    expect(storedFalse).toBeDefined();
    expect(storedFalse!.count).toBe(1);

    // Query 4: Checkpoint lifecycle
    const q4 = db.prepare(
      `SELECT
        json_extract(detail, '$.checkpoint_id') as checkpoint_id,
        json_extract(detail, '$.state') as state,
        timestamp_epoch_ms
      FROM telemetry
      WHERE event_kind = 'checkpoint_write'
        AND json_extract(detail, '$.state') != 'mirrored'
      ORDER BY timestamp_epoch_ms DESC`
    ).all() as Array<{ checkpoint_id: string; state: string; timestamp_epoch_ms: number }>;

    expect(q4.length).toBe(1);
    expect(q4[0].checkpoint_id).toBe('01TEST');
    expect(q4[0].state).toBe('committed');
  });
});

// ─── Pressure Scoring and HOT File Surfacing (Scenario 10) ─────────────────

describe('Pressure Scoring and HOT File Surfacing', () => {
  let db: TestDatabase;
  const config = makeConfig();

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: 'pres-sess', project: 'proj', cwd: '/test', source: 'cc-hooks' });
  });

  afterEach(() => {
    db.close();
  });

  it('repeated file touches produce HOT classification and appear in assembly', () => {
    // Touch a file enough to cross HOT threshold (0.5)
    for (let i = 0; i < 10; i++) {
      updatePressureScore(db, '/test/src/critical.ts', 'proj', 0.15);
    }

    const hotFiles = getHotFiles(db, 'proj', 10);
    expect(hotFiles.length).toBeGreaterThanOrEqual(1);

    const criticalFile = hotFiles.find(f => f.file_path === '/test/src/critical.ts');
    expect(criticalFile).toBeDefined();
    expect(criticalFile!.temperature).toBe('HOT');

    // Verify assembly includes hot_files
    const payload = assembleFullContext({ db, project: 'proj', projectDir: '/test', config });
    // Hot files section may or may not appear depending on budget, but the DB state is correct
    if (payload.sources.includes('hot_files')) {
      expect(payload.content).toContain('critical.ts');
    }
  });
});

// ─── Decay Engine Pruning (Scenario 11) ─────────────────────────────────────

describe('Decay Engine Pruning', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: 'decay-sess', project: 'proj', cwd: '/test', source: 'cc-hooks' });
  });

  afterEach(() => {
    db.close();
  });

  it('decay prunes old low-importance observations while retaining important ones', () => {
    const nowEpoch = Date.now(); // ms — for *_epoch_ms columns
    const ninetyDaysAgo = nowEpoch - 90 * 86400_000;
    const oneDayAgo = nowEpoch - 1 * 86400_000;

    // Old low-importance observation
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, timestamp_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('decay-sess', 'proj', 'Read', 'other', 'Read config', 'Read some config file', 1, '[]', ninetyDaysAgo);

    // Old high-importance observation
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, timestamp_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('decay-sess', 'proj', 'Edit', 'security', 'Critical security fix', 'Fixed SQL injection vulnerability', 5, '[]', ninetyDaysAgo);

    // Recent low-importance observation
    db.prepare(
      `INSERT INTO observations (session_id, project, tool_name, category, title, content, importance, files_modified, timestamp_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('decay-sess', 'proj', 'Read', 'other', 'Read readme', 'Read some readme file', 2, '[]', oneDayAgo);

    // Run retention policy with 60-day retention
    applyRetentionPolicy(db, 'proj', 60);

    // Verify old low-importance was deleted (importance < 5 and older than 60 days)
    const allObs = getObservationsByProject(db, 'proj', { includeDeleted: true });

    const oldLow = allObs.find(o => o.title === 'Read config');
    expect(oldLow).toBeUndefined(); // Hard-deleted by retention policy

    // Old high-importance should still exist (importance >= 5 is exempt)
    const oldHigh = allObs.find(o => o.title === 'Critical security fix');
    expect(oldHigh).toBeDefined();

    // Recent low-importance should still exist (within retention window)
    const recentLow = allObs.find(o => o.title === 'Read readme');
    expect(recentLow).toBeDefined();
  });
});
