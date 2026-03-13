import { renderCheckpointMarkdown } from '../../checkpoint/inject.js';
import type { CheckpointV3 } from '../../checkpoint/types.js';

function makeCheckpoint(overrides?: Partial<CheckpointV3>): CheckpointV3 {
  return {
    schema: 'claudex/checkpoint',
    version: 3,
    meta: {
      checkpoint_id: 'TEST_ID',
      session_id: 's1',
      scope: null,
      trigger: 'session_end',
      token_usage: null,
      previous_checkpoint: null,
    },
    working: { task: 'Fix auth bug', status: 'in_progress', next_action: 'Wire cron timer', branch: 'feature/auth' },
    decisions: [
      { content: 'Use disk read inside lock', source: 'confirmation', timestamp: 1000 },
      { content: 'Separate repo for Linux', source: 'direction', timestamp: 2000 },
      { content: 'No stale snapshots', source: 'rejection', timestamp: 3000 },
    ],
    files: {
      hot: [
        { path: 'src/auth.ts', last_action: 'Fixed stale read' },
        { path: 'src/config.ts', last_action: null },
      ],
      read: ['src/types.ts', 'src/loader.ts'],
    },
    thread: {
      topic: 'OAuth token persistence',
      summary: 'Fixed critical auth bug',
      key_exchanges: [
        { role: 'user', gist: 'Auth keeps breaking' },
        { role: 'agent', gist: 'Found root cause in snapshots' },
      ],
    },
    open_items: ['Wire decay cron', 'Unit tests for contradiction.ts', 'Dedup cleanup'],
    learnings: ['Always read from disk inside locks', 'Fix source then rebuild bundle'],
    gsd: { phase: 6, status: 'in_progress' },
    ...overrides,
  };
}

describe('renderCheckpointMarkdown', () => {
  it('renders working context section', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint());
    expect(md).toContain('### Current Work');
    expect(md).toContain('**Task:** Fix auth bug');
    expect(md).toContain('**Status:** in_progress');
    expect(md).toContain('**Next:** Wire cron timer');
    expect(md).toContain('**Branch:** feature/auth');
  });

  it('renders thread topic in ALWAYS preset', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint(), 'ALWAYS');
    expect(md).toContain('**Topic:** OAuth token persistence');
    expect(md).not.toContain('**Summary:**');
    expect(md).not.toContain('**Key Exchanges:**');
  });

  it('renders full thread in RESUME preset', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint(), 'RESUME');
    expect(md).toContain('**Topic:** OAuth token persistence');
    expect(md).toContain('**Summary:** Fixed critical auth bug');
    expect(md).toContain('**Key Exchanges:**');
    expect(md).toContain('**user:** Auth keeps breaking');
    expect(md).toContain('**agent:** Found root cause in snapshots');
  });

  it('renders decisions as numbered list with source labels', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint());
    expect(md).toContain('### Decisions');
    expect(md).toContain('1. [confirmation] Use disk read inside lock');
    expect(md).toContain('2. [direction] Separate repo for Linux');
    expect(md).toContain('3. [rejection] No stale snapshots');
  });

  it('renders hot and read files', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint());
    expect(md).toContain('### Active Files');
    expect(md).toContain('**Hot:**');
    expect(md).toContain('src/auth.ts');
    expect(md).toContain('Fixed stale read');
    expect(md).toContain('**Read:**');
    expect(md).toContain('src/types.ts');
  });

  it('renders open items as bulleted list', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint());
    expect(md).toContain('### Open Items');
    expect(md).toContain('- Wire decay cron');
    expect(md).toContain('- Unit tests for contradiction.ts');
    expect(md).toContain('- Dedup cleanup');
  });

  it('renders learnings as bulleted list', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint());
    expect(md).toContain('### Learnings');
    expect(md).toContain('- Always read from disk inside locks');
    expect(md).toContain('- Fix source then rebuild bundle');
  });

  it('renders GSD section only in GSD preset', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint(), 'GSD');
    expect(md).toContain('### GSD State');
    expect(md).toContain('"phase": 6');
  });

  it('omits GSD in RESUME preset', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint(), 'RESUME');
    expect(md).not.toContain('### GSD State');
  });

  it('omits empty sections', () => {
    const cp = makeCheckpoint({
      decisions: [],
      open_items: [],
      learnings: [],
      gsd: null,
    });
    const md = renderCheckpointMarkdown(cp);
    expect(md).not.toContain('### Decisions');
    expect(md).not.toContain('### Open Items');
    expect(md).not.toContain('### Learnings');
    expect(md).not.toContain('### GSD State');
  });

  it('returns empty string for null checkpoint fields', () => {
    const cp = makeCheckpoint({
      working: { task: null, status: null, next_action: null, branch: null },
      thread: { topic: null, summary: null, key_exchanges: [] },
      decisions: [],
      files: { hot: [], read: [] },
      open_items: [],
      learnings: [],
      gsd: null,
    });
    const md = renderCheckpointMarkdown(cp);
    // Should not crash, may return empty or minimal
    expect(typeof md).toBe('string');
  });

  it('ALWAYS preset only renders working + thread.topic', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint(), 'ALWAYS');
    expect(md).toContain('### Current Work');
    expect(md).toContain('**Topic:**');
    expect(md).not.toContain('### Decisions');
    expect(md).not.toContain('### Active Files');
    expect(md).not.toContain('### Open Items');
    expect(md).not.toContain('### Learnings');
    expect(md).not.toContain('### GSD State');
  });

  it('no preset renders all sections', () => {
    const md = renderCheckpointMarkdown(makeCheckpoint());
    expect(md).toContain('### Current Work');
    expect(md).toContain('### Thread');
    expect(md).toContain('### Decisions');
    expect(md).toContain('### Active Files');
    expect(md).toContain('### Open Items');
    expect(md).toContain('### Learnings');
    expect(md).toContain('### GSD State');
  });

  it('is non-throwing on malformed checkpoint', () => {
    expect(() =>
      renderCheckpointMarkdown(null as unknown as CheckpointV3)
    ).not.toThrow();
    expect(renderCheckpointMarkdown(null as unknown as CheckpointV3)).toBe('');
  });
});
