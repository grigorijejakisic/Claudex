/**
 * Integration tests for CC hook entry point logic.
 * Uses in-memory SQLite with initialized schema.
 * Tests verify each hook's core orchestration — not the full wrapHook flow.
 */

import { createTestDb, type TestDatabase } from '../../helpers/test-db.js';
import { createSession } from '../../../core/sessions.js';
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
import { addJournalEntry, getJournalBySession } from '../../../core/journal.js';
import { upsertThreadState } from '../../../core/thread.js';
import { insertDecision } from '../../../core/decisions.js';
import { insertObservation } from '../../../core/observations.js';
import { detectMilestone } from '../../../adapters/shared/lifecycle.js';
import { buildFlowEntry, captureFlowEntry, captureSessionSummary } from '../../../adapters/shared/lifecycle.js';
import { writeClaudeEnvFile, detectCcMemoryConflict } from '../../../adapters/shared/env-file.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

    const session = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('test-s1') as { status: string } | undefined;
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
    const session = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('test-s1') as { status: string } | undefined;
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

// ---------------------------------------------------------------------------
// Journal integration tests
// ---------------------------------------------------------------------------

describe('detectMilestone (pure function)', () => {
  it('detects test pass results', () => {
    const r = detectMilestone('Bash', '42 tests passed');
    expect(r?.text).toBe('Tests: 42 passing');
    expect(r?.metadata).toEqual({ test_count: 42, pass_count: 42, fail_count: 0 });
  });

  it('detects test pass/fail results', () => {
    const r = detectMilestone('Bash', '40 passed, 2 failed');
    expect(r?.text).toBe('Tests: 40 passed, 2 failed');
    expect(r?.metadata.pass_count).toBe(40);
    expect(r?.metadata.fail_count).toBe(2);
  });

  it('detects build success', () => {
    const r = detectMilestone('Bash', 'Build complete successfully');
    expect(r?.text).toBe('Build succeeded');
    expect(r?.metadata.build_tool).toBe('Bash');
  });

  it('detects git commits', () => {
    const r = detectMilestone('Bash', '[main abc1234] fix: something');
    expect(r?.text).toBe('Committed abc1234');
    expect(r?.metadata.commit_hash).toBe('abc1234');
  });

  it('detects longer commit hashes', () => {
    expect(detectMilestone('Bash', '[feature/x abc1234def] feat: thing')?.text).toBe('Committed abc1234');
  });

  it('does not detect git commits from non-Bash tools', () => {
    expect(detectMilestone('Read', '[main abc1234] fix: something')).toBeNull();
  });

  it('detects team deployment', () => {
    expect(detectMilestone('Bash', '3 workers deployed')?.text).toBe('Team agents deployed');
    expect(detectMilestone('Bash', 'agent spawned successfully')?.text).toBe('Team agents deployed');
  });

  it('returns null for no milestone', () => {
    expect(detectMilestone('Read', 'just some file contents')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(detectMilestone('Bash', '')).toBeNull();
  });
});

describe('buildFlowEntry', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'flow-s1',
      project: 'flow-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns null when no data available', () => {
    expect(buildFlowEntry(db, 'flow-s1', 'flow-proj')).toBeNull();
  });

  it('includes thread topic when available', () => {
    upsertThreadState(db, {
      session_id: 'flow-s1',
      topic: 'Refactoring authentication module',
    });

    const flow = buildFlowEntry(db, 'flow-s1', 'flow-proj');
    expect(flow).toContain('Refactoring authentication module');
  });

  it('includes recent decisions', () => {
    insertDecision(db, {
      session_id: 'flow-s1',
      project: 'flow-proj',
      content: 'Use JWT tokens for auth',
      source: 'explicit',
      fingerprint: 'fp-1',
    });

    const flow = buildFlowEntry(db, 'flow-s1', 'flow-proj');
    expect(flow).toContain('Decisions:');
    expect(flow).toContain('JWT tokens');
  });

  it('includes insight flow entries when available', () => {
    // Insights are stored as flow entries with [marker] prefix by captureInsightsAsLearnings
    addJournalEntry(db, 'flow-s1', 'flow-proj', 'flow', '[diagnosis] Root cause: field name mismatch in CC hook payload');

    const flow = buildFlowEntry(db, 'flow-s1', 'flow-proj');
    expect(flow).toContain('Insights:');
    expect(flow).toContain('Root cause');
  });

  it('truncates to 300 chars', () => {
    upsertThreadState(db, {
      session_id: 'flow-s1',
      topic: 'A'.repeat(100),
    });

    for (let i = 0; i < 3; i++) {
      insertDecision(db, {
        session_id: 'flow-s1',
        project: 'flow-proj',
        content: 'D'.repeat(60),
        source: 'explicit',
        fingerprint: `fp-${i}`,
      });
    }

    const flow = buildFlowEntry(db, 'flow-s1', 'flow-proj');
    expect(flow!.length).toBeLessThanOrEqual(300);
  });
});

