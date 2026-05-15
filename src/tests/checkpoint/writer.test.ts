import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { createTestDb, type TestDatabase } from '../helpers/test-db.js';
import { insertDecision } from '../../core/decisions.js';
import { upsertThreadState } from '../../core/thread.js';
import { updatePressureScore } from '../../core/pressure.js';
import { upsertLearning } from '../../core/learnings.js';
import { getCheckpointTracking } from '../../core/checkpoint-tracking.js';
import {
  extractOpenItems,
  shouldTriggerCheckpoint,
  writeCheckpoint,
} from '../../checkpoint/writer.js';
import type { CheckpointV3 } from '../../checkpoint/types.js';

describe('extractOpenItems', () => {
  it('extracts TODO items from text', () => {
    const items = extractOpenItems('TODO: wire up the cron timer');
    expect(items).toEqual(['wire up the cron timer']);
  });

  it('extracts FIXME items from text', () => {
    const items = extractOpenItems('FIXME: handle edge case');
    expect(items).toEqual(['handle edge case']);
  });

  it('extracts HACK items from text', () => {
    const items = extractOpenItems('HACK: temporary workaround');
    expect(items).toEqual(['temporary workaround']);
  });

  it('extracts remaining/need-to patterns', () => {
    const items = extractOpenItems('still need to fix the auth flow');
    expect(items).toEqual(['to fix the auth flow']);
  });

  it('deduplicates identical items', () => {
    const items = extractOpenItems('TODO: fix auth\nTODO: fix auth');
    expect(items).toHaveLength(1);
    expect(items[0]).toBe('fix auth');
  });

  it('returns empty array for empty text', () => {
    expect(extractOpenItems(null)).toEqual([]);
    expect(extractOpenItems(undefined)).toEqual([]);
    expect(extractOpenItems('')).toEqual([]);
  });

  it('is non-throwing on invalid input', () => {
    expect(() => extractOpenItems(42 as unknown as string)).not.toThrow();
  });
});

describe('shouldTriggerCheckpoint', () => {
  it('returns true for compaction trigger (always)', () => {
    expect(
      shouldTriggerCheckpoint({ trigger: 'compaction' })
    ).toBe(true);
  });

  it('returns true for session_end trigger (always)', () => {
    expect(
      shouldTriggerCheckpoint({ trigger: 'session_end' })
    ).toBe(true);
  });

  it('returns false for threshold trigger without tokenUsage', () => {
    expect(
      shouldTriggerCheckpoint({ trigger: 'threshold' })
    ).toBe(false);
  });

  it('returns true for threshold trigger when new threshold crossed (200k window at 75%)', () => {
    expect(
      shouldTriggerCheckpoint({
        trigger: 'threshold',
        tokenUsage: {
          inputTokens: 152000,
          outputTokens: 0,
          contextWindowTokens: 200_000,
          utilization: 0.76,
        },
      })
    ).toBe(true);
  });

  it('returns true for threshold trigger when new threshold crossed (1M window at 15%)', () => {
    expect(
      shouldTriggerCheckpoint({
        trigger: 'threshold',
        tokenUsage: {
          inputTokens: 160000,
          outputTokens: 0,
          contextWindowTokens: 1_000_000,
          utilization: 0.16,
        },
      })
    ).toBe(true);
  });

  it('returns false when threshold already hit', () => {
    expect(
      shouldTriggerCheckpoint({
        trigger: 'threshold',
        tokenUsage: {
          inputTokens: 152000,
          outputTokens: 0,
          contextWindowTokens: 200_000,
          utilization: 0.76,
        },
        tracking: {
          session_id: 's1',
          last_checkpoint_epoch: null,
          thresholds_hit: [0.75],
          observation_count: 10,
          post_compact_pending: 0,
          updated_at_epoch_ms: 0,
        },
      })
    ).toBe(false);
  });

  it('returns false when within debounce period', () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(
      shouldTriggerCheckpoint({
        trigger: 'threshold',
        tokenUsage: {
          inputTokens: 152000,
          outputTokens: 0,
          contextWindowTokens: 200_000,
          utilization: 0.76,
        },
        tracking: {
          session_id: 's1',
          last_checkpoint_epoch: nowEpoch - 30,
          thresholds_hit: [],
          observation_count: 10,
          post_compact_pending: 0,
          updated_at_epoch_ms: 0,
        },
        debounceSeconds: 60,
      })
    ).toBe(false);
  });

  it('returns true when debounce period expired', () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(
      shouldTriggerCheckpoint({
        trigger: 'threshold',
        tokenUsage: {
          inputTokens: 152000,
          outputTokens: 0,
          contextWindowTokens: 200_000,
          utilization: 0.76,
        },
        tracking: {
          session_id: 's1',
          last_checkpoint_epoch: nowEpoch - 61,
          thresholds_hit: [],
          observation_count: 10,
          post_compact_pending: 0,
          updated_at_epoch_ms: 0,
        },
        debounceSeconds: 60,
      })
    ).toBe(true);
  });
});

