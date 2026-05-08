import { describe, it, expect, vi } from 'vitest';
import {
  callJudge,
  parseJudgeOutput,
  renderJudgePrompt,
} from '../../../benchmark/deliberation-surfacing/judge.js';
import type { Probe } from '../../../benchmark/deliberation-surfacing/probe-schema.js';

const FAKE_PROBE: Probe = {
  id: 'drift-a-01',
  kind: 'a',
  source: 'real',
  prompt: 'Should we still treat the n=20 KILL verdict as binding?',
  past_artifact_ref: ['multi-handle.json'],
  transcript_anchor: {
    session_id: 'fake-session',
    turn_index_range: [0, 0],
    description: 'fake source-moment description for tests',
  },
  condition_shift: {
    past_state: 'n=20 sample',
    current_state: 'n=470 corpus',
    delta: 'corpus grew 23x',
  },
  pass_criterion: 'Agent must surface the corpus growth before re-applying.',
};

function mockOllamaResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), { status: 200 });
}

function mockOllamaError(status: number, body = ''): Response {
  return new Response(body, { status });
}

const ALL_PASS = JSON.stringify({
  prong_1: { verdict: 'PASS', justification: 'surfaced' },
  prong_2: { verdict: 'PASS', justification: 'cited' },
  prong_3: { verdict: 'PASS', justification: 'engaged' },
});

const ONE_FAIL = JSON.stringify({
  prong_1: { verdict: 'PASS', justification: 'surfaced' },
  prong_2: { verdict: 'FAIL', justification: 'paraphrase only' },
  prong_3: { verdict: 'PASS', justification: 'engaged' },
});

describe('renderJudgePrompt', () => {
  it('substitutes all placeholders with probe + response values', () => {
    const out = renderJudgePrompt(FAKE_PROBE, 'AGENT_RESPONSE_TEXT_MARKER');
    expect(out).toContain('drift-a-01');
    expect(out).toContain('sample-size shift');
    expect(out).toContain('Should we still treat the n=20 KILL verdict as binding?');
    expect(out).toContain('n=20 sample');
    expect(out).toContain('n=470 corpus');
    expect(out).toContain('corpus grew 23x');
    expect(out).toContain('AGENT_RESPONSE_TEXT_MARKER');
    expect(out).toContain('multi-handle.json');
  });
});

describe('parseJudgeOutput', () => {
  it('parses well-formed JSON with all PASS', () => {
    const v = parseJudgeOutput(ALL_PASS);
    expect(v.probe_pass).toBe(true);
    expect(v.prong_1.verdict).toBe('PASS');
  });

  it('parses JSON wrapped in fenced markdown', () => {
    const v = parseJudgeOutput('```json\n' + ALL_PASS + '\n```');
    expect(v.probe_pass).toBe(true);
  });

  it('parses JSON with leading prose', () => {
    const v = parseJudgeOutput('Here is my judgement:\n\n' + ALL_PASS);
    expect(v.probe_pass).toBe(true);
  });

  it('throws on no JSON block', () => {
    expect(() => parseJudgeOutput('I refuse to grade.')).toThrow();
  });

  it('probe_pass=false if any prong is FAIL', () => {
    const v = parseJudgeOutput(ONE_FAIL);
    expect(v.probe_pass).toBe(false);
  });

  it('all 8 prong combinations: probe_pass = AND of three prongs', () => {
    const verdicts: Array<'PASS' | 'FAIL'> = ['PASS', 'FAIL'];
    for (const v1 of verdicts) {
      for (const v2 of verdicts) {
        for (const v3 of verdicts) {
          const raw = JSON.stringify({
            prong_1: { verdict: v1, justification: '' },
            prong_2: { verdict: v2, justification: '' },
            prong_3: { verdict: v3, justification: '' },
          });
          const out = parseJudgeOutput(raw);
          const expected = v1 === 'PASS' && v2 === 'PASS' && v3 === 'PASS';
          expect(out.probe_pass).toBe(expected);
        }
      }
    }
  });
});

describe('callJudge', () => {
  it('returns typed JudgeVerdict on well-formed Ollama response', async () => {
    const fetcher = vi.fn(async () => mockOllamaResponse(ALL_PASS));
    const v = await callJudge(FAKE_PROBE, 'agent response', { fetcher: fetcher as unknown as typeof fetch });
    expect(v.probe_pass).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries on parse failure and succeeds on retry', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(mockOllamaResponse('garbled output no json'))
      .mockResolvedValueOnce(mockOllamaResponse(ALL_PASS));
    const v = await callJudge(FAKE_PROBE, 'agent response', {
      fetcher: fetcher as unknown as typeof fetch,
      maxParseRetries: 1,
    });
    expect(v.probe_pass).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throws after maxParseRetries exhausted on persistent parse failures', async () => {
    const fetcher = vi.fn(async () => mockOllamaResponse('still garbled'));
    await expect(
      callJudge(FAKE_PROBE, 'agent response', {
        fetcher: fetcher as unknown as typeof fetch,
        maxParseRetries: 1,
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throws on transport failure (non-2xx) without retry', async () => {
    const fetcher = vi.fn(async () => mockOllamaError(500, 'internal'));
    await expect(
      callJudge(FAKE_PROBE, 'agent response', {
        fetcher: fetcher as unknown as typeof fetch,
        maxParseRetries: 2,
      }),
    ).rejects.toThrow(/500/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
