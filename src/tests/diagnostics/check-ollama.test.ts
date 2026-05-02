import { describe, it, expect, vi } from 'vitest';
import { makeCheckOllama } from '../../diagnostics/check-ollama.js';

function mockExecOk() {
  return vi.fn(() => 'ollama version 0.5.0');
}

function mockExecMissing() {
  return vi.fn(() => {
    throw new Error('command not found: ollama');
  });
}

function mockFetchTags(models: Array<{ name: string }>): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('checkOllama', () => {
  it('passes when binary + daemon + model are all present', async () => {
    const check = makeCheckOllama({
      execFn: mockExecOk() as unknown as typeof import('child_process').execFileSync,
      fetchFn: mockFetchTags([{ name: 'snowflake-arctic-embed2:latest' }, { name: 'llama3:8b' }]),
      platform: 'linux',
    });
    const result = await check();
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('daemon up');
    expect(result.detail).toContain('snowflake-arctic-embed2');
  });

  it('fails when binary is missing (with platform-aware install link)', async () => {
    const check = makeCheckOllama({
      execFn: mockExecMissing() as unknown as typeof import('child_process').execFileSync,
      fetchFn: vi.fn() as unknown as typeof fetch,
      platform: 'linux',
    });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('Ollama not found in PATH');
    expect(result.remediation).toContain('ollama.com/install.sh');
  });

  it('fails when daemon is unreachable', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const check = makeCheckOllama({
      execFn: mockExecOk() as unknown as typeof import('child_process').execFileSync,
      fetchFn: failingFetch,
      platform: 'darwin',
    });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not running on :11434');
    expect(result.remediation).toContain('ollama serve');
  });

  it('fails when daemon up but snowflake-arctic-embed2 is not pulled', async () => {
    const check = makeCheckOllama({
      execFn: mockExecOk() as unknown as typeof import('child_process').execFileSync,
      fetchFn: mockFetchTags([{ name: 'llama3:8b' }]),
      platform: 'linux',
    });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not pulled');
    expect(result.remediation).toContain('ollama pull snowflake-arctic-embed2');
  });

  it('fails when /api/tags returns non-200', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const check = makeCheckOllama({
      execFn: mockExecOk() as unknown as typeof import('child_process').execFileSync,
      fetchFn: failing,
      platform: 'linux',
    });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('HTTP 503');
  });
});
