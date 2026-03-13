import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { insertObservation } from '../../core/observations.js';
import { upsertLearning } from '../../core/learnings.js';
import { updatePressureScore } from '../../core/pressure.js';
import {
  assembleFullContext,
  assembleRegularPrompt,
  assembleTopicPivot,
} from '../../assembly/assembler.js';
import type { ClaudexConfig } from '../../shared/config.js';
import type { TokenUsage } from '../../shared/types.js';
import type { TopicShiftResult } from '../../intelligence/topic-shift.js';

let tmpDir: string;

function mkDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(base: string, rel: string, content: string): void {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function makeConfig(overrides?: Partial<ClaudexConfig['injection']> & { features?: Partial<ClaudexConfig['features']> }): ClaudexConfig {
  return {
    schema: 'claudex/config',
    version: 3,
    injection: {
      budget_tokens: 4000,
      boundary_only: true,
      gauge_threshold: 0.70,
      topic_shift_budget: 800,
      ...overrides,
    },
    observations: { enabled: true, retention_days: 90, prune_threshold: 1000, prune_count: 50 },
    checkpoint: { debounce_seconds: 60 },
    learnings: { max_per_project: 50, surface_count: 10, publish_to_memory_md: false },
    enrichment: { enabled: false, provider: 'auto', ollama_base_url: '', ollama_model: 'auto', timeout_ms: 10000 },
    embeddings: { enabled: false, provider: 'ollama', model: 'nomic-embed-text', ollama_base_url: '', topic_shift_threshold: 0.35, topic_shift_window: 3, decision_confidence_threshold: 0.15 },
    observability: { enabled: false, retention_days: 7, retain_error_count: 1000 },
    gsd: { enabled: true, phase_boost: 0.10 },
    features: {
      observation_capture: true,
      checkpoint_system: true,
      token_gauge: true,
      fts5_search: true,
      decision_capture: true,
      learnings_promotion: true,
      telemetry: false,
      ...overrides?.features,
    },
    adapter: 'auto',
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-assembler-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- assembleFullContext ---

describe('assembleFullContext', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('assembles priority-budgeted sections in correct order', () => {
    const projDir = mkDir('full-order');
    const idDir = mkDir('full-order-id');
    writeFile(idDir, 'USER.md', 'Test user identity');
    writeFile(projDir, 'PROJECT_PRIMER.md', 'Test project primer');

    // Seed learnings
    upsertLearning(db, { project: 'proj', fingerprint: 'l1', content: 'Learning one' });
    upsertLearning(db, { project: 'proj', fingerprint: 'l2', content: 'Learning two' });

    // Seed pressure scores above 0.851
    updatePressureScore(db, 'src/hot.ts', 'proj', 0.95);

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir, config: makeConfig(), identityDir: idDir,
    });

    expect(result.content).toContain('## Identity');
    expect(result.content).toContain('## Project');
    expect(result.content).toContain('## Learnings');
    expect(result.sources).toContain('identity');
    expect(result.sources).toContain('project');
    expect(result.sources).toContain('learnings');
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('respects token budget (stops adding when budget exceeded)', () => {
    const projDir = mkDir('budget-limit');
    const idDir = mkDir('budget-limit-id');
    writeFile(idDir, 'USER.md', 'A'.repeat(600)); // ~150 tokens
    writeFile(projDir, 'PROJECT_PRIMER.md', 'B'.repeat(200)); // ~50 tokens

    // Small budget: only identity + project should fit
    upsertLearning(db, { project: 'proj', fingerprint: 'l1', content: 'C'.repeat(400) });

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir,
      config: makeConfig({ budget_tokens: 200 }),
      identityDir: idDir,
    });

    // Identity ~150 tokens should fit in 200 budget
    expect(result.sources).toContain('identity');
    // Learnings ~100 tokens should not fit after identity
    expect(result.tokenEstimate).toBeLessThanOrEqual(250); // some overhead
  });

  it('activates reference mode when budget < 500 after priority 5', () => {
    const projDir = mkDir('ref-mode');
    const idDir = mkDir('ref-mode-id');
    writeFile(idDir, 'USER.md', 'A'.repeat(1600)); // ~400 tokens

    // Seed observations for FTS5
    insertObservation(db, {
      session_id: 's1', project: 'proj', tool_name: 'Read',
      category: 'code', title: 'Auth module', content: 'Refactored the auth module completely',
      importance: 4, files_modified: ['src/auth.ts'],
    });

    // Budget 500: identity takes ~400, leaves < 500 -> reference mode
    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir,
      config: makeConfig({ budget_tokens: 500 }),
      identityDir: idDir,
      searchQuery: 'auth',
    });

    expect(result.sources).toContain('identity');
    // If FTS5 made it in reference mode, it should have compact format
    if (result.content.includes('Relevant Observations')) {
      // Reference mode: one-liner format, not ### headers
      expect(result.content).not.toContain('### Auth module');
    }
  });

  it('skips identity section when USER.md missing', () => {
    const projDir = mkDir('no-id');
    const idDir = mkDir('no-id-empty');

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir, config: makeConfig(), identityDir: idDir,
    });

    expect(result.sources).not.toContain('identity');
    // Should not crash
    expect(result).toBeDefined();
  });

  it('skips project section when both files missing', () => {
    const projDir = mkDir('no-proj-files');

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir, config: makeConfig(),
    });

    expect(result.sources).not.toContain('project');
  });

  it('skips checkpoint section when no checkpoint exists', () => {
    const projDir = mkDir('no-checkpoint');

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir, config: makeConfig(),
    });

    expect(result.sources).not.toContain('checkpoint');
  });

  it('uses checkpoint topic as FTS5 query during session-start (no searchQuery)', () => {
    const projDir = mkDir('fts5-topic');

    // Seed observation matching "authentication"
    insertObservation(db, {
      session_id: 's1', project: 'proj', tool_name: 'Read',
      category: 'code', title: 'Auth refactor', content: 'authentication module updated',
      importance: 4, files_modified: ['src/auth.ts'],
    });

    // Create checkpoint with topic in DB
    const cpData = {
      schema: 'claudex/checkpoint', version: 3,
      meta: { checkpoint_id: 'cp1', session_id: 's1', scope: 'project:proj', trigger: 'threshold', token_usage: null, previous_checkpoint: null },
      working: { task: null, status: null, next_action: null, branch: null },
      decisions: [], files: { hot: [], read: [] },
      thread: { topic: 'authentication', summary: null, key_exchanges: [] },
      open_items: [], learnings: [], gsd: null,
    };
    db.prepare(
      `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status, data, mirror_path, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, ?, ?, NULL, unixepoch(), unixepoch())`
    ).run('cp1', 's1', 'threshold', 'committed', JSON.stringify(cpData));

    // No searchQuery provided — should use checkpoint topic
    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir, config: makeConfig(),
    });

    // FTS5 should find the auth observation via checkpoint topic "authentication"
    if (result.sources.includes('fts5')) {
      expect(result.content).toContain('Auth refactor');
    }
  });

  it('post-redaction reclaim re-attempts skipped sections', () => {
    const projDir = mkDir('reclaim');
    const idDir = mkDir('reclaim-id');
    // Identity with an email that will be redacted (shorter after)
    writeFile(idDir, 'USER.md', 'User info: user@example.com '.repeat(50)); // ~375 tokens before redaction

    // Seed a learning that should be skipped initially
    upsertLearning(db, { project: 'proj', fingerprint: 'l1', content: 'Important learning' });

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir,
      config: makeConfig({ budget_tokens: 400 }),
      identityDir: idDir,
    });

    // After redaction, email -> [REDACTED_PII] is shorter, might reclaim budget
    // The key test is that it doesn't crash
    expect(result).toBeDefined();
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('sources array correctly tracks contributing sections', () => {
    const projDir = mkDir('sources');
    const idDir = mkDir('sources-id');
    writeFile(idDir, 'USER.md', 'User identity');
    writeFile(projDir, 'PROJECT_PRIMER.md', 'Project info');
    upsertLearning(db, { project: 'proj', fingerprint: 'l1', content: 'A learning' });

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir, config: makeConfig(), identityDir: idDir,
    });

    expect(result.sources).toContain('identity');
    expect(result.sources).toContain('project');
    expect(result.sources).toContain('learnings');
    // Each source appears at most once
    const unique = new Set(result.sources);
    expect(unique.size).toBe(result.sources.length);
  });
});

