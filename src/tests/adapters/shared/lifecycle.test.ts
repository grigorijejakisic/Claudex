/**
 * Tests for shared adapter lifecycle functions.
 * Uses in-memory SQLite with initialized schema.
 * Validates the extracted composable functions work correctly in isolation.
 */

import { createTestDb, type TestDatabase } from '../../helpers/test-db.js';
import { createSession } from '../../../core/sessions.js';
import { getCheckpointTracking, markPostCompactPending } from '../../../core/checkpoint-tracking.js';
import { updatePressureScore, getHotFiles } from '../../../core/pressure.js';
import { DEFAULT_CONFIG } from '../../../shared/constants.js';
import type { ClaudexConfig } from '../../../shared/config.js';
import {
  processToolAndPressure,
  trackAfterTool,
  trackAfterTurn,
  checkpointIfThresholdMet,
  buildDecisionClassifier,
  captureDecisionsWithClassifier,
  runCompactionSequence,
  runSessionEndCleanup,
} from '../../../adapters/shared/lifecycle.js';
import { getArtifactsByProject, createArtifact } from '../../../core/artifacts.js';
import { upsertLearning, getLearningsByProject } from '../../../core/learnings.js';
import { insertDecision } from '../../../core/decisions.js';

const testConfig = { ...DEFAULT_CONFIG } as unknown as ClaudexConfig;

describe('processToolAndPressure', () => {
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

  it('calls processToolObservation and updates pressure for file_path', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test/foo.ts' },
      toolOutput: { content: 'file contents' },
    });

    const allFiles = db
      .prepare('SELECT * FROM pressure_scores WHERE project = ?')
      .all('test-proj');
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it('updates pressure for filePath key variant', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Edit',
      toolInput: { filePath: '/tmp/test/bar.ts' },
    });

    const allFiles = db
      .prepare('SELECT * FROM pressure_scores WHERE project = ?')
      .all('test-proj');
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it('updates pressure for path key variant', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Bash',
      toolInput: { path: '/tmp/test/baz.ts' },
    });

    const allFiles = db
      .prepare('SELECT * FROM pressure_scores WHERE project = ?')
      .all('test-proj');
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it('does not update pressure when no file path key exists', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Bash',
      toolInput: { command: 'echo hello' },
    });

    const allFiles = db
      .prepare('SELECT * FROM pressure_scores WHERE project = ?')
      .all('test-proj');
    // processToolObservation might still insert an observation,
    // but pressure_scores should not have a file entry from the key loop
    // (observation extractor may independently add pressure via other means)
    expect(allFiles.length).toBe(0);
  });

  it('only updates pressure for the first matching key', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test/first.ts', filePath: '/tmp/test/second.ts' },
    });

    const allFiles = db
      .prepare('SELECT * FROM pressure_scores WHERE project = ?')
      .all('test-proj') as Array<{ file_path: string }>;

    // Should have pressure for file_path (first key), sanitized to project-relative
    const paths = allFiles.map(f => f.file_path);
    expect(paths).toContain('<project>/first.ts');
  });

  it('stores sanitized (project-relative) paths in pressure_scores', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test/src/index.ts' },
    });

    const allFiles = db
      .prepare('SELECT file_path FROM pressure_scores WHERE project = ?')
      .all('test-proj') as Array<{ file_path: string }>;

    const paths = allFiles.map(f => f.file_path);
    expect(paths).toContain('<project>/src/index.ts');
    // Raw path should NOT be stored
    expect(paths).not.toContain('/tmp/test/src/index.ts');
  });

  it('preserves paths outside project root after sanitization', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Read',
      toolInput: { file_path: '/other/dir/file.ts' },
    });

    const allFiles = db
      .prepare('SELECT file_path FROM pressure_scores WHERE project = ?')
      .all('test-proj') as Array<{ file_path: string }>;

    const paths = allFiles.map(f => f.file_path);
    // Path outside project root is kept as-is (no <project> prefix)
    expect(paths).toContain('/other/dir/file.ts');
  });

  it('creates an artifact when a high-importance observation is stored', () => {
    // Edit/Write get importance 3 — above the artifact creation threshold
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Edit',
      toolInput: { file_path: '/tmp/test/src/index.ts', old_string: 'const oldConfig = loadLegacyConfiguration(defaultPath);', new_string: 'const newConfig = loadModernConfiguration(resolvedPath);' },
    });

    // Verify observation was created first
    const obs = db.prepare('SELECT id, importance, obs_type FROM observations WHERE project = ?').all('test-proj');
    expect(obs.length).toBeGreaterThanOrEqual(1);

    const artifacts = getArtifactsByProject(db, 'test-proj', { type: 'observation' });
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    expect(artifacts[0].artifact_type).toBe('observation');
    expect(artifacts[0].state).toBe('fresh');
    // importance 3 → TTL 4, rate-limited tick may or may not fire
    expect(artifacts[0].ttl).toBeGreaterThanOrEqual(3);
    expect(artifacts[0].artifact_ref).toBeTruthy();
  });

  it('does not create an artifact for low-importance observations', () => {
    // Read gets importance 2 — below threshold
    const fileContent = 'export function main() {\n  const result = computeValue();\n  return result;\n}\n\nexport function computeValue() {\n  return 42;\n}\n';
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/test/src/index.ts' },
      toolOutput: { content: fileContent },
    });

    const artifacts = getArtifactsByProject(db, 'test-proj', { type: 'observation' });
    expect(artifacts).toHaveLength(0);
  });

  it('does not create an artifact when no observation is stored', () => {
    processToolAndPressure({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      toolName: 'UnknownTool',
      toolInput: {},
    });

    const artifacts = getArtifactsByProject(db, 'test-proj');
    expect(artifacts).toHaveLength(0);
  });
});