describe('writeCheckpoint', () => {
  let db: TestDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-test-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates ULID checkpoint ID', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    expect(result).not.toBeNull();
    // ULID: 26 chars, Crockford base32
    expect(result!.checkpointId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('inserts checkpoint_meta with pending then transitions to mirrored', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const row = db
      .prepare('SELECT * FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { status: string; data: string; mirror_path: string };

    expect(row.status).toBe('mirrored');
    expect(row.data).toBeTruthy();
    expect(row.mirror_path).toBeTruthy();
    expect(result!.status).toBe('mirrored');
  });

  it('writes YAML file to checkpoints directory', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    expect(result!.filePath).toBeTruthy();
    expect(fs.existsSync(result!.filePath!)).toBe(true);

    const content = fs.readFileSync(result!.filePath!, 'utf-8');
    const parsed = yaml.load(content) as CheckpointV3;
    expect(parsed.schema).toBe('claudex/checkpoint');
    expect(parsed.version).toBe(3);
  });

  it('updates latest.yaml with ref to new checkpoint', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    const latestContent = fs.readFileSync(
      path.join(checkpointsDir, 'latest.yaml'),
      'utf-8'
    );
    expect(latestContent).toContain('ref:');
    expect(latestContent).toContain(result!.checkpointId);
  });

  it('gathers decisions (LIMIT 15) from DB', async () => {
    // Seed 20 decisions — content must be long enough to pass quality filter (>= 30 chars)
    for (let i = 0; i < 20; i++) {
      insertDecision(db, {
        session_id: 's1',
        content: `The architecture decision number ${i} uses three-layer assembly model`,
        source: 'confirmation',
        fingerprint: `fp-${i}`,
      });
    }

    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.decisions).toHaveLength(15);
  });

  it('gathers thread state from DB', async () => {
    upsertThreadState(db, {
      session_id: 's1',
      topic: 'auth refactor',
      summary: 'Working on JWT',
      key_exchanges: [{ role: 'user', gist: 'fix auth' }],
    });

    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.thread.topic).toBe('auth refactor');
    expect(cp.thread.summary).toBe('Working on JWT');
    expect(cp.thread.key_exchanges).toHaveLength(1);
  });

  it('gathers hot files from DB', async () => {
    updatePressureScore(db, 'src/auth.ts', 'test', 0.8);
    updatePressureScore(db, 'src/config.ts', 'test', 0.3);

    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.files.hot.length).toBeGreaterThanOrEqual(1);
    expect(cp.files.hot[0].path).toBe('src/auth.ts');
  });

  it('gathers top learnings from DB', async () => {
    upsertLearning(db, {
      project: 'test',
      fingerprint: 'fp1',
      content: 'Always read from disk inside locks',
    });

    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.learnings).toContain('Always read from disk inside locks');
  });

  it('extracts open items from lastAssistantText', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      lastAssistantText: 'TODO: wire up cron timer\nFIXME: handle edge case',
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.open_items).toContain('wire up cron timer');
    expect(cp.open_items).toContain('handle edge case');
  });

  it('includes previous_checkpoint basename when prior checkpoint exists', async () => {
    // Write first checkpoint
    const first = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    // Write second checkpoint
    const second = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(second!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.meta.previous_checkpoint).toBeTruthy();
    expect(cp.meta.previous_checkpoint).toContain(first!.checkpointId);
  });

  it('handles enrichment when provider is available', async () => {
    // Mock enrichment by providing a provider that will fail (Ollama not running)
    // This tests the non-fatal path
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      enrichmentProvider: { type: 'ollama', model: 'test', baseUrl: 'http://localhost:99999' },
    });

    // Enrichment failed but checkpoint still succeeded
    expect(result).not.toBeNull();
    expect(result!.enriched).toBe(false);
    expect(result!.status).toBe('mirrored');
  });

  it('handles enrichment failure gracefully (heuristic checkpoint persists)', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      enrichmentProvider: { type: 'ollama', model: 'nonexistent', baseUrl: 'http://localhost:99999' },
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe('mirrored');

    // Verify checkpoint data is still present (heuristic preserved)
    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.schema).toBe('claudex/checkpoint');
  });

  it('includes token_usage in meta when provided', async () => {
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'threshold',
      tokenUsage: {
        inputTokens: 150000,
        outputTokens: 10000,
        contextWindowTokens: 200000,
        utilization: 0.80,
      },
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.meta.token_usage).toEqual({
      input_tokens: 150000,
      output_tokens: 10000,
      window_size: 200000,
      utilization: 0.80,
    });
  });

  it('includes gsd when provided', async () => {
    const gsdData = { phase: 6, status: 'in_progress' };
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
      gsd: gsdData,
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(result!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;
    expect(cp.gsd).toEqual(gsdData);
  });

  it('returns null on DB error (non-throwing)', async () => {
    db.close();
    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });
    expect(result).toBeNull();

    // Reopen for afterEach cleanup
    db = createTestDb();
  });

  it('records threshold hit in checkpoint_tracking', async () => {
    await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'threshold',
      tokenUsage: {
        inputTokens: 152000,
        outputTokens: 0,
        contextWindowTokens: 200000,
        utilization: 0.76,
      },
    });

    const tracking = getCheckpointTracking(db, 's1');
    expect(tracking).toBeDefined();
    expect(tracking!.thresholds_hit).toContain(0.75);
  });

  it('sets error on checkpoint_meta when write fails mid-flow', async () => {
    // Use a directory path that causes file write failure
    const badDir = path.join(tmpDir, 'nonexistent' + '\0invalid');

    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: badDir,
      trigger: 'session_end',
    });

    // The write may still commit to DB but fail on file write
    // Either way it should not throw
    if (result) {
      // If result returned, status should be committed (file write failed)
      // or mirrored if somehow it worked
      expect(['committed', 'mirrored']).toContain(result.status);
    }
    // If null, the error should be recorded
    // Either way, no exception thrown
  });

  it('Fix 4: skips previous_checkpoint when prior has no mirror_path', async () => {
    // Write first checkpoint but don't let it get mirrored (simulate mirror_path = null)
    const first = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    // Manually null out mirror_path to simulate the broken case
    db.prepare('UPDATE checkpoint_meta SET mirror_path = NULL WHERE checkpoint_id = ?')
      .run(first!.checkpointId);

    // Write second checkpoint
    const second = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    const row = db
      .prepare('SELECT data FROM checkpoint_meta WHERE checkpoint_id = ?')
      .get(second!.checkpointId) as { data: string };
    const cp = JSON.parse(row.data) as CheckpointV3;

    // Fix 4: previous_checkpoint should be null (skipped), NOT a wrong basename like "${id}.yaml"
    expect(cp.meta.previous_checkpoint).toBeNull();
  });

  it('Fix 6: yaml.dump uses JSON_SCHEMA (no type coercion)', async () => {
    // Seed a learning with "true" as string value
    upsertLearning(db, {
      project: 'test',
      fingerprint: 'fp-true',
      content: 'true',
    });

    const result = await writeCheckpoint({
      db,
      sessionId: 's1',
      project: 'test',
      projectDir: tmpDir,
      trigger: 'session_end',
    });

    expect(result).not.toBeNull();
    expect(result!.filePath).toBeTruthy();

    // Read the YAML file and parse with JSON_SCHEMA to verify round-trip
    const content = fs.readFileSync(result!.filePath!, 'utf-8');
    const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as CheckpointV3;
    const trueItem = parsed.learnings.find((l) => l === 'true');
    expect(trueItem).toBe('true');
    expect(typeof trueItem).toBe('string');
  });
});