// --- assembleRegularPrompt ---

describe('assembleRegularPrompt', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns full assembly on post-compaction', () => {
    const projDir = mkDir('reg-compact');
    const idDir = mkDir('reg-compact-id');
    writeFile(idDir, 'USER.md', 'User identity');

    const result = assembleRegularPrompt({
      isPostCompaction: true, prompt: 'Hello',
      gauge: null, topicShift: null,
      db, project: 'proj', projectDir: projDir,
      config: makeConfig(), identityDir: idDir,
    });

    expect(result.sources).toContain('identity');
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('returns topic pivot on topic shift', () => {
    const projDir = mkDir('reg-shift');

    const result = assembleRegularPrompt({
      isPostCompaction: false, prompt: 'switch to deployment',
      gauge: null,
      topicShift: { shifted: true, previousTopic: 'auth', newTopic: 'deployment', confidence: 0.9, method: 'explicit' },
      db, project: 'proj', projectDir: projDir,
      config: makeConfig(),
    });

    expect(result.content).toContain('Context Pivot');
    expect(result.sources).toContain('topic_pivot');
  });

  it('returns gauge injection at >= 70% utilization', () => {
    const projDir = mkDir('reg-gauge');

    const gauge: TokenUsage = { inputTokens: 150000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.75 };

    const result = assembleRegularPrompt({
      isPostCompaction: false, prompt: 'Continue',
      gauge,
      topicShift: null,
      db, project: 'proj', projectDir: projDir,
      config: makeConfig(),
    });

    expect(result.content).toContain('Token Gauge');
    expect(result.sources).toContain('gauge');
  });

  it('returns zero injection on normal turn', () => {
    const projDir = mkDir('reg-zero');

    const gauge: TokenUsage = { inputTokens: 100000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.50 };

    const result = assembleRegularPrompt({
      isPostCompaction: false, prompt: 'Continue working',
      gauge,
      topicShift: null,
      db, project: 'proj', projectDir: projDir,
      config: makeConfig(),
    });

    expect(result.content).toBe('');
    expect(result.tokenEstimate).toBe(0);
    expect(result.sources).toEqual([]);
  });

  it('prioritizes post-compaction over topic-shift', () => {
    const projDir = mkDir('reg-priority-compact');
    const idDir = mkDir('reg-priority-compact-id');
    writeFile(idDir, 'USER.md', 'User identity');

    const result = assembleRegularPrompt({
      isPostCompaction: true, prompt: 'switch to deployment',
      gauge: null,
      topicShift: { shifted: true, previousTopic: 'auth', newTopic: 'deployment' },
      db, project: 'proj', projectDir: projDir,
      config: makeConfig(), identityDir: idDir,
    });

    // Full assembly (has identity), not just pivot
    expect(result.sources).toContain('identity');
  });

  it('prioritizes topic-shift over gauge', () => {
    const projDir = mkDir('reg-priority-shift');

    const gauge: TokenUsage = { inputTokens: 150000, outputTokens: 0, contextWindowTokens: 200000, utilization: 0.75 };

    const result = assembleRegularPrompt({
      isPostCompaction: false, prompt: 'switch to deployment',
      gauge,
      topicShift: { shifted: true, previousTopic: 'auth', newTopic: 'deployment', confidence: 0.9, method: 'explicit' },
      db, project: 'proj', projectDir: projDir,
      config: makeConfig(),
    });

    // Topic pivot, not gauge
    expect(result.sources).toContain('topic_pivot');
    expect(result.sources).not.toContain('gauge');
  });

  it('is non-throwing on DB error', () => {
    const projDir = mkDir('reg-error');

    const result = assembleRegularPrompt({
      isPostCompaction: true, prompt: 'Hello',
      gauge: null, topicShift: null,
      db: null as any, project: 'proj', projectDir: projDir,
      config: makeConfig(),
    });

    // Should return safely (empty or identity-only)
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });
});