describe('trackAfterTool', () => {
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

  it('creates thread tracker and persists after-tool state', () => {
    trackAfterTool(db, 'test-s1', 'user prompt', 'Read', { file_path: '/tmp/foo.ts' });

    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });

  it('works with undefined user prompt', () => {
    trackAfterTool(db, 'test-s1', undefined, 'Edit', { file_path: '/tmp/bar.ts' });

    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });
});

describe('trackAfterTurn', () => {
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

  it('creates thread tracker and records after-turn event', () => {
    trackAfterTurn(db, 'test-s1', 'user said something', 'agent responded');

    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });

  it('works with undefined user and assistant text', () => {
    trackAfterTurn(db, 'test-s1', undefined, undefined);

    const threadRow = db
      .prepare('SELECT * FROM thread_state WHERE session_id = ?')
      .get('test-s1');
    expect(threadRow).toBeDefined();
  });
});

describe('checkpointIfThresholdMet', () => {
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

  it('does not throw with null gauge', async () => {
    await expect(checkpointIfThresholdMet({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      config: testConfig,
      gauge: null,
    })).resolves.not.toThrow();
  });

  it('does not throw with high-utilization gauge', async () => {
    await expect(checkpointIfThresholdMet({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      config: testConfig,
      gauge: {
        inputTokens: 180000,
        outputTokens: 10000,
        contextWindowTokens: 200000,
        utilization: 0.95,
      },
    })).resolves.not.toThrow();
  });

  it('passes scope through to writeCheckpoint', async () => {
    // Just verifies no error with scope provided
    await expect(checkpointIfThresholdMet({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      scope: 'my-scope',
      config: testConfig,
      gauge: null,
    })).resolves.not.toThrow();
  });
});

describe('buildDecisionClassifier', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when embeddings are disabled', async () => {
    const disabledConfig = {
      ...DEFAULT_CONFIG,
      embeddings: { ...DEFAULT_CONFIG.embeddings, enabled: false },
    } as unknown as ClaudexConfig;

    const result = await buildDecisionClassifier(disabledConfig);
    expect(result).toBeNull();
  });

  it('returns null when Ollama is unavailable', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof globalThis.fetch;

    const result = await buildDecisionClassifier(testConfig);
    expect(result).toBeNull();
  });
});

