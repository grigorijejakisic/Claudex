import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractObservation } from '../../src/lib/observation-extractor.js';
import { recordFileTouch, readFilesTouched } from '../../src/checkpoint/state-files.js';
import { getIncrementalThresholds } from '../../src/lib/token-gauge.js';
import type { Scope } from '../../src/shared/types.js';

// Mock logger and metrics (state-files.ts uses these)
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/shared/metrics.js', () => ({
  recordMetric: vi.fn(),
}));

// =============================================================================
// Helpers
// =============================================================================

const TEST_SESSION = 'sess-ptu-state-test';
const PROJECT_SCOPE: Scope = { type: 'project', name: 'test-project', path: '/test/project' };
const GLOBAL_SCOPE: Scope = { type: 'global' };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-ptu-state-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// Tests
// =============================================================================

describe('PostToolUse Step 3.7: files-touched state updates', () => {
  it('records file touch for Write tool with files_modified', () => {
    const observation = extractObservation(
      'Write',
      { file_path: '/src/new-file.ts' },
      undefined,
      TEST_SESSION,
      PROJECT_SCOPE,
    );

    expect(observation).not.toBeNull();
    expect(observation!.files_modified).toBeDefined();
    expect(observation!.files_modified!.length).toBeGreaterThan(0);

    // Simulate Step 3.7
    for (const filePath of observation!.files_modified!) {
      recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Write', observation!.title);
    }

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(1);
    expect(state.changed[0]!.path).toBe('/src/new-file.ts');
    expect(state.changed[0]!.action).toBe('Write');
    expect(state.changed[0]!.summary).toBe(observation!.title);
    expect(state.hot).toContain('/src/new-file.ts');
  });

  it('records file touch for Edit tool with files_modified', () => {
    const observation = extractObservation(
      'Edit',
      { file_path: '/src/existing.ts', old_string: 'old', new_string: 'new' },
      undefined,
      TEST_SESSION,
      PROJECT_SCOPE,
    );

    expect(observation).not.toBeNull();
    expect(observation!.files_modified).toBeDefined();
    expect(observation!.files_modified!.length).toBeGreaterThan(0);

    for (const filePath of observation!.files_modified!) {
      recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Edit', observation!.title);
    }

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(1);
    expect(state.changed[0]!.action).toBe('Edit');
    expect(state.hot).toContain('/src/existing.ts');
  });

  it('does not record file touch for Read tool (no files_modified)', () => {
    const observation = extractObservation(
      'Read',
      { file_path: '/src/foo.ts' },
      { output: 'file contents' },
      TEST_SESSION,
      PROJECT_SCOPE,
    );

    expect(observation).not.toBeNull();
    // Read observations have files_read but NOT files_modified
    expect(observation!.files_modified).toBeUndefined();

    // Simulate Step 3.7 guard
    if (observation!.files_modified && observation!.files_modified.length > 0) {
      for (const filePath of observation!.files_modified) {
        recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Read', observation!.title);
      }
    }

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(0);
    expect(state.hot.length).toBe(0);
  });

  it('does not crash when observation.files_modified is undefined', () => {
    // Simulate an observation without files_modified
    const observation = {
      session_id: TEST_SESSION,
      timestamp: new Date().toISOString(),
      timestamp_epoch: Date.now(),
      tool_name: 'Bash',
      category: 'execution' as const,
      title: 'ran command',
      content: 'output',
      importance: 1,
      // files_modified intentionally omitted
    };

    expect(() => {
      if (observation.files_modified && observation.files_modified.length > 0) {
        // Should not enter this block
        throw new Error('Should not reach here');
      }
    }).not.toThrow();
  });

  it('does not crash when observation.files_modified is empty array', () => {
    const observation = {
      session_id: TEST_SESSION,
      timestamp: new Date().toISOString(),
      timestamp_epoch: Date.now(),
      tool_name: 'Write',
      category: 'change' as const,
      title: 'wrote file',
      content: 'content',
      importance: 3,
      files_modified: [] as string[],
    };

    expect(() => {
      if (observation.files_modified && observation.files_modified.length > 0) {
        for (const filePath of observation.files_modified) {
          recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Write', observation.title);
        }
      }
    }).not.toThrow();

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(0);
  });

  it('writes state file to correct session-scoped path', () => {
    recordFileTouch(tmpDir, TEST_SESSION, '/src/test.ts', 'Write', 'test write');

    const expectedDir = path.join(tmpDir, 'context', 'state', TEST_SESSION);
    const expectedFile = path.join(expectedDir, 'files-touched.yaml');

    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(expectedFile)).toBe(true);

    // Verify content is valid YAML with expected structure
    const content = fs.readFileSync(expectedFile, 'utf-8');
    expect(content).toContain('/src/test.ts');
    expect(content).toContain('Write');
  });
});