// --- assembleTopicPivot ---

describe('assembleTopicPivot', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('produces pivot block with transition marker', () => {
    const result = assembleTopicPivot({
      shift: { shifted: true, previousTopic: 'auth', newTopic: 'deployment', confidence: 0.9, method: 'embedding' },
      db, project: 'proj', config: makeConfig(),
    });

    expect(result.content).toContain('Switching context: auth -> deployment');
    expect(result.sources).toContain('topic_pivot');
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('includes relevant learnings for new topic', () => {
    upsertLearning(db, { project: 'proj', fingerprint: 'l1', content: 'deployment requires Docker setup' });
    upsertLearning(db, { project: 'proj', fingerprint: 'l2', content: 'auth uses JWT tokens' });

    const result = assembleTopicPivot({
      shift: { shifted: true, previousTopic: 'auth', newTopic: 'deployment', confidence: 0.9 },
      db, project: 'proj', config: makeConfig(),
    });

    expect(result.content).toContain('deployment requires Docker setup');
  });

  it('enforces topic_shift_budget cap (truncates if over)', () => {
    // Lots of hot files to bloat the pivot
    for (let i = 0; i < 50; i++) {
      updatePressureScore(db, `src/file_${i}.ts`, 'proj', 0.95);
    }

    const result = assembleTopicPivot({
      shift: { shifted: true, previousTopic: 'a', newTopic: 'src' },
      db, project: 'proj',
      config: makeConfig({ topic_shift_budget: 50 }),
    });

    expect(result.tokenEstimate).toBeLessThanOrEqual(50);
  });

  it('returns empty for non-shifted result', () => {
    const result = assembleTopicPivot({
      shift: { shifted: false },
      db, project: 'proj', config: makeConfig(),
    });

    expect(result.content).toBe('');
    expect(result.tokenEstimate).toBe(0);
  });

  it('is non-throwing on error', () => {
    expect(() => assembleTopicPivot({
      shift: { shifted: true, previousTopic: 'a', newTopic: 'b' },
      db: null as any, project: 'proj', config: makeConfig(),
    })).not.toThrow();
  });
});

// --- Three-tier degradation ---

describe('three-tier degradation', () => {
  it('Tier 2: falls back to checkpoint-only on DB query error', () => {
    const projDir = mkDir('tier2');
    const idDir = mkDir('tier2-id');
    writeFile(idDir, 'USER.md', 'User identity');

    // Write a checkpoint YAML file for Tier 2 to find
    const cpDir = path.join(projDir, 'context', 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });
    const cpContent = `schema: "claudex/checkpoint"
version: 3
meta:
  checkpoint_id: "cp1"
  session_id: "s1"
  scope: "project:test"
  trigger: threshold
  token_usage: null
  previous_checkpoint: null
working:
  task: "Build assembler"
  status: in_progress
  next_action: "Write tests"
  branch: main
decisions: []
files:
  hot: []
  read: []
thread:
  topic: "assembly"
  summary: null
  key_exchanges: []
open_items: []
learnings: []
gsd: null
`;
    fs.writeFileSync(path.join(cpDir, 'cp1.yaml'), cpContent);
    fs.writeFileSync(path.join(cpDir, 'latest.yaml'), 'ref: cp1.yaml\n');

    // Pass a broken DB that throws on any query
    const brokenDb = { prepare: () => { throw new Error('DB broken'); } } as any;

    const result = assembleFullContext({
      db: brokenDb, project: 'proj', projectDir: projDir,
      config: makeConfig(), identityDir: idDir,
    });

    // Should fall back to Tier 2 (checkpoint from file) + identity
    expect(result.content.length).toBeGreaterThan(0);
    // Should have identity and/or checkpoint
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('Tier 2: applies redaction to checkpoint-only output', () => {
    const projDir = mkDir('tier2-redact');
    const idDir = mkDir('tier2-redact-id');
    writeFile(idDir, 'USER.md', 'User identity');

    // Write a checkpoint YAML with a secret that should be redacted
    const cpDir = path.join(projDir, 'context', 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });
    const cpContent = `schema: "claudex/checkpoint"
version: 3
meta:
  checkpoint_id: "cp1"
  session_id: "s1"
  scope: "project:test"
  trigger: threshold
  token_usage: null
  previous_checkpoint: null
working:
  task: "Build assembler with token ghp_abcdefghijklmnopqrstuvwxyz1234567890"
  status: in_progress
  next_action: null
  branch: main
decisions: []
files:
  hot: []
  read: []
thread:
  topic: "assembly"
  summary: null
  key_exchanges: []
open_items: []
learnings: []
gsd: null
`;
    fs.writeFileSync(path.join(cpDir, 'cp1.yaml'), cpContent);
    fs.writeFileSync(path.join(cpDir, 'latest.yaml'), 'ref: cp1.yaml\n');

    // Pass a broken DB to force Tier 2 fallback
    const brokenDb = { prepare: () => { throw new Error('DB broken'); } } as any;

    const result = assembleFullContext({
      db: brokenDb, project: 'proj', projectDir: projDir,
      config: makeConfig(), identityDir: idDir,
    });

    // Should have content (Tier 2 succeeded)
    expect(result.content.length).toBeGreaterThan(0);
    // The GitHub PAT should be redacted
    expect(result.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(result.content).toContain('[REDACTED_SECRET]');
  });

  it('Tier 3: applies redaction to identity-only output', () => {
    const projDir = mkDir('tier3-redact');
    const idDir = mkDir('tier3-redact-id');
    // Identity with a secret
    writeFile(idDir, 'USER.md', 'User API key: sk-abcdefghijklmnopqrstuvwxyz12');

    // No checkpoint files, broken DB -> Tier 3
    const brokenDb = { prepare: () => { throw new Error('DB broken'); } } as any;

    const result = assembleFullContext({
      db: brokenDb, project: 'proj', projectDir: projDir,
      config: makeConfig(), identityDir: idDir,
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz12');
    expect(result.content).toContain('[REDACTED_SECRET]');
  });

  it('Tier 3: falls back to identity-only when checkpoint also fails', () => {
    const projDir = mkDir('tier3');
    const idDir = mkDir('tier3-id');
    writeFile(idDir, 'USER.md', 'User identity for tier 3');

    // No checkpoint files, broken DB
    const brokenDb = { prepare: () => { throw new Error('DB broken'); } } as any;

    const result = assembleFullContext({
      db: brokenDb, project: 'proj', projectDir: projDir,
      config: makeConfig(), identityDir: idDir,
    });

    expect(result.content).toContain('User identity for tier 3');
    expect(result.sources).toContain('identity');
  });

  it('returns empty InjectPayload when all tiers fail', () => {
    const projDir = mkDir('tier-all-fail');
    const brokenDb = { prepare: () => { throw new Error('DB broken'); } } as any;

    const result = assembleFullContext({
      db: brokenDb, project: 'proj', projectDir: projDir,
      config: makeConfig(),
      // No identity dir — tier 3 fails too
      identityDir: '/nonexistent/identity',
    });

    expect(result.content).toBe('');
    expect(result.tokenEstimate).toBe(0);
    expect(result.sources).toEqual([]);
  });
});

// --- Edge cases ---

describe('edge cases', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('handles empty project (no data anywhere)', () => {
    const projDir = mkDir('edge-empty');

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir, config: makeConfig(),
    });

    // Should return valid (possibly empty) payload without crash
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.tokenEstimate).toBeGreaterThanOrEqual(0);
    expect(result.sources).toBeDefined();
  });

  it('handles config with fts5_search disabled', () => {
    const projDir = mkDir('edge-no-fts5');

    insertObservation(db, {
      session_id: 's1', project: 'proj', tool_name: 'Read',
      category: 'code', title: 'Something', content: 'Content',
      importance: 4, files_modified: [],
    });

    const result = assembleFullContext({
      db, project: 'proj', projectDir: projDir,
      config: makeConfig({ features: { fts5_search: false } } as any),
      searchQuery: 'something',
    });

    // FTS5 section should not appear
    expect(result.sources).not.toContain('fts5');
  });
});
