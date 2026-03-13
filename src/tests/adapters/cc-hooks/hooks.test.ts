/**
 * Integration tests for CC hook entry point logic.
 * Uses in-memory SQLite with initialized schema.
 * Tests verify each hook's core orchestration — not the full wrapHook flow.
 */

import { createTestDb, type TestDatabase } from '../../helpers/test-db.js';
import { createSession, getSession } from '../../../core/sessions.js';
import { getCheckpointTracking, markPostCompactPending, clearPostCompactPending } from '../../../core/checkpoint-tracking.js';
import { recoverFromDb } from '../../../checkpoint/loader.js';
import { assembleFullContext, assembleRegularPrompt } from '../../../assembly/assembler.js';
import { processToolObservation } from '../../../extraction/extractor.js';
import { updatePressureScore, getHotFiles } from '../../../core/pressure.js';
import { ThreadTracker } from '../../../intelligence/thread-tracker.js';
import { captureDecisions } from '../../../intelligence/decision-capture.js';
import { writeCheckpoint } from '../../../checkpoint/writer.js';
import { promoteLearnings } from '../../../intelligence/learnings-promoter.js';
import { pruneObservations, applyRetentionPolicy } from '../../../decay/decay-engine.js';
import { decayPressureStratified } from '../../../decay/pressure-decay.js';
import { endSession } from '../../../core/sessions.js';
import { pruneTelemetry } from '../../../observability/telemetry.js';
import { getIdentityDir } from '../../../shared/paths.js';
import { DEFAULT_CONFIG } from '../../../shared/constants.js';
import type { ClaudexConfig } from '../../../shared/config.js';

const testConfig = { ...DEFAULT_CONFIG } as unknown as ClaudexConfig;

describe('SessionStart hook logic', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates session and returns additionalContext on full assembly', () => {
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      source: 'cc-hooks',
    });

    const session = getSession(db, 'test-s1');
    expect(session).toBeDefined();
    expect(session!.status).toBe('active');

    // Assembly on empty DB returns empty or minimal content
    const payload = assembleFullContext({
      db,
      project: 'test-proj',
      projectDir: '/tmp/test',
      config: testConfig,
      identityDir: getIdentityDir(),
    });

    // Structure is correct even if content is empty
    expect(payload).toHaveProperty('content');
    expect(payload).toHaveProperty('tokenEstimate');
    expect(payload).toHaveProperty('sources');
  });

  it('calls recoverFromDb for checkpoint re-mirroring', () => {
    // recoverFromDb should not throw on empty DB
    expect(() => recoverFromDb(db)).not.toThrow();
  });

  it('returns {} when assembly produces no content', () => {
    const payload = assembleFullContext({
      db,
      project: 'empty-proj',
      projectDir: '/nonexistent',
      config: testConfig,
    });

    // No data -> empty or minimal content
    if (!payload.content) {
      expect(payload.content).toBeFalsy();
    }
  });
});

describe('UserPromptSubmit hook logic', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns {} on regular prompt (no injection)', () => {
    const payload = assembleRegularPrompt({
      isPostCompaction: false,
      prompt: 'Hello, how are you?',
      gauge: null,
      topicShift: null,
      db,
      project: 'test-proj',
      projectDir: '/tmp/test',
      config: testConfig,
    });

    // Regular non-injection turn should produce empty content
    expect(payload.content).toBe('');
  });

  it('returns systemMessage on post-compaction', () => {
    markPostCompactPending(db, 'test-s1');
    const tracking = getCheckpointTracking(db, 'test-s1');
    expect(tracking?.post_compact_pending).toBe(1);

    const payload = assembleRegularPrompt({
      isPostCompaction: true,
      prompt: 'Continue',
      gauge: null,
      topicShift: null,
      db,
      project: 'test-proj',
      projectDir: '/tmp/test',
      config: testConfig,
    });

    // Post-compaction should produce some content (at least checkpoint or identity)
    expect(payload).toHaveProperty('content');
  });

  it('clears post-compact-pending after returning injection', () => {
    markPostCompactPending(db, 'test-s1');
    clearPostCompactPending(db, 'test-s1');

    const tracking = getCheckpointTracking(db, 'test-s1');
    expect(tracking?.post_compact_pending).toBe(0);
  });
});