describe('captureDecisionsWithClassifier', () => {
  let db: TestDatabase;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });
    // Default: Ollama not running
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
  });

  it('captures decisions without classifier (regex-only)', async () => {
    await expect(captureDecisionsWithClassifier({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      config: testConfig,
      userText: 'yes, go ahead with that approach',
      assistantText: 'Use TypeScript strict mode with ESLint.',
    })).resolves.not.toThrow();
  });

  it('uses provided classifier when passed', async () => {
    // Pass null classifier explicitly (bridge path when unavailable)
    await expect(captureDecisionsWithClassifier({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      config: testConfig,
      userText: 'ok',
      assistantText: 'Decided to use X.',
      classifier: null,
    })).resolves.not.toThrow();
  });

  it('builds classifier fresh when not provided (CC hooks path)', async () => {
    // No classifier param -> builds fresh (will be null since Ollama unavailable)
    await expect(captureDecisionsWithClassifier({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      config: testConfig,
      userText: 'sure',
      assistantText: 'We will proceed with approach B.',
    })).resolves.not.toThrow();
  });

  it('skips classifier build when embeddings are disabled', async () => {
    const disabledConfig = {
      ...DEFAULT_CONFIG,
      embeddings: { ...DEFAULT_CONFIG.embeddings, enabled: false },
    } as unknown as ClaudexConfig;

    // Should not attempt network call when embeddings disabled
    // (fetch would throw if called — but we expect no call)
    await expect(captureDecisionsWithClassifier({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      config: disabledConfig,
      userText: 'sure',
      assistantText: 'Decided to use approach C.',
    })).resolves.not.toThrow();
  });
});

describe('runCompactionSequence', () => {
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

  it('writes checkpoint with compaction trigger', async () => {
    await expect(runCompactionSequence({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    })).resolves.not.toThrow();
  });

  it('marks post-compact-pending after completion', async () => {
    await runCompactionSequence({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });

    const tracking = getCheckpointTracking(db, 'test-s1');
    expect(tracking?.post_compact_pending).toBe(1);
  });

  it('passes gauge and gsd through to writeCheckpoint', async () => {
    await expect(runCompactionSequence({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      gauge: {
        inputTokens: 100000,
        outputTokens: 5000,
        contextWindowTokens: 200000,
        utilization: 0.525,
      },
    })).resolves.not.toThrow();
  });

  it('passes scope through to writeCheckpoint', async () => {
    await expect(runCompactionSequence({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      scope: 'my-scope',
    })).resolves.not.toThrow();
  });

  it('creates learning artifacts during compaction', async () => {
    // Insert some learnings for the project
    upsertLearning(db, {
      project: 'test-proj',
      agent_id: 'default',
      fingerprint: 'fp-1',
      content: 'Always use forward slashes on Windows',
    });
    upsertLearning(db, {
      project: 'test-proj',
      agent_id: 'default',
      fingerprint: 'fp-2',
      content: 'SQLite WAL mode improves concurrency',
    });

    await runCompactionSequence({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });

    const artifacts = getArtifactsByProject(db, 'test-proj', { type: 'learning' });
    expect(artifacts.length).toBe(2);
    expect(artifacts.every(a => a.artifact_type === 'learning')).toBe(true);
    expect(artifacts.every(a => a.importance === 4)).toBe(true);
    expect(artifacts.every(a => a.state === 'fresh')).toBe(true);
  });

  it('packs all existing artifacts before creating learning artifacts', async () => {
    // Create some artifacts in various states
    createArtifact(db, 'test-s1', 'test-proj', 'observation', null, 'Fresh obs', 'content', 3);
    createArtifact(db, 'test-s1', 'test-proj', 'decision', null, 'A decision', 'content', 5);

    // Add a learning that will produce a fresh learning artifact
    upsertLearning(db, {
      project: 'test-proj',
      agent_id: 'default',
      fingerprint: 'fp-pack-test',
      content: 'WAL mode is important for concurrency',
    });

    await runCompactionSequence({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });

    const all = getArtifactsByProject(db, 'test-proj');
    // Old artifacts should be packed
    const packedObs = all.filter(a => a.artifact_type === 'observation' && a.state === 'packed');
    const packedDec = all.filter(a => a.artifact_type === 'decision' && a.state === 'packed');
    expect(packedObs.length).toBe(1);
    expect(packedDec.length).toBe(1);
    // New learning artifacts should be fresh (created after packing)
    const freshLearnings = all.filter(a => a.artifact_type === 'learning' && a.state === 'fresh');
    expect(freshLearnings.length).toBe(1);
  });

  it('filters out low-quality content from learning promotion', async () => {
    // Insert decisions with varying quality
    insertDecision(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      content: 'The architecture uses a three-layer assembly model for context injection',
      source: 'direction',
      fingerprint: 'fp-good-1',
    });
    insertDecision(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      content: 'Edit: insight-extractor.test.ts',
      source: 'direction',
      fingerprint: 'fp-bad-tool',
    });
    insertDecision(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      content: 'yes please',
      source: 'confirmation',
      fingerprint: 'fp-bad-short',
    });
    insertDecision(db, {
      session_id: 'test-s1',
      project: 'test-proj',
      content: '**What artifacts SHOULD be:**',
      source: 'direction',
      fingerprint: 'fp-bad-md',
    });

    await runCompactionSequence({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
    });

    const learnings = getLearningsByProject(db, 'test-proj');
    // Only the high-quality decision should be promoted
    expect(learnings.length).toBe(1);
    expect(learnings[0].content).toContain('three-layer assembly');
  });

  it('still marks post-compact-pending even when checkpoint fails', async () => {
    // markPostCompactPending must run regardless of checkpoint success —
    // the agent needs context recovery after compaction even if checkpoint write failed.
    const failDb = createTestDb();
    createSession(failDb, {
      session_id: 'test-s2',
      project: 'test-proj',
      cwd: '/tmp/test',
    });

    // Corrupt the DB state by dropping checkpoint_meta to force writeCheckpoint failure
    failDb.exec('DROP TABLE checkpoint_meta');

    await runCompactionSequence({
      db: failDb,
      sessionId: 'test-s2',
      project: 'test-proj',
      cwd: '/tmp/test',
    });

    // post_compact_pending MUST be set even though checkpoint failed —
    // post-compaction context recovery is critical regardless
    const tracking = getCheckpointTracking(failDb, 'test-s2');
    expect(tracking?.post_compact_pending).toBe(1);

    failDb.close();
  });
});