// =============================================================================
// Incremental checkpoint threshold state tests
// =============================================================================

/**
 * Mirrors IncrementalCheckpointState from post-tool-use.ts (local interface).
 * Tests the JSON state file format and window_size change detection logic.
 */
interface IncrementalCheckpointState {
  last_threshold_index: number;
  last_checkpoint_epoch: number;
  window_size?: number;
}

describe('PostToolUse Step 5: incremental checkpoint threshold state', () => {
  it('threshold state file round-trips with window_size', () => {
    const stateDir = path.join(tmpDir, 'context', 'state', TEST_SESSION);
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFilePath = path.join(stateDir, '.incremental-cp.json');

    const state: IncrementalCheckpointState = {
      last_threshold_index: 1,
      last_checkpoint_epoch: Date.now(),
      window_size: 200_000,
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf-8');

    const loaded: IncrementalCheckpointState = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    expect(loaded.last_threshold_index).toBe(1);
    expect(loaded.window_size).toBe(200_000);
  });

  it('detects window_size change from 200k to 1M', () => {
    const prevState: IncrementalCheckpointState = {
      last_threshold_index: 1,
      last_checkpoint_epoch: Date.now() - 60_000,
      window_size: 200_000,
    };

    const newWindowSize = 1_000_000;
    const windowSizeChanged = prevState.window_size !== undefined && prevState.window_size !== newWindowSize;
    expect(windowSizeChanged).toBe(true);
  });

  it('does not flag window_size change when sizes match', () => {
    const prevState: IncrementalCheckpointState = {
      last_threshold_index: 0,
      last_checkpoint_epoch: Date.now() - 30_000,
      window_size: 200_000,
    };

    const newWindowSize = 200_000;
    const windowSizeChanged = prevState.window_size !== undefined && prevState.window_size !== newWindowSize;
    expect(windowSizeChanged).toBe(false);
  });

  it('does not flag window_size change when previous state has no window_size (legacy)', () => {
    // Simulates a state file written before window_size tracking was added
    const prevState: IncrementalCheckpointState = {
      last_threshold_index: 0,
      last_checkpoint_epoch: Date.now() - 30_000,
      // window_size intentionally omitted (legacy state)
    };

    const newWindowSize = 1_000_000;
    const windowSizeChanged = prevState.window_size !== undefined && prevState.window_size !== newWindowSize;
    expect(windowSizeChanged).toBe(false);
  });

  it('recomputes crossedIndex on window_size change', () => {
    // Simulate: was at 200k threshold index 1 (90%), now window is 1M
    const totalTokens = 185_000; // above 200k's 90% (180k), but not above 1M's 15% (150k)... actually 185k > 150k
    const newThresholds = getIncrementalThresholds(1_000_000);

    // Recompute: find highest threshold crossed with new thresholds
    let crossedIndex = -1;
    for (let i = newThresholds.length - 1; i >= 0; i--) {
      if (totalTokens >= newThresholds[i]!) { crossedIndex = i; break; }
    }

    // 185k >= 150k (15% of 1M), so crossedIndex should be 0
    expect(crossedIndex).toBe(0);
    expect(newThresholds[0]).toBe(150_000);
  });

  it('dynamic thresholds differ by window size', () => {
    const thresholds200k = getIncrementalThresholds(200_000);
    const thresholds1M = getIncrementalThresholds(1_000_000);

    // 200k: 2 thresholds (75%, 90%)
    expect(thresholds200k).toHaveLength(2);
    expect(thresholds200k[0]).toBe(150_000); // 75% of 200k
    expect(thresholds200k[1]).toBe(180_000); // 90% of 200k

    // 1M: 6 thresholds (15%, 30%, 45%, 60%, 75%, 90%)
    expect(thresholds1M).toHaveLength(6);
    expect(thresholds1M[0]).toBe(150_000);   // 15% of 1M
    expect(thresholds1M[5]).toBe(900_000);   // 90% of 1M
  });
});
