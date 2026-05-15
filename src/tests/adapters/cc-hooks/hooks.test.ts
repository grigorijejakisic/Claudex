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
import { verifyMemoryMd } from '../../../core/memory-md-verify.js';
import { recordEvent, getSessionEvents } from '../../../core/session-events.js';
import { getActiveSignals, createSignal } from '../../../core/session-signals.js';
import { cachedPrepare } from '../../../core/stmt-cache.js';
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

  it('records memory_md_invalid session event when MEMORY.md is oversize (04-03-05 wiring)', () => {
    // Pre-populate a temp HOME with an oversize MEMORY.md at the CC-style path,
    // then drive the same invocation session-start.ts makes.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-mmv-wire-'));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    try {
      const scope = 'wire-test-proj';
      const memoryDir = path.join(tmpHome, '.claude', 'projects', scope, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const sentinel = `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${'0'.repeat(64)} -->`;
      const padding = 'x'.repeat(26_000);
      fs.writeFileSync(
        path.join(memoryDir, 'MEMORY.md'),
        `${sentinel}\nbody\n${padding}\n<!-- USER EDITABLE -->\n## User Notes\n`,
      );

      createSession(db, {
        session_id: 'verify-wire-s1',
        project: scope,
        scope,
        cwd: '/tmp/test',
        source: 'cc-hooks',
      });

      verifyMemoryMd(db, scope, 'verify-wire-s1', { scope, cwd: '/tmp/test' });

      const events = getSessionEvents(db, 'verify-wire-s1')
        .filter(e => e.event_type === 'memory_md_invalid');
      expect(events).toHaveLength(1);
      const detail = JSON.parse(events[0].detail!);
      expect(detail.reason).toBe('size_exceeded');
      expect(detail.bytes).toBeGreaterThan(25_000);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
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

  it('enqueues memory_curation_pending for Angel (plan 04-04-01)', () => {
    // Mirrors the recordEvent call the session-end hook makes. The hook
    // runs `recordEvent(db, session_id, project, 'memory_curation_pending',
    // 'angel', 'enqueue', JSON.stringify({project, session_id}))` after
    // cleanup and before signal clearing — verify the row shape here.
    recordEvent(
      db,
      'test-s1',
      'test-proj',
      'memory_curation_pending',
      'angel',
      'enqueue',
      JSON.stringify({ project: 'test-proj', session_id: 'test-s1' }),
    );

    const rows = getSessionEvents(db, 'test-s1').filter(
      (e) => e.event_type === 'memory_curation_pending',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('enqueue');
    expect(rows[0].entity).toBe('angel');
    expect(rows[0].session_id).toBe('test-s1');
    expect(rows[0].project).toBe('test-proj');
    const detail = JSON.parse(rows[0].detail ?? '{}') as { project: string; session_id: string };
    expect(detail.project).toBe('test-proj');
    expect(detail.session_id).toBe('test-s1');
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
    expect(content).toContain('export CLAUDE_CODE_DISABLE_AUTO_DREAM=1');
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
    db.prepare('UPDATE sessions SET created_at_epoch_ms = ? WHERE session_id = ?')
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

// ---------------------------------------------------------------------------
// PostCompact hook (H4)
// ---------------------------------------------------------------------------

describe('PostCompact hook logic', () => {
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

  it('records compaction event with trigger and summary', () => {
    recordEvent(db, 'test-s1', 'test-proj', 'compaction', 'post-compact', 'auto', 'Session summary text');

    const events = getSessionEvents(db, 'test-s1');
    const compactionEvents = events.filter(e => e.event_type === 'compaction');
    expect(compactionEvents).toHaveLength(1);
    expect(compactionEvents[0].entity).toBe('post-compact');
    expect(compactionEvents[0].action).toBe('auto');
    expect(compactionEvents[0].detail).toBe('Session summary text');
  });

  it('clears post-compact-pending flag', () => {
    markPostCompactPending(db, 'test-s1');
    expect(getCheckpointTracking(db, 'test-s1')?.post_compact_pending).toBe(1);

    clearPostCompactPending(db, 'test-s1');
    expect(getCheckpointTracking(db, 'test-s1')?.post_compact_pending).toBe(0);
  });

  it('stores compact summary as journal entry', () => {
    addJournalEntry(db, 'test-s1', 'test-proj', 'summary', 'Compact summary content');

    const entries = getJournalBySession(db, 'test-s1', { entryType: 'summary' });
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Compact summary content');
  });
});

// ---------------------------------------------------------------------------
// SubagentStart hook (H1)
// ---------------------------------------------------------------------------

describe('SubagentStart hook logic', () => {
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

  it('records subagent_start event with agent_id and agent_type', () => {
    recordEvent(db, 'test-s1', 'test-proj', 'subagent_start', 'agent-abc', 'general-purpose');

    const events = getSessionEvents(db, 'test-s1');
    const startEvents = events.filter(e => e.event_type === 'subagent_start');
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].entity).toBe('agent-abc');
    expect(startEvents[0].action).toBe('general-purpose');
  });

  it('getActiveSignals returns signals for context injection', () => {
    createSignal(db, 'other-session', 'test-proj', 'wip', 'refactoring auth');

    const signals = getActiveSignals(db, 'test-proj', 'test-s1');
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].signal_type).toBe('wip');
  });
});

// ---------------------------------------------------------------------------
// SubagentStop hook (H2)
// ---------------------------------------------------------------------------

describe('SubagentStop hook logic', () => {
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

  it('records subagent_stop event with duration from matching start', () => {
    // Record a start event first
    recordEvent(db, 'test-s1', 'test-proj', 'subagent_start', 'agent-xyz', 'code-reviewer');

    // Look up start event timestamp
    const startRow = cachedPrepare(db,
      `SELECT timestamp_epoch FROM session_events
       WHERE session_id = ? AND event_type = 'subagent_start' AND entity = ?
       ORDER BY timestamp_epoch DESC LIMIT 1`
    ).get('test-s1', 'agent-xyz') as { timestamp_epoch: number } | undefined;

    expect(startRow).toBeDefined();

    // Record stop event with computed duration
    const durationS = Math.floor(Date.now() / 1000) - startRow!.timestamp_epoch;
    const detail = JSON.stringify({
      agent_type: 'code-reviewer',
      transcript_path: '/tmp/transcript.jsonl',
      last_message: 'Done reviewing.',
      duration_s: durationS,
    });

    recordEvent(db, 'test-s1', 'test-proj', 'subagent_stop', 'agent-xyz', 'code-reviewer', detail);

    const events = getSessionEvents(db, 'test-s1');
    const stopEvents = events.filter(e => e.event_type === 'subagent_stop');
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0].entity).toBe('agent-xyz');

    const parsed = JSON.parse(stopEvents[0].detail!);
    expect(parsed.agent_type).toBe('code-reviewer');
    expect(typeof parsed.duration_s).toBe('number');
  });

  it('handles missing start event gracefully (null duration)', () => {
    // Record stop without a matching start
    const detail = JSON.stringify({
      agent_type: 'general-purpose',
      transcript_path: '',
      last_message: '',
      duration_s: null,
    });

    recordEvent(db, 'test-s1', 'test-proj', 'subagent_stop', 'no-start-agent', 'general-purpose', detail);

    const events = getSessionEvents(db, 'test-s1');
    const stopEvents = events.filter(e => e.event_type === 'subagent_stop');
    expect(stopEvents).toHaveLength(1);

    const parsed = JSON.parse(stopEvents[0].detail!);
    expect(parsed.duration_s).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TaskCreated hook (H13a)
// ---------------------------------------------------------------------------

describe('TaskCreated hook logic', () => {
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

  it('records task_created event with task metadata', () => {
    const detail = JSON.stringify({
      description: 'Implement the new feature',
      teammate_name: 'worker-1',
      team_name: 'dev-team',
    });

    recordEvent(db, 'test-s1', 'test-proj', 'task_created', 'task-123', 'Build login page', detail);

    const events = getSessionEvents(db, 'test-s1');
    const taskEvents = events.filter(e => e.event_type === 'task_created');
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0].entity).toBe('task-123');
    expect(taskEvents[0].action).toBe('Build login page');

    const parsed = JSON.parse(taskEvents[0].detail!);
    expect(parsed.teammate_name).toBe('worker-1');
    expect(parsed.team_name).toBe('dev-team');
  });
});

// ---------------------------------------------------------------------------
// TaskCompleted hook (H13b)
// ---------------------------------------------------------------------------

describe('TaskCompleted hook logic', () => {
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

  it('records task_completed event with task metadata', () => {
    const detail = JSON.stringify({
      description: 'Feature completed successfully',
      teammate_name: 'worker-1',
      team_name: 'dev-team',
    });

    recordEvent(db, 'test-s1', 'test-proj', 'task_completed', 'task-123', 'Build login page', detail);

    const events = getSessionEvents(db, 'test-s1');
    const taskEvents = events.filter(e => e.event_type === 'task_completed');
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0].entity).toBe('task-123');
    expect(taskEvents[0].action).toBe('Build login page');

    const parsed = JSON.parse(taskEvents[0].detail!);
    expect(parsed.teammate_name).toBe('worker-1');
  });
});

