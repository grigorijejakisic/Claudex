/**
 * Integration tests: End-to-end flows for CC hooks and OpenClaw bridge,
 * fresh install validation, and performance SLA assertions.
 * @see Architecture Section 14 — Scenarios 1, 2, 3 + PERF-01 through PERF-04
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { openDatabase } from '../../core/storage.js';
import { initializeSchema } from '../../core/migrations.js';
import { createSession, endSession } from '../../core/sessions.js';
import { getObservationsByProject, insertObservation, searchObservations } from '../../core/observations.js';
import { getCheckpointTracking, markPostCompactPending, clearPostCompactPending } from '../../core/checkpoint-tracking.js';
import { getThreadState, upsertThreadState } from '../../core/thread.js';
import { getHotFiles, updatePressureScore } from '../../core/pressure.js';
import { getTopLearnings, upsertLearning } from '../../core/learnings.js';
import { processToolObservation } from '../../extraction/extractor.js';
import { assembleFullContext, assembleRegularPrompt } from '../../assembly/assembler.js';
import { writeCheckpoint } from '../../checkpoint/writer.js';
import { recoverFromDb, loadCheckpoint } from '../../checkpoint/loader.js';
import { ThreadTracker } from '../../intelligence/thread-tracker.js';
import { captureDecisions } from '../../intelligence/decision-capture.js';
import { promoteLearnings } from '../../intelligence/learnings-promoter.js';
import { pruneObservations, applyRetentionPolicy } from '../../decay/decay-engine.js';
import { decayPressureStratified } from '../../decay/pressure-decay.js';
import { emitTelemetry, pruneTelemetry } from '../../observability/telemetry.js';
import { insertDecision, getDecisionsBySession } from '../../core/decisions.js';
import { DEFAULT_CONFIG } from '../../shared/constants.js';
import { createBridgeCallbacks, type BridgeContext } from '../../adapters/openclaw-bridge/bridge-adapter.js';
import type { ClaudexConfig } from '../../shared/config.js';

function makeConfig(): ClaudexConfig {
  return {
    ...DEFAULT_CONFIG,
    enrichment: { ...DEFAULT_CONFIG.enrichment, provider: 'none' as const },
  } as unknown as ClaudexConfig;
}

function makePiContext(messages: Array<{ role: string; content: string }>, overrides?: Record<string, unknown>) {
  return {
    sessionKey: 'oc-session-1',
    cwd: '/test',
    messages,
    getContextUsage: () => ({ inputTokens: 1000, outputTokens: 500, contextWindowTokens: 200000 }),
    ...overrides,
  };
}

// ─── CC Hook E2E Flow ───────────────────────────────────────────────────────

describe('CC Hook E2E Flow', () => {
  let db: TestDatabase;
  const config = makeConfig();
  const sessionId = 'test-session';
  const project = 'test-project';

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('full CC hook lifecycle produces correct accumulated state', async () => {
    // Step 1: SessionStart
    createSession(db, { session_id: sessionId, project, cwd: '/test', source: 'cc-hooks' });
    recoverFromDb(db);
    const payload = assembleFullContext({ db, project, projectDir: '/test', config });

    const session = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get(sessionId) as { status: string } | undefined;
    expect(session).toBeDefined();
    expect(session!.status).toBe('active');
    expect(payload).toBeDefined();

    // Step 2: PostToolUse x2
    processToolObservation({
      db, sessionId, project, toolName: 'Edit',
      toolInput: { file_path: '/test/src/main.ts', old_string: 'foo', new_string: 'bar' },
      toolOutput: undefined, projectRoot: '/test',
    });
    updatePressureScore(db, '/test/src/main.ts', project, 0.1);
    const tracker1 = new ThreadTracker(db, sessionId);
    tracker1.onAfterTool(undefined, 'Edit', { file_path: '/test/src/main.ts' });
    tracker1.persist();

    processToolObservation({
      db, sessionId, project, toolName: 'Read',
      toolInput: { file_path: '/test/README.md' },
      toolOutput: { content: 'Project readme contents' }, projectRoot: '/test',
    });
    updatePressureScore(db, '/test/README.md', project, 0.1);
    const tracker2 = new ThreadTracker(db, sessionId);
    tracker2.onAfterTool(undefined, 'Read', { file_path: '/test/README.md' });
    tracker2.persist();

    // Verify observations stored (Edit should pass quality gate; Read may or may not)
    const obs = getObservationsByProject(db, project);
    expect(obs.length).toBeGreaterThanOrEqual(1);

    // Verify thread state populated
    const thread = getThreadState(db, sessionId);
    expect(thread).toBeDefined();

    // Step 3: Stop (turn end)
    await captureDecisions({
      db, sessionId, project,
      userText: 'Please rename foo to bar in main.ts',
      assistantText: "I'll rename foo to bar as requested. Let me edit the file.",
      mode: 'after_turn',
    });
    const tracker3 = new ThreadTracker(db, sessionId);
    tracker3.onAfterTurn('Please rename foo to bar in main.ts', "I'll rename foo to bar as requested.");

    const threadAfterStop = getThreadState(db, sessionId);
    expect(threadAfterStop).toBeDefined();

    // Step 4: PreCompact
    await writeCheckpoint({
      db, sessionId, project, projectDir: '/test',
      trigger: 'compaction', scope: undefined,
    });
    promoteLearnings({ db, project, sessionLearnings: [] });
    markPostCompactPending(db, sessionId);

    const trackingAfterPreCompact = getCheckpointTracking(db, sessionId);
    expect(trackingAfterPreCompact).toBeDefined();
    expect(trackingAfterPreCompact!.post_compact_pending).toBe(1);

    // Verify checkpoint_meta exists
    const cpMeta = db.prepare(
      "SELECT * FROM checkpoint_meta WHERE session_id = ? AND status IN ('committed', 'mirrored')"
    ).get(sessionId) as { checkpoint_id: string; data: string } | undefined;
    expect(cpMeta).toBeDefined();

    // Step 5: UserPromptSubmit (post-compaction)
    const tracking = getCheckpointTracking(db, sessionId);
    const isPostCompaction = tracking?.post_compact_pending === 1;
    expect(isPostCompaction).toBe(true);

    assembleRegularPrompt({
      isPostCompaction, prompt: 'What did we just do?', gauge: null,
      topicShift: null, db, project, projectDir: '/test', config,
    });
    clearPostCompactPending(db, sessionId);

    const trackingAfterClear = getCheckpointTracking(db, sessionId);
    expect(trackingAfterClear!.post_compact_pending).toBe(0);

    // Step 6: SessionEnd
    await writeCheckpoint({
      db, sessionId, project, projectDir: '/test',
      trigger: 'session_end', scope: undefined,
    });
    pruneObservations(db, project, {
      pruneThreshold: config.observations.prune_threshold,
      pruneCount: config.observations.prune_count,
    });
    applyRetentionPolicy(db, project, config.observations.retention_days);
    decayPressureStratified(db);
    endSession(db, sessionId, 'completed');
    pruneTelemetry(db, {
      retentionDays: config.observability.retention_days,
      retainErrorCount: config.observability.retain_error_count,
    });

    const finalSession = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get(sessionId) as { status: string } | undefined;
    expect(finalSession!.status).toBe('completed');
  });
});

// ─── OpenClaw Bridge E2E Flow ───────────────────────────────────────────────

describe('OpenClaw Bridge E2E Flow', () => {
  let db: TestDatabase;
  const config = makeConfig();

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('full OpenClaw bridge lifecycle produces correct accumulated state', { timeout: 15000 }, async () => {
    const bctx: BridgeContext = {
      db, config, project: 'test-project', scope: null, sessionId: '', cwd: '/test', adapter: 'openclaw' as const,
    };
    const bridge = createBridgeCallbacks(bctx);

    // Step 1: onInit
    const initResult = await bridge.onInit({ sessionKey: 'oc-session-1', cwd: '/test' });
    expect(bctx.sessionId).toBe('oc-session-1');
    const session = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('oc-session-1') as { status: string } | undefined;
    expect(session).toBeDefined();
    expect(session!.status).toBe('active');

    // Step 2: onContext (regular, should be zero injection on empty DB)
    const ctxRegular = makePiContext([{ role: 'user', content: 'Hello' }]);
    const contextResult = await bridge.onContext(ctxRegular);
    // On fresh DB with no prior data, should return undefined (zero injection)

    // Step 3: onToolResult x2
    const toolCtx1 = {
      ...makePiContext([{ role: 'user', content: 'Edit main.ts' }]),
      toolName: 'Edit',
      toolInput: { file_path: '/test/src/app.ts', old_string: 'x', new_string: 'y' },
      toolOutput: {},
    };
    await bridge.onToolResult(toolCtx1);

    const toolCtx2 = {
      ...makePiContext([{ role: 'user', content: 'Edit main.ts' }]),
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      toolOutput: { stdout: 'PASS' },
    };
    await bridge.onToolResult(toolCtx2);

    // Verify observations stored
    const obs = getObservationsByProject(db, bctx.project);
    expect(obs.length).toBeGreaterThanOrEqual(1);

    // Verify thread state populated
    const thread = getThreadState(db, 'oc-session-1');
    expect(thread).toBeDefined();

    // Step 4: onTurnEnd
    const turnEndCtx = {
      ...makePiContext([{ role: 'user', content: 'Edit main.ts' }]),
      lastAssistantText: 'Done editing. Tests pass.',
      lastUserText: 'Edit main.ts and run tests',
    };
    await bridge.onTurnEnd(turnEndCtx);

    const threadAfterTurn = getThreadState(db, 'oc-session-1');
    expect(threadAfterTurn).toBeDefined();

    // Step 5: onCompact
    const compactCtx = makePiContext([{ role: 'user', content: 'summary' }]);
    await bridge.onCompact(compactCtx, { messagesToSummarize: [], turnPrefixMessages: [] }, {});

    const trackingAfterCompact = getCheckpointTracking(db, 'oc-session-1');
    expect(trackingAfterCompact).toBeDefined();
    expect(trackingAfterCompact!.post_compact_pending).toBe(1);

    // Step 6: onContext (post-compaction)
    const postCompactCtx = {
      ...makePiContext([{ role: 'user', content: 'Continue' }]),
      isPostCompaction: true,
    };
    await bridge.onContext(postCompactCtx);

    const trackingAfterPostCompact = getCheckpointTracking(db, 'oc-session-1');
    expect(trackingAfterPostCompact!.post_compact_pending).toBe(0);
  });
});

// ─── Fresh Install Flow ─────────────────────────────────────────────────────

describe('Fresh Install Flow', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('initializeSchema creates all required tables, indexes, triggers, and FTS5', () => {
    initializeSchema(db);

    // Verify all 11 tables
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);

    const expectedTables = [
      'checkpoint_meta', 'checkpoint_tracking', 'decisions', 'learnings',
      'observations', 'observations_fts', 'pressure_scores', 'schema_versions',
      'sessions', 'telemetry', 'thread_state',
    ];
    for (const t of expectedTables) {
      expect(tables).toContain(t);
    }

    // Verify key indexes
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);

    const expectedIndexes = [
      'idx_obs_session', 'idx_obs_project', 'idx_obs_timestamp',
      'idx_obs_importance', 'idx_obs_deleted', 'idx_learnings_promo',
      'idx_decisions_session', 'idx_telemetry_session', 'idx_telemetry_kind',
      'idx_cpmeta_session', 'idx_cpmeta_status',
    ];
    for (const idx of expectedIndexes) {
      expect(indexes).toContain(idx);
    }

    // Verify FTS sync triggers
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(triggers).toContain('observations_ai');
    expect(triggers).toContain('observations_ad');
    expect(triggers).toContain('observations_au');

    // Verify schema version 300
    const version = db.prepare('SELECT MAX(version) as version FROM schema_versions').get() as { version: number };
    expect(version.version).toBe(300);

    // Verify WAL mode (in-memory DB returns 'memory' instead of 'wal' — both are valid)
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(['wal', 'memory']).toContain(journal.journal_mode);

    // Verify foreign keys ON
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it('fresh DB supports full CRUD cycle', () => {
    initializeSchema(db);

    // Insert and query observation
    const obsId = insertObservation(db, {
      session_id: 'crud-sess',
      project: 'crud-proj',
      tool_name: 'Edit',
      category: 'code',
      title: 'Edit main.ts',
      content: 'Changed foo to bar',
      importance: 3,
      files_modified: ['main.ts'],
    });
    expect(obsId).toBeGreaterThan(0);

    // Search via FTS5
    const ftsResults = searchObservations(db, 'foo bar', 'crud-proj', { limit: 10 });
    expect(ftsResults.length).toBeGreaterThanOrEqual(1);

    // Insert and query session
    createSession(db, { session_id: 'crud-sess', project: 'crud-proj', cwd: '/test' });
    const sess = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('crud-sess') as { status: string } | undefined;
    expect(sess).toBeDefined();
    expect(sess!.status).toBe('active');

    // Insert and query learning
    upsertLearning(db, { project: 'crud-proj', fingerprint: 'fp1', content: 'Always use strict mode' });
    const learnings = getTopLearnings(db, 'crud-proj', 10);
    expect(learnings.length).toBe(1);

    // Insert and query decision
    insertDecision(db, {
      session_id: 'crud-sess', project: 'crud-proj',
      content: 'Use TypeScript', source: 'direction', fingerprint: 'dec-fp1',
    });
    const decisions = getDecisionsBySession(db, 'crud-sess');
    expect(decisions.length).toBe(1);

    // Emit and query telemetry
    emitTelemetry(db, 'crud-sess', 'hook_invocation', { hook: 'test', duration_ms: 10, result: 'skip' }, 10);
    const telRows = db.prepare('SELECT * FROM telemetry WHERE session_id = ?').all('crud-sess') as Array<Record<string, unknown>>;
    expect(telRows.length).toBe(1);
  });
});

// ─── Performance SLAs ───────────────────────────────────────────────────────

describe('Performance SLAs', () => {
  let db: TestDatabase;
  const config = makeConfig();
  const sessionId = 'perf-session';
  const project = 'perf-project';

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: sessionId, project, cwd: '/test', source: 'cc-hooks' });

    // Seed a few observations for realistic assembly
    for (let i = 0; i < 5; i++) {
      insertObservation(db, {
        session_id: sessionId, project, tool_name: 'Edit', category: 'code',
        title: `Edit file${i}.ts`, content: `Changed function${i}`,
        importance: 3, files_modified: [`file${i}.ts`],
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  it('assembleRegularPrompt < 100ms on non-injection turn (PERF-01)', () => {
    const start = Date.now();
    assembleRegularPrompt({
      isPostCompaction: false, prompt: 'hello', gauge: null,
      topicShift: null, db, project, projectDir: '/test', config,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('assembleFullContext < 500ms on injection turn (PERF-01)', () => {
    const start = Date.now();
    assembleFullContext({ db, project, projectDir: '/test', config });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('processToolObservation < 100ms (PERF-02)', () => {
    const start = Date.now();
    processToolObservation({
      db, sessionId, project, toolName: 'Edit',
      toolInput: { file_path: '/test/foo.ts', old_string: 'a', new_string: 'b' },
      toolOutput: undefined, projectRoot: '/test',
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('captureDecisions < 150ms (PERF-03)', async () => {
    const start = Date.now();
    await captureDecisions({
      db, sessionId, project,
      userText: 'Use TypeScript',
      assistantText: 'Confirmed, we will use TypeScript for all modules.',
      mode: 'after_turn',
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(150);
  });

  it('aggregate turn overhead < 600ms (PERF-04)', async () => {
    const start = Date.now();

    // PostToolUse work
    processToolObservation({
      db, sessionId, project, toolName: 'Write',
      toolInput: { file_path: '/test/new.ts', content: 'export const x = 1;' },
      toolOutput: undefined, projectRoot: '/test',
    });
    updatePressureScore(db, '/test/new.ts', project, 0.1);
    const t = new ThreadTracker(db, sessionId);
    t.onAfterTool(undefined, 'Write', { file_path: '/test/new.ts' });
    t.persist();

    // Stop work
    await captureDecisions({
      db, sessionId, project,
      userText: 'Create the new module',
      assistantText: 'Created new.ts with the initial export.',
      mode: 'after_turn',
    });
    const t2 = new ThreadTracker(db, sessionId);
    t2.onAfterTurn('Create the new module', 'Created new.ts with the initial export.');

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(600);
  });
});
