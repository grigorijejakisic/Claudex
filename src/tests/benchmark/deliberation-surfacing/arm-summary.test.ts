import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSummaryArm } from '../../../benchmark/deliberation-surfacing/arm-summary.js';
import * as hybridRetrieval from '../../../core/hybrid-retrieval.js';
import type { Probe } from '../../../benchmark/deliberation-surfacing/probe-schema.js';

const FAKE_PROBE: Probe = {
  id: 'drift-a-01',
  kind: 'a',
  source: 'real',
  prompt: 'Should we still treat the n=20 KILL verdict as binding?',
  past_artifact_ref: ['multi-handle.json'],
  transcript_anchor: { session_id: 'fake', turn_index_range: [0, 0], description: 'fake source' },
  condition_shift: { past_state: 'past', current_state: 'now', delta: 'changed' },
  pass_criterion: 'Agent must surface the corpus growth before re-applying.',
};

const fakeDb = {} as unknown as import('better-sqlite3').Database;

describe('runSummaryArm', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(hybridRetrieval, 'hybridSearchAsync');
  });

  it('returns summary arm result with mocked hybrid retrieval + agent', async () => {
    spy.mockResolvedValueOnce([
      { id: 'a1', summary: 'past KILL verdict at n=20', content: '', kind: 'decision' } as never,
      { id: 'a2', summary: 'multi-handle aggregator entry', content: '', kind: 'aggregator' } as never,
    ]);
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: { content: 'AGENT_RESPONSE' } }), { status: 200 }),
    );
    const out = await runSummaryArm(fakeDb, FAKE_PROBE, { fetcher: fetcher as unknown as typeof fetch });
    expect(out.arm).toBe('summary');
    expect(out.injected_context_summary.artifact_count).toBe(2);
    expect(out.injected_context_summary.transcript_span_count).toBe(0);
    expect(out.injected_context_summary.retrieval_path).toBe('none');
    expect(out.agent_response).toBe('AGENT_RESPONSE');
    expect(out.error).toBeUndefined();
  });

  it('records error when hybridSearchAsync throws', async () => {
    spy.mockRejectedValueOnce(new Error('db boom'));
    const fetcher = vi.fn();
    const out = await runSummaryArm(fakeDb, FAKE_PROBE, { fetcher: fetcher as unknown as typeof fetch });
    expect(out.error).toMatch(/hybridSearchAsync failed/);
    expect(out.agent_response).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('records error when agent fetcher throws', async () => {
    spy.mockResolvedValueOnce([]);
    const fetcher = vi.fn(async () => {
      throw new Error('network down');
    });
    const out = await runSummaryArm(fakeDb, FAKE_PROBE, { fetcher: fetcher as unknown as typeof fetch });
    expect(out.error).toMatch(/agent invocation failed/);
    expect(out.agent_response).toBe('');
  });
});
