import {
  THRESHOLDS_200K,
  THRESHOLDS_1M,
  WINDOW_THRESHOLD,
  type CheckpointV3,
  type CheckpointTrigger,
  type SelectiveLoadPreset,
} from '../../checkpoint/types.js';

describe('checkpoint types', () => {
  it('CheckpointV3 schema field is always claudex/checkpoint', () => {
    const cp: CheckpointV3 = {
      schema: 'claudex/checkpoint',
      version: 3,
      meta: {
        checkpoint_id: 'test',
        session_id: 's1',
        scope: null,
        trigger: 'threshold',
        token_usage: null,
        previous_checkpoint: null,
      },
      working: { task: null, status: null, next_action: null, branch: null },
      decisions: [],
      files: { hot: [], read: [] },
      thread: { topic: null, summary: null, key_exchanges: [] },
      open_items: [],
      learnings: [],
      gsd: null,
    };
    expect(cp.schema).toBe('claudex/checkpoint');
  });

  it('CheckpointV3 version is always 3', () => {
    const cp: CheckpointV3 = {
      schema: 'claudex/checkpoint',
      version: 3,
      meta: {
        checkpoint_id: 'test',
        session_id: 's1',
        scope: null,
        trigger: 'threshold',
        token_usage: null,
        previous_checkpoint: null,
      },
      working: { task: null, status: null, next_action: null, branch: null },
      decisions: [],
      files: { hot: [], read: [] },
      thread: { topic: null, summary: null, key_exchanges: [] },
      open_items: [],
      learnings: [],
      gsd: null,
    };
    expect(cp.version).toBe(3);
  });

  it('THRESHOLDS_200K contains 75% and 90%', () => {
    expect(THRESHOLDS_200K).toEqual([0.75, 0.90]);
  });

  it('THRESHOLDS_1M contains 6 thresholds from 15% to 90%', () => {
    expect(THRESHOLDS_1M).toEqual([0.15, 0.30, 0.45, 0.60, 0.75, 0.90]);
    expect(THRESHOLDS_1M).toHaveLength(6);
  });

  it('WINDOW_THRESHOLD is 500000', () => {
    expect(WINDOW_THRESHOLD).toBe(500_000);
  });

  it('CheckpointTrigger union covers threshold, compaction, session_end', () => {
    const triggers: CheckpointTrigger[] = ['threshold', 'compaction', 'session_end'];
    expect(triggers).toHaveLength(3);
    expect(triggers).toContain('threshold');
    expect(triggers).toContain('compaction');
    expect(triggers).toContain('session_end');
  });

  it('SelectiveLoadPreset union covers ALWAYS, RESUME, GSD', () => {
    const presets: SelectiveLoadPreset[] = ['ALWAYS', 'RESUME', 'GSD'];
    expect(presets).toHaveLength(3);
    expect(presets).toContain('ALWAYS');
    expect(presets).toContain('RESUME');
    expect(presets).toContain('GSD');
  });
});
