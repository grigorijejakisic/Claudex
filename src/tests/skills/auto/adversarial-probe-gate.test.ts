import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { requestAdversarialProbes } from '../../../skills/auto/adversarial-probe-gate.js';
import * as wrapper from '../../../skills/auto/cross-family-wrapper.js';

vi.mock('../../../skills/auto/cross-family-wrapper.js', () => ({
  invokeCrossFamily: vi.fn(),
}));

const mockInvoke = vi.mocked(wrapper.invokeCrossFamily);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-gate-test-'));
  mockInvoke.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function testFilePath(name = 'my-module.test.ts'): string {
  return path.join(tmpDir, name);
}

describe('requestAdversarialProbes — authorship mode invocation', () => {
  it('calls invokeCrossFamily with mode=authorship', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: 'SIGNOFF',
        severity: 'none',
        findings: [
          {
            category: 'adversarial-probe',
            summary: 'NULL body path',
            evidence: "describe('null body', () => { it('does not throw', () => { expect(() => fn(null)).not.toThrow(); }); });",
          },
        ],
        recommendation: 'Probes ready.',
      },
    ]);

    await requestAdversarialProbes('plan content', 'task description', {
      testFilePath: testFilePath(),
      families: ['gemini'],
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: 'authorship' }),
    );
  });
});

describe('requestAdversarialProbes — file writing', () => {
  it('writes .gemini-adversarial.test.ts next to the test file', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: 'SIGNOFF',
        severity: 'none',
        findings: [
          {
            category: 'adversarial-probe',
            summary: 'Boundary check',
            evidence: "it('handles empty', () => { expect(fn('')).toBe(null); });",
          },
        ],
        recommendation: 'Done.',
      },
    ]);

    const fp = testFilePath('routing.test.ts');
    const result = await requestAdversarialProbes('plan', 'task', {
      testFilePath: fp,
      families: ['gemini'],
    });

    expect(result.verdict).toBe('PRODUCED');
    expect(result.output_files).toHaveLength(1);
    expect(result.output_files[0]).toMatch(/routing\.gemini-adversarial\.test\.ts$/);
    expect(fs.existsSync(result.output_files[0])).toBe(true);

    const content = fs.readFileSync(result.output_files[0], 'utf8');
    expect(content).toContain('Adversarial probes authored by gemini');
    expect(content).toContain('handles empty');
  });

  it('writes separate files per family when both families produce', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: 'SIGNOFF',
        severity: 'none',
        findings: [{ category: 'adversarial-probe', summary: 'Probe A', evidence: "it('a', () => {});" }],
        recommendation: 'Done.',
      },
      {
        family: 'codex',
        verdict: 'SIGNOFF',
        severity: 'none',
        findings: [{ category: 'adversarial-probe', summary: 'Probe B', evidence: "it('b', () => {});" }],
        recommendation: 'Done.',
      },
    ]);

    const fp = testFilePath('ingestion.test.ts');
    const result = await requestAdversarialProbes('plan', 'task', { testFilePath: fp });

    expect(result.verdict).toBe('PRODUCED');
    expect(result.families_produced).toHaveLength(2);
    expect(result.output_files).toHaveLength(2);
    const names = result.output_files.map((f) => path.basename(f)).sort();
    expect(names).toContain('ingestion.codex-adversarial.test.ts');
    expect(names).toContain('ingestion.gemini-adversarial.test.ts');
  });
});

describe('requestAdversarialProbes — degraded and blocked families', () => {
  it('returns PARTIAL when one family is degraded', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: null,
        severity: null,
        findings: [],
        recommendation: '',
        degraded: true,
        reason: 'malformed',
        raw_output: 'bad',
      },
      {
        family: 'codex',
        verdict: 'SIGNOFF',
        severity: 'none',
        findings: [{ category: 'adversarial-probe', summary: 'Probe', evidence: "it('p', () => {});" }],
        recommendation: 'Done.',
      },
    ]);

    const result = await requestAdversarialProbes('plan', 'task', { testFilePath: testFilePath() });
    expect(result.verdict).toBe('PARTIAL');
    expect(result.families_degraded).toContain('gemini');
    expect(result.families_produced).toContain('codex');
  });

  it('returns BLOCKED when all families refuse', async () => {
    mockInvoke.mockResolvedValue([
      {
        family: 'gemini',
        verdict: 'BLOCK',
        severity: 'critical',
        findings: [],
        recommendation: 'Cannot author.',
      },
      {
        family: 'codex',
        verdict: 'BLOCK',
        severity: 'critical',
        findings: [],
        recommendation: 'Cannot author.',
      },
    ]);

    const result = await requestAdversarialProbes('plan', 'task', { testFilePath: testFilePath() });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.message).toMatch(/absent/i);
    expect(result.output_files).toHaveLength(0);
  });
});