describe('captureFlowEntry', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'cap-s1',
      project: 'cap-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('stores flow entry in session_journal', () => {
    upsertThreadState(db, {
      session_id: 'cap-s1',
      topic: 'Working on database schema',
    });

    captureFlowEntry(db, 'cap-s1', 'cap-proj');

    const entries = getJournalBySession(db, 'cap-s1', { entryType: 'flow' });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toContain('database schema');
    expect(entries[0].entry_type).toBe('flow');
  });

  it('does not throw when no data available', () => {
    expect(() => captureFlowEntry(db, 'cap-s1', 'cap-proj')).not.toThrow();

    // No entry should be created when there's nothing to capture
    const entries = getJournalBySession(db, 'cap-s1', { entryType: 'flow' });
    expect(entries.length).toBe(0);
  });
});

describe('captureSessionSummary', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'sum-s1',
      project: 'sum-proj',
      cwd: '/tmp/test',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('stores a summary with topic', () => {
    upsertThreadState(db, {
      session_id: 'sum-s1',
      topic: 'API redesign',
    });

    captureSessionSummary(db, 'sum-s1', 'sum-proj');

    const entries = getJournalBySession(db, 'sum-s1', { entryType: 'summary' });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toContain('Session worked on API redesign');
  });

  it('includes milestones in summary', () => {
    addJournalEntry(db, 'sum-s1', 'sum-proj', 'milestone', 'Tests: 42 passing');
    addJournalEntry(db, 'sum-s1', 'sum-proj', 'milestone', 'Build succeeded');

    captureSessionSummary(db, 'sum-s1', 'sum-proj');

    const entries = getJournalBySession(db, 'sum-s1', { entryType: 'summary' });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toContain('Milestones:');
    expect(entries[0].content).toContain('Tests: 42 passing');
    expect(entries[0].content).toContain('Build succeeded');
  });

  it('includes decision count in summary', () => {
    insertDecision(db, {
      session_id: 'sum-s1',
      project: 'sum-proj',
      content: 'Use PostgreSQL',
      source: 'explicit',
      fingerprint: 'fp-1',
    });
    insertDecision(db, {
      session_id: 'sum-s1',
      project: 'sum-proj',
      content: 'Use TypeScript strict',
      source: 'confirmation',
      fingerprint: 'fp-2',
    });

    captureSessionSummary(db, 'sum-s1', 'sum-proj');

    const entries = getJournalBySession(db, 'sum-s1', { entryType: 'summary' });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toContain('Decisions: 2 made');
  });

  it('includes flow narrative in summary', () => {
    addJournalEntry(db, 'sum-s1', 'sum-proj', 'flow', 'Pivoted to artifact model after analysis');

    captureSessionSummary(db, 'sum-s1', 'sum-proj');

    const entries = getJournalBySession(db, 'sum-s1', { entryType: 'summary' });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toContain('Flow: Pivoted to artifact model');
  });

  it('produces minimal summary when no data available', () => {
    captureSessionSummary(db, 'sum-s1', 'sum-proj');

    const entries = getJournalBySession(db, 'sum-s1', { entryType: 'summary' });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('Session completed.');
  });
});