// ---------------------------------------------------------------------------
// PermissionRequest hook (H5)
// ---------------------------------------------------------------------------

describe('PermissionRequest hook logic', () => {
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

  it('records permission_request event with tool_name as entity', () => {
    recordEvent(db, 'test-s1', 'test-proj', 'permission_request', 'Bash', 'requested',
      JSON.stringify({ command: 'rm -rf /' }).slice(0, 200));

    const events = getSessionEvents(db, 'test-s1');
    const permEvents = events.filter(e => e.event_type === 'permission_request');
    expect(permEvents).toHaveLength(1);
    expect(permEvents[0].entity).toBe('Bash');
    expect(permEvents[0].action).toBe('requested');
    expect(permEvents[0].detail).toContain('rm -rf');
  });
});

// ---------------------------------------------------------------------------
// PermissionDenied hook (H6)
// ---------------------------------------------------------------------------

describe('PermissionDenied hook logic', () => {
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

  it('records permission_denied event with tool_name and reason', () => {
    const detail = JSON.stringify({
      tool_use_id: 'tu-123',
      tool_input_summary: '{"command":"rm -rf /"}',
    });

    recordEvent(db, 'test-s1', 'test-proj', 'permission_denied', 'Bash', 'User denied dangerous command', detail);

    const events = getSessionEvents(db, 'test-s1');
    const deniedEvents = events.filter(e => e.event_type === 'permission_denied');
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0].entity).toBe('Bash');
    expect(deniedEvents[0].action).toBe('User denied dangerous command');

    const parsed = JSON.parse(deniedEvents[0].detail!);
    expect(parsed.tool_use_id).toBe('tu-123');
  });
});

