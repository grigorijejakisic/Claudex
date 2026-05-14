import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeCrossFamily, CrossFamilyResultSchema } from '../../../skills/auto/cross-family-wrapper.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(childProcess.execSync);

function validGeminiResponse(): string {
  return JSON.stringify({
    family: 'gemini',
    verdict: 'SIGNOFF',
    severity: 'none',
    findings: [],
    recommendation: 'No issues found.',
  });
}

function validCodexResponse(): string {
  return JSON.stringify({
    family: 'codex',
    verdict: 'FLAG',
    severity: 'minor',
    findings: [{ category: 'style', summary: 'Minor style issue.', evidence: 'line 42' }],
    recommendation: 'Consider renaming.',
  });
}

describe('invokeCrossFamily — schema validation', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('parses a valid Gemini SIGNOFF', async () => {
    mockExecSync.mockReturnValue(validGeminiResponse());
    const results = await invokeCrossFamily('test prompt', { family: 'gemini' });
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('SIGNOFF');
    expect(results[0].family).toBe('gemini');
    expect(results[0].degraded).toBeUndefined();
    expect(CrossFamilyResultSchema.safeParse(results[0]).success).toBe(true);
  });

  it('parses a valid Codex FLAG', async () => {
    mockExecSync.mockReturnValue(validCodexResponse());
    const results = await invokeCrossFamily('test prompt', { family: 'codex' });
    expect(results[0].verdict).toBe('FLAG');
    expect(results[0].findings).toHaveLength(1);
    expect(results[0].findings[0].category).toBe('style');
  });

  it('invokes both families when no family specified', async () => {
    mockExecSync
      .mockReturnValueOnce(validGeminiResponse())
      .mockReturnValueOnce(validCodexResponse());
    const results = await invokeCrossFamily('test prompt');
    expect(results).toHaveLength(2);
    const families = results.map((r) => r.family).sort();
    expect(families).toEqual(['codex', 'gemini']);
  });
});

describe('invokeCrossFamily — parse-failure retry + degraded mode', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('retries once on malformed JSON and succeeds', async () => {
    mockExecSync
      .mockReturnValueOnce('not valid json {{')
      .mockReturnValueOnce(validGeminiResponse());
    const results = await invokeCrossFamily('test', { family: 'gemini' });
    expect(results[0].verdict).toBe('SIGNOFF');
    expect(results[0].degraded).toBeUndefined();
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('returns degraded result after two consecutive malformed responses', async () => {
    mockExecSync.mockReturnValue('still not json');
    const results = await invokeCrossFamily('test', { family: 'gemini' });
    expect(results[0].degraded).toBe(true);
    expect(results[0].verdict).toBeNull();
    expect(results[0].reason).toBe('malformed');
    expect(results[0].raw_output).toBeDefined();
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('returns degraded result with reason=unreachable when execSync throws', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found: gemini');
    });
    const results = await invokeCrossFamily('test', { family: 'gemini' });
    expect(results[0].degraded).toBe(true);
    expect(results[0].reason).toBe('unreachable');
  });
});

describe('invokeCrossFamily — prompt budget', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue(validGeminiResponse());
  });

  it('sets truncated=true when prompt exceeds budget', async () => {
    const longPrompt = 'x'.repeat(200_000); // >> 32K chars
    const results = await invokeCrossFamily(longPrompt, { family: 'gemini' });
    expect(results[0].truncated).toBe(true);
  });

  it('does NOT set truncated when prompt fits within budget', async () => {
    const shortPrompt = 'short prompt';
    const results = await invokeCrossFamily(shortPrompt, { family: 'gemini' });
    expect(results[0].truncated).toBeUndefined();
  });
});

describe('invokeCrossFamily — Claude exclusion', () => {
  it('throws when claude is requested as a family', async () => {
    await expect(
      invokeCrossFamily('test', { family: 'claude' as 'gemini' }),
    ).rejects.toThrow(/excluded by design|unknown family/i);
  });
});

describe('invokeCrossFamily — authorship mode', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns findings[].evidence containing vitest body in authorship mode', async () => {
    const authorshipResponse = JSON.stringify({
      family: 'gemini',
      verdict: 'SIGNOFF',
      severity: 'none',
      findings: [
        {
          category: 'adversarial-probe',
          summary: 'Probe for NULL body path',
          evidence: "it('handles null body', () => { expect(fn(null)).not.toThrow(); });",
        },
      ],
      recommendation: 'Probes produced cleanly.',
    });
    mockExecSync.mockReturnValue(authorshipResponse);

    const results = await invokeCrossFamily('generate adversarial probes', {
      family: 'gemini',
      mode: 'authorship',
    });
    expect(results[0].verdict).toBe('SIGNOFF');
    expect(results[0].findings[0].category).toBe('adversarial-probe');
    expect(results[0].findings[0].evidence).toContain('expect');
  });
});