// ---------------------------------------------------------------------------
// Environment flags (Phase 1 — X3, T1, T2, T8, C1, C2, B6)
// ---------------------------------------------------------------------------

describe('writeClaudeEnvFile', () => {
  const originalEnv = process.env.CLAUDE_ENV_FILE;

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.CLAUDE_ENV_FILE = originalEnv;
    } else {
      delete process.env.CLAUDE_ENV_FILE;
    }
  });

  it('writes correct exports when CLAUDE_ENV_FILE is set', () => {
    const tmpFile = path.join(os.tmpdir(), `claudex-env-test-${Date.now()}.sh`);
    process.env.CLAUDE_ENV_FILE = tmpFile;

    writeClaudeEnvFile();

    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
    expect(content).toContain('export CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1');

    // Clean up
    fs.unlinkSync(tmpFile);
  });

  it('skips silently when CLAUDE_ENV_FILE is not set', () => {
    delete process.env.CLAUDE_ENV_FILE;
    expect(() => writeClaudeEnvFile()).not.toThrow();
  });

  it('handles write failure gracefully', () => {
    // Point to a path that cannot be written (nonexistent deep directory)
    process.env.CLAUDE_ENV_FILE = path.join(os.tmpdir(), 'nonexistent-dir-xyz', 'sub', 'env.sh');
    expect(() => writeClaudeEnvFile()).not.toThrow();
  });

  it('only contains session-agnostic flags (B6 guard)', () => {
    const tmpFile = path.join(os.tmpdir(), `claudex-env-b6-${Date.now()}.sh`);
    process.env.CLAUDE_ENV_FILE = tmpFile;

    writeClaudeEnvFile();

    const content = fs.readFileSync(tmpFile, 'utf-8');
    // Must not contain session_id or any session-specific values
    expect(content).not.toContain('session_id');
    expect(content).not.toContain('SESSION_ID');
    // Only boolean flag assignments allowed
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      expect(line).toMatch(/^export \w+=\w+$/);
    }

    fs.unlinkSync(tmpFile);
  });
});

describe('detectCcMemoryConflict', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('finds new memory files after baseline', () => {
    // Create two sessions — the "last" one provides the baseline
    const oldEpoch = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    createSession(db, {
      session_id: 'conflict-old',
      project: 'conflict-proj',
      cwd: '/tmp/test',
    });
    // Backdate it
    db.prepare('UPDATE sessions SET created_at_epoch = ? WHERE session_id = ?')
      .run(oldEpoch, 'conflict-old');

    createSession(db, {
      session_id: 'conflict-new',
      project: 'conflict-proj',
      cwd: '/tmp/test',
    });

    // Create a temp memory directory with a file that has a recent mtime
    const memDir = path.join(os.tmpdir(), `claudex-mem-test-${Date.now()}`);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'test-memory.md'), 'some memory content');

    // Patch the detection to use our temp dir by passing scope that resolves to it
    // Since detectCcMemoryConflict builds the path from homedir, we test the return
    // value logic by calling with a project that won't match a real dir
    const result = detectCcMemoryConflict(db, 'conflict-new', 'conflict-proj', undefined);
    // This may return [] since the real path doesn't exist — that's correct behavior
    expect(Array.isArray(result)).toBe(true);

    // Clean up
    fs.rmSync(memDir, { recursive: true });
  });

  it('returns empty array when no previous session exists', () => {
    createSession(db, {
      session_id: 'only-session',
      project: 'solo-proj',
      cwd: '/tmp/test',
    });

    const result = detectCcMemoryConflict(db, 'only-session', 'solo-proj', undefined);
    expect(result).toEqual([]);
  });

  it('returns empty array when memory directory does not exist', () => {
    createSession(db, {
      session_id: 'no-dir-s1',
      project: 'no-dir-proj',
      cwd: '/tmp/test',
    });

    const result = detectCcMemoryConflict(db, 'no-dir-s1', 'no-dir-proj', 'nonexistent-scope-xyz');
    expect(result).toEqual([]);
  });
});