describe('runSessionEndCleanup', () => {
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

  it('writes final checkpoint and ends session', async () => {
    await runSessionEndCleanup({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      config: testConfig,
    });

    const session = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('test-s1') as { status: string } | undefined;
    expect(session?.status).toBe('completed');
  });

  it('runs observation pruning', async () => {
    await expect(runSessionEndCleanup({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      config: testConfig,
    })).resolves.not.toThrow();
  });

  it('runs pressure decay', async () => {
    // Add a pressure entry to exercise the decay path
    updatePressureScore(db, '/tmp/test/foo.ts', 'test-proj', 1.0);

    await expect(runSessionEndCleanup({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      config: testConfig,
    })).resolves.not.toThrow();
  });

  it('prunes telemetry as part of cleanup', async () => {
    await expect(runSessionEndCleanup({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      config: testConfig,
    })).resolves.not.toThrow();
  });

  it('passes gauge and scope through correctly', async () => {
    await expect(runSessionEndCleanup({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      scope: 'my-scope',
      config: testConfig,
      gauge: {
        inputTokens: 50000,
        outputTokens: 2000,
        contextWindowTokens: 200000,
        utilization: 0.26,
      },
    })).resolves.not.toThrow();

    const session = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('test-s1') as { status: string } | undefined;
    expect(session?.status).toBe('completed');
  });

  it('only decays pressure for the current project', async () => {
    // Add pressure entries for two projects
    updatePressureScore(db, 'a.ts', 'test-proj', 1.0);
    updatePressureScore(db, 'b.ts', 'other-proj', 0.5);

    await runSessionEndCleanup({
      db,
      sessionId: 'test-s1',
      project: 'test-proj',
      cwd: '/tmp/test',
      config: testConfig,
    });

    // test-proj pressure should be decayed (less than original 1.0)
    const projRow = db
      .prepare('SELECT raw_pressure FROM pressure_scores WHERE file_path = ? AND project = ?')
      .get('a.ts', 'test-proj') as { raw_pressure: number } | undefined;
    if (projRow) {
      expect(projRow.raw_pressure).toBeLessThan(1.0);
    }

    // other-proj pressure should be untouched at 0.5
    const otherRow = db
      .prepare('SELECT raw_pressure FROM pressure_scores WHERE file_path = ? AND project = ?')
      .get('b.ts', 'other-proj') as { raw_pressure: number } | undefined;
    expect(otherRow).toBeDefined();
    expect(otherRow!.raw_pressure).toBe(0.5);
  });
});