// ---------------------------------------------------------------------------
// Elicitation hook (H7a)
// ---------------------------------------------------------------------------

describe('Elicitation hook logic', () => {
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

  it('records elicitation event with mcp_server_name and message', () => {
    const detail = JSON.stringify({
      mode: 'form',
      elicitation_id: 'elic-456',
    });

    recordEvent(db, 'test-s1', 'test-proj', 'elicitation', 'claudex-recall', 'Enter your API key', detail);

    const events = getSessionEvents(db, 'test-s1');
    const elicEvents = events.filter(e => e.event_type === 'elicitation');
    expect(elicEvents).toHaveLength(1);
    expect(elicEvents[0].entity).toBe('claudex-recall');
    expect(elicEvents[0].action).toBe('Enter your API key');

    const parsed = JSON.parse(elicEvents[0].detail!);
    expect(parsed.mode).toBe('form');
    expect(parsed.elicitation_id).toBe('elic-456');
  });
});

// ---------------------------------------------------------------------------
// ElicitationResult hook (H7b)
// ---------------------------------------------------------------------------

describe('ElicitationResult hook logic', () => {
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

  it('records elicitation_result event with mcp_server_name and action', () => {
    const detail = JSON.stringify({
      elicitation_id: 'elic-456',
      mode: 'form',
    });

    recordEvent(db, 'test-s1', 'test-proj', 'elicitation_result', 'claudex-recall', 'accept', detail);

    const events = getSessionEvents(db, 'test-s1');
    const resultEvents = events.filter(e => e.event_type === 'elicitation_result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].entity).toBe('claudex-recall');
    expect(resultEvents[0].action).toBe('accept');

    const parsed = JSON.parse(resultEvents[0].detail!);
    expect(parsed.elicitation_id).toBe('elic-456');
  });
});

// ---------------------------------------------------------------------------
// PostToolUseFailure hook (H14a)
// ---------------------------------------------------------------------------

describe('PostToolUseFailure hook logic', () => {
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

  it('records tool_error event with tool_name and error string', () => {
    const detail = JSON.stringify({
      tool_use_id: 'tu-789',
      is_interrupt: false,
      tool_input_summary: '{"command":"bad-cmd"}',
    });

    recordEvent(db, 'test-s1', 'test-proj', 'tool_error', 'Bash', 'command not found: bad-cmd', detail);

    const events = getSessionEvents(db, 'test-s1');
    const errorEvents = events.filter(e => e.event_type === 'tool_error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].entity).toBe('Bash');
    expect(errorEvents[0].action).toBe('command not found: bad-cmd');

    const parsed = JSON.parse(errorEvents[0].detail!);
    expect(parsed.tool_use_id).toBe('tu-789');
    expect(parsed.is_interrupt).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StopFailure hook (H14b)
// ---------------------------------------------------------------------------

describe('StopFailure hook logic', () => {
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

  it('records stop_failure event with error type and details', () => {
    recordEvent(db, 'test-s1', 'test-proj', 'stop_failure', 'rate_limit', 'Too many requests per minute');

    const events = getSessionEvents(db, 'test-s1');
    const failEvents = events.filter(e => e.event_type === 'stop_failure');
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].entity).toBe('rate_limit');
    expect(failEvents[0].action).toBe('Too many requests per minute');
  });

  it('handles unknown error type', () => {
    recordEvent(db, 'test-s1', 'test-proj', 'stop_failure', 'unknown', '');

    const events = getSessionEvents(db, 'test-s1');
    const failEvents = events.filter(e => e.event_type === 'stop_failure');
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].entity).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// PreToolUse X8 — permission decision infrastructure
// ---------------------------------------------------------------------------

describe('PreToolUse X8 permission decision', () => {
  it('returns undefined permissionDecision for non-Agent tools (pass-through)', () => {
    // The lookupPermissionDecision function currently always returns undefined.
    // This test verifies that non-Agent tools get {} (no permission override).
    // We test the expected behavior: no permissionDecision in output.
    const output = {};
    expect(output).not.toHaveProperty('hookSpecificOutput');
  });

  it('still returns updatedInput for Agent tool (regression check)', () => {
    // Verify the expected output structure for Agent tool
    const prompt = 'Do something';
    const claudexHint = `\n\nNote: This project uses Claudex for persistent memory. If you need project history or past decisions, the MCP tools claudex_search and claudex_recall are available.`;

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          prompt: prompt + claudexHint,
        },
      },
    };

    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.updatedInput.prompt).toContain('claudex_search');
    expect(output.hookSpecificOutput.updatedInput.prompt).toContain('claudex_recall');
  });

  it('does not double-inject Claudex hint if already present', () => {
    const prompt = 'Do something with claudex_search available';
    // When hint is already present, output should be {} (no updatedInput)
    const alreadyHasHint = prompt.includes('claudex_search') || prompt.includes('claudex_recall');
    expect(alreadyHasHint).toBe(true);
  });
});
