/**
 * Claudex v3 -- Checkpoint Writer Tests
 *
 * Tests for src/checkpoint/writer.ts.
 * Covers round-trip, sequential numbering, latest.yaml, previous_checkpoint,
 * archive, missing state, GSD, gauge status, checkpoint ID format,
 * writer_version, and scope.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import {
  appendDecision,
  appendQuestion,
  recordFileTouch,
  appendExchange,
  updateThreadSummary,
} from '../../src/checkpoint/state-files.js';
import { writeCheckpoint } from '../../src/checkpoint/writer.js';
import type { WriteCheckpointInput } from '../../src/checkpoint/writer.js';
import type { GaugeReading } from '../../src/lib/token-gauge.js';
import type { Checkpoint } from '../../src/checkpoint/types.js';
import { CHECKPOINT_VERSION } from '../../src/checkpoint/types.js';
import type { GsdState } from '../../src/gsd/types.js';
import { upsertPressureScore } from '../../src/db/pressure.js';
import { storeObservation } from '../../src/db/observations.js';
import { upsertCheckpointState, updateBoostState } from '../../src/db/checkpoint.js';

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Test Helpers
// =============================================================================

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-writer-test-'));
}

function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function makeOkGauge(overrides?: Partial<GaugeReading>): GaugeReading {
  return {
    status: 'ok',
    usage: {
      input_tokens: 162000,
      output_tokens: 8000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    window_size: 200000,
    utilization: 0.81,
    formatted: '[████████░░ 81% | 162k/200k]',
    threshold: 'checkpoint',
    ...overrides,
  };
}

function makeUnavailableGauge(): GaugeReading {
  return {
    status: 'unavailable',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    window_size: 200000,
    utilization: 0,
    formatted: '[Token gauge unavailable]',
    threshold: 'unavailable',
  };
}

function makeBaseInput(overrides?: Partial<WriteCheckpointInput>): WriteCheckpointInput {
  return {
    projectDir: tmpDir,
    sessionId: 'test-session-1',
    scope: 'project:claudex-v2',
    trigger: 'auto-80pct',
    gaugeReading: makeOkGauge(),
    ...overrides,
  };
}

function readCheckpointYaml(filePath: string): Checkpoint {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Checkpoint;
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const runner = new MigrationRunner(db);
  runner.run();
  return db;
}

// =============================================================================
// Setup / Teardown
// =============================================================================

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// =============================================================================
// Tests
// =============================================================================

describe('checkpoint writer', () => {
  it('full round-trip: populate state files, write checkpoint, verify content', () => {
    // Populate state files
    appendDecision(tmpDir, 'test-session-1', {
      id: 'd1',
      what: 'Use tiered boost model',
      why: 'Prevents hard cutoff',
      when: '2026-02-24T14:15:00Z',
      reversible: true,
    });
    appendQuestion(tmpDir, 'test-session-1', 'Should completed boost be 0.0x or 0.5x?');
    recordFileTouch(tmpDir, 'test-session-1', 'src/scoring.ts', 'created', 'New scorer');
    updateThreadSummary(tmpDir, 'test-session-1', 'Designing phase scoring');
    appendExchange(tmpDir, 'test-session-1', { role: 'user', gist: 'Implement scoring' });
    appendExchange(tmpDir, 'test-session-1', { role: 'agent', gist: 'Proposed tiered model' });

    const result = writeCheckpoint(makeBaseInput({
      workingTask: 'Implementing phase scoring',
      nextAction: 'Write tests',
      branch: 'feature/scoring',
    }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.schema).toBe('claudex/checkpoint');
    expect(result!.checkpoint.version).toBe(2);

    // Verify from disk
    const loaded = readCheckpointYaml(result!.path);
    expect(loaded.decisions).toHaveLength(1);
    expect(loaded.decisions[0]!.what).toBe('Use tiered boost model');
    expect(loaded.open_questions).toHaveLength(1);
    expect(loaded.open_questions[0]).toBe('Should completed boost be 0.0x or 0.5x?');
    expect(loaded.files.changed).toHaveLength(1);
    expect(loaded.files.changed[0]!.path).toBe('src/scoring.ts');
    expect(loaded.thread.summary).toBe('Designing phase scoring');
    expect(loaded.thread.key_exchanges).toHaveLength(2);
    expect(loaded.working.task).toBe('Implementing phase scoring');
    expect(loaded.working.next_action).toBe('Write tests');
    expect(loaded.working.branch).toBe('feature/scoring');
  });

  it('sequential numbering within same day (cp1, cp2, cp3)', () => {
    const input = makeBaseInput();

    const r1 = writeCheckpoint(input);
    expect(r1).not.toBeNull();
    expect(r1!.checkpointId).toMatch(/_cp1$/);

    const r2 = writeCheckpoint(input);
    expect(r2).not.toBeNull();
    expect(r2!.checkpointId).toMatch(/_cp2$/);

    const r3 = writeCheckpoint(input);
    expect(r3).not.toBeNull();
    expect(r3!.checkpointId).toMatch(/_cp3$/);
  });

  it('latest.yaml updated with correct ref', () => {
    const result = writeCheckpoint(makeBaseInput());
    expect(result).not.toBeNull();

    const latestPath = path.join(tmpDir, 'context', 'checkpoints', 'latest.yaml');
    expect(fs.existsSync(latestPath)).toBe(true);

    const latestContent = fs.readFileSync(latestPath, 'utf-8');
    expect(latestContent).toContain(`ref: ${result!.checkpointId}.yaml`);
  });

  it('previous_checkpoint links to prior checkpoint (basename only)', () => {
    const input = makeBaseInput();

    const r1 = writeCheckpoint(input);
    expect(r1).not.toBeNull();
    expect(r1!.checkpoint.meta.previous_checkpoint).toBeNull();

    const r2 = writeCheckpoint(input);
    expect(r2).not.toBeNull();
    expect(r2!.checkpoint.meta.previous_checkpoint).toBe(`${r1!.checkpointId}.yaml`);

    // Verify it's basename only (no path separators)
    expect(r2!.checkpoint.meta.previous_checkpoint).not.toContain('/');
    expect(r2!.checkpoint.meta.previous_checkpoint).not.toContain('\\');
  });

  it('state files archived after write (not in original location)', () => {
    appendDecision(tmpDir, 'test-session-1', {
      id: 'd1', what: 'Test', why: 'Testing', when: '2026-02-24T14:00:00Z', reversible: true,
    });

    const stateDir = path.join(tmpDir, 'context', 'state', 'test-session-1');
    expect(fs.existsSync(stateDir)).toBe(true);

    const result = writeCheckpoint(makeBaseInput());
    expect(result).not.toBeNull();

    // Original state dir should no longer exist
    expect(fs.existsSync(stateDir)).toBe(false);

    // Archived dir should exist
    const archivedDir = path.join(tmpDir, 'context', 'state', 'archived', result!.checkpointId);
    expect(fs.existsSync(archivedDir)).toBe(true);
    expect(fs.existsSync(path.join(archivedDir, 'decisions.yaml'))).toBe(true);
  });

  it('does not archive state files when trigger is incremental', () => {
    appendDecision(tmpDir, 'test-session-1', {
      id: 'd1', what: 'Incremental test', why: 'Testing', when: '2026-02-24T14:00:00Z', reversible: true,
    });

    const stateDir = path.join(tmpDir, 'context', 'state', 'test-session-1');
    expect(fs.existsSync(stateDir)).toBe(true);

    const result = writeCheckpoint(makeBaseInput({ trigger: 'incremental' }));
    expect(result).not.toBeNull();

    // State dir should STILL exist — incremental triggers don't archive
    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'decisions.yaml'))).toBe(true);

    // No archived dir should be created for this checkpoint
    const archivedDir = path.join(tmpDir, 'context', 'state', 'archived', result!.checkpointId);
    expect(fs.existsSync(archivedDir)).toBe(false);
  });

  it('archives state files for non-incremental triggers', () => {
    appendDecision(tmpDir, 'test-session-1', {
      id: 'd1', what: 'Pre-compact test', why: 'Testing', when: '2026-02-24T14:00:00Z', reversible: true,
    });

    const stateDir = path.join(tmpDir, 'context', 'state', 'test-session-1');
    expect(fs.existsSync(stateDir)).toBe(true);

    const result = writeCheckpoint(makeBaseInput({ trigger: 'pre-compact' }));
    expect(result).not.toBeNull();

    // State dir should be gone — pre-compact triggers archive
    expect(fs.existsSync(stateDir)).toBe(false);

    // Archived dir should exist
    const archivedDir = path.join(tmpDir, 'context', 'state', 'archived', result!.checkpointId);
    expect(fs.existsSync(archivedDir)).toBe(true);
    expect(fs.existsSync(path.join(archivedDir, 'decisions.yaml'))).toBe(true);
  });

  it('missing state files produce checkpoint with empty sections (not crash)', () => {
    // No state files populated — write should still succeed
    const result = writeCheckpoint(makeBaseInput());

    expect(result).not.toBeNull();
    expect(result!.checkpoint.decisions).toEqual([]);
    expect(result!.checkpoint.open_questions).toEqual([]);
    expect(result!.checkpoint.files.changed).toEqual([]);
    expect(result!.checkpoint.files.read).toEqual([]);
    expect(result!.checkpoint.files.hot).toEqual([]);
    expect(result!.checkpoint.thread.summary).toBe('');
    expect(result!.checkpoint.thread.key_exchanges).toEqual([]);
  });

  it('GSD state included when provided', () => {
    const gsdState: GsdState = {
      active: true,
      position: {
        phase: 3,
        totalPhases: 8,
        phaseName: 'Phase-Weighted Scoring',
        plan: 1,
        totalPlans: 2,
        status: 'executing',
      },
      phases: [
        {
          number: 3,
          name: 'Phase-Weighted Scoring',
          goal: 'Observations weighted by relevance',
          dependsOn: null,
          requirements: ['PCTX-02'],
          successCriteria: [],
          roadmapComplete: false,
          plans: null,
        },
      ],
      warnings: [],
    };

    const result = writeCheckpoint(makeBaseInput({ gsdState }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.gsd).not.toBeNull();
    expect(result!.checkpoint.gsd!.active).toBe(true);
    expect(result!.checkpoint.gsd!.phase).toBe(3);
    expect(result!.checkpoint.gsd!.phase_name).toBe('Phase-Weighted Scoring');
    expect(result!.checkpoint.gsd!.phase_goal).toBe('Observations weighted by relevance');
    expect(result!.checkpoint.gsd!.plan_status).toBe('executing');
    expect(result!.checkpoint.gsd!.requirements).toHaveLength(1);
    expect(result!.checkpoint.gsd!.requirements[0]!.id).toBe('PCTX-02');
  });

  it('GSD state absent when not provided', () => {
    const result = writeCheckpoint(makeBaseInput());

    expect(result).not.toBeNull();
    expect(result!.checkpoint.gsd).toBeNull();
  });

  it('token usage from ok gauge reading', () => {
    const result = writeCheckpoint(makeBaseInput({
      gaugeReading: makeOkGauge({
        usage: {
          input_tokens: 150000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        utilization: 0.75,
      }),
    }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.meta.token_usage.input_tokens).toBe(150000);
    expect(result!.checkpoint.meta.token_usage.output_tokens).toBe(5000);
    expect(result!.checkpoint.meta.token_usage.utilization).toBe(0.75);
  });

  it('unavailable gauge produces checkpoint with zeroed token_usage', () => {
    const result = writeCheckpoint(makeBaseInput({
      gaugeReading: makeUnavailableGauge(),
    }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.meta.token_usage.input_tokens).toBe(0);
    expect(result!.checkpoint.meta.token_usage.output_tokens).toBe(0);
    expect(result!.checkpoint.meta.token_usage.utilization).toBe(0);
    expect(result!.checkpoint.meta.token_usage.window_size).toBe(200000);
  });

  it('checkpoint ID format validation', () => {
    const result = writeCheckpoint(makeBaseInput());

    expect(result).not.toBeNull();
    // Format: YYYY-MM-DD_cpN
    expect(result!.checkpointId).toMatch(/^\d{4}-\d{2}-\d{2}_cp\d+$/);
  });

  it('writer_version stamped correctly', () => {
    const result = writeCheckpoint(makeBaseInput());

    expect(result).not.toBeNull();
    expect(result!.checkpoint.meta.writer_version).toBe('3.0.0');
  });

  it('scope field populated from input', () => {
    const result = writeCheckpoint(makeBaseInput({ scope: 'global' }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.meta.scope).toBe('global');

    const result2 = writeCheckpoint(makeBaseInput({ scope: 'project:my-project' }));

    expect(result2).not.toBeNull();
    expect(result2!.checkpoint.meta.scope).toBe('project:my-project');
  });

  it('token estimate is positive for non-empty checkpoint', () => {
    appendDecision(tmpDir, 'test-session-1', {
      id: 'd1', what: 'Something', why: 'Reason', when: '2026-02-24T14:00:00Z', reversible: true,
    });
    appendQuestion(tmpDir, 'test-session-1', 'Open question here');

    const result = writeCheckpoint(makeBaseInput({ workingTask: 'Active task' }));

    expect(result).not.toBeNull();
    expect(result!.tokenEstimate).toBeGreaterThan(0);
  });

  it('checkpoint version is 2', () => {
    const result = writeCheckpoint(makeBaseInput());
    expect(result).not.toBeNull();
    expect(result!.checkpoint.version).toBe(2);
    expect(CHECKPOINT_VERSION).toBe(2);
  });
});

// =============================================================================
// Enrichment Tests (DB-backed)
// =============================================================================

describe('checkpoint writer enrichment', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('pressure_snapshot populated from DB when db provided', () => {
    // Insert HOT and WARM files (project must match scope in makeBaseInput)
    upsertPressureScore(db, {
      file_path: 'src/hot-file.ts',
      project: 'claudex-v2',
      raw_pressure: 0.9,
      temperature: 'HOT',
      decay_rate: 0.05,
    });
    upsertPressureScore(db, {
      file_path: 'src/warm-file.ts',
      project: 'claudex-v2',
      raw_pressure: 0.5,
      temperature: 'WARM',
      decay_rate: 0.05,
    });
    upsertPressureScore(db, {
      file_path: 'src/cold-file.ts',
      project: 'claudex-v2',
      raw_pressure: 0.1,
      temperature: 'COLD',
      decay_rate: 0.05,
    });

    const result = writeCheckpoint(makeBaseInput({ db }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.pressure_snapshot).toBeDefined();
    expect(result!.checkpoint.pressure_snapshot!.hot).toContain('src/hot-file.ts');
    expect(result!.checkpoint.pressure_snapshot!.warm).toContain('src/warm-file.ts');
    // COLD files should not appear in either list
    expect(result!.checkpoint.pressure_snapshot!.hot).not.toContain('src/cold-file.ts');
    expect(result!.checkpoint.pressure_snapshot!.warm).not.toContain('src/cold-file.ts');
  });

  it('recent_observations populated from DB when db provided', () => {
    // Insert observations (project must match scope in makeBaseInput)
    for (let i = 0; i < 10; i++) {
      storeObservation(db, {
        session_id: 'test-session-1',
        project: 'claudex-v2',
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
        timestamp_epoch: Date.now() - i * 60000,
        tool_name: 'Read',
        category: 'discovery',
        title: `Observation ${i}`,
        content: `Content ${i}`,
        importance: 3,
      });
    }

    const result = writeCheckpoint(makeBaseInput({ db }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.recent_observations).toBeDefined();
    // Should cap at 8 most recent
    expect(result!.checkpoint.recent_observations).toHaveLength(8);
    // Most recent first (getRecentObservations orders DESC)
    expect(result!.checkpoint.recent_observations![0]!.title).toBe('Observation 0');
    expect(result!.checkpoint.recent_observations![0]!.category).toBe('discovery');
    expect(result!.checkpoint.recent_observations![0]!.timestamp_epoch).toBeGreaterThan(0);
  });

  it('boost_state populated from DB when checkpoint state has boost', () => {
    // Create checkpoint state with boost
    upsertCheckpointState(db, 'test-session-1', Date.now(), ['src/a.ts', 'src/b.ts']);
    const boostTime = Date.now() - 5000;
    updateBoostState(db, 'test-session-1', boostTime, 2);

    const result = writeCheckpoint(makeBaseInput({ db }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.boost_state).not.toBeNull();
    expect(result!.checkpoint.boost_state!.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result!.checkpoint.boost_state!.turn).toBe(2);
    expect(result!.checkpoint.boost_state!.applied_at).toBe(boostTime);
  });

  it('boost_state is null when no boost exists in DB', () => {
    // Create checkpoint state WITHOUT boost
    upsertCheckpointState(db, 'test-session-1', Date.now(), ['src/a.ts']);

    const result = writeCheckpoint(makeBaseInput({ db }));

    expect(result).not.toBeNull();
    expect(result!.checkpoint.boost_state).toBeNull();
  });

  it('enrichment fields have empty defaults when db is not provided', () => {
    const result = writeCheckpoint(makeBaseInput());

    expect(result).not.toBeNull();
    expect(result!.checkpoint.pressure_snapshot).toEqual({ hot: [], warm: [] });
    expect(result!.checkpoint.recent_observations).toEqual([]);
    expect(result!.checkpoint.boost_state).toBeNull();
  });

  it('enrichment fields persisted to YAML on disk', () => {
    upsertPressureScore(db, {
      file_path: 'src/main.ts',
      project: 'claudex-v2',
      raw_pressure: 0.8,
      temperature: 'HOT',
      decay_rate: 0.05,
    });

    const result = writeCheckpoint(makeBaseInput({ db }));
    expect(result).not.toBeNull();

    // Read back from disk
    const loaded = readCheckpointYaml(result!.path);
    expect(loaded.pressure_snapshot).toBeDefined();
    expect(loaded.pressure_snapshot!.hot).toContain('src/main.ts');
    expect(loaded.recent_observations).toBeDefined();
    expect(loaded.boost_state).toBeNull();
  });
});