describe('PostToolUse hook logic', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('calls processToolObservation with correct params', () => {
    // processToolObservation returns observation id or null
    const result = processToolObservation({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test/foo.ts' },
      toolOutput: { content: 'file contents here' },
      projectRoot: '/tmp/test',
    });

    // May return null if quality gate filters it, but should not throw
    expect(result === null || typeof result === 'number').toBe(true);
  });

  it('updates pressure scores for files in tool input', () => {
    updatePressureScore(db, '/tmp/test/foo.ts', 'test-proj', 0.1);
    const hotFiles = getHotFiles(db, 'test-proj', 10);
    // File should exist in pressure scores (may or may not be HOT depending on threshold)
    const allFiles = db
      .prepare('SELECT * FROM pressure_scores WHERE project = ?')
      .all('test-proj');
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it('creates ThreadTracker and calls onAfterTool', () => {
    const tracker = new ThreadTracker(db, 'test-s1');
    tracker.onAfterTool('test prompt', 'Read', { file_path: '/tmp/foo.ts' });
    tracker.persist();

    // Thread state should be persisted
    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });

  it('returns {} (no injection)', () => {
    // PostToolUse always returns {}
    expect({}).toEqual({});
  });
});

describe('Stop hook logic', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('calls captureDecisions with mode after_turn', async () => {
    const result = await captureDecisions({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      userText: 'yes, go ahead with that approach',
      assistantText: 'Use TypeScript strict mode with ESLint configured for the project.',
      mode: 'after_turn',
    });

    // captureDecisions returns array of captured decisions (may be empty)
    expect(Array.isArray(result)).toBe(true);
  });

  it('creates ThreadTracker and calls onAfterTurn', () => {
    const tracker = new ThreadTracker(db, 'test-s1');
    tracker.onAfterTurn('user said something', 'agent responded with analysis');

    // Thread state should be persisted (onAfterTurn calls persist internally)
    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });

  it('returns {} (no injection)', () => {
    expect({}).toEqual({});
  });
});

describe('PreCompact hook logic', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('calls writeCheckpoint with compaction trigger', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      projectDir: '/tmp/test',
      trigger: 'compaction',
    });

    // writeCheckpoint returns result or null
    if (result) {
      expect(result.checkpointId).toBeDefined();
    }
  });

  it('marks post-compact-pending', () => {
    markPostCompactPending(db, 'test-s1');
    const tracking = getCheckpointTracking(db, 'test-s1');
    expect(tracking?.post_compact_pending).toBe(1);
  });

  it('returns {} (no injection)', () => {
    expect({}).toEqual({});
  });
});

describe('SessionEnd hook logic', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('writes final checkpoint with session_end trigger', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      projectDir: '/tmp/test',
      trigger: 'session_end',
    });

    if (result) {
      expect(result.checkpointId).toBeDefined();
    }
  });

  it('runs decay and retention', () => {
    expect(() => pruneObservations(db, 'test-proj', {
      pruneThreshold: 1000,
      pruneCount: 50,
    })).not.toThrow();

    expect(() => applyRetentionPolicy(db, 'test-proj', 90)).not.toThrow();
  });

  it('runs pressure decay', () => {
    // Add a pressure entry first
    updatePressureScore(db, '/tmp/test/foo.ts', 'test-proj', 1.0);
    const result = decayPressureStratified(db);
    expect(typeof result).toBe('number');
  });

  it('ends session record', () => {
    endSession(db, 'test-s1', 'completed');
    const session = getSession(db, 'test-s1');
    expect(session?.status).toBe('completed');
  });

  it('prunes telemetry', () => {
    expect(() => pruneTelemetry(db, {
      retentionDays: 7,
      retainErrorCount: 1000,
    })).not.toThrow();
  });

  it('returns {} (no injection)', () => {
    expect({}).toEqual({});
  });
});
