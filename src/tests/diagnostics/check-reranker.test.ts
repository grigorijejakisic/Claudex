import { describe, it, expect, vi } from 'vitest';
import { makeCheckReranker } from '../../diagnostics/check-reranker.js';

describe('checkReranker', () => {
  it('passes when /health returns 2xx', async () => {
    const f = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const check = makeCheckReranker({ fetchFn: f });
    const result = await check();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('port 7439 healthy');
    expect(result.remediation).toBeUndefined();
  });

  it('warns (not fails) when port unreachable', async () => {
    const f = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const check = makeCheckReranker({ fetchFn: f });
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('unreachable');
    expect(result.remediation).toContain('bi-encoder fallback');
  });

  it('warns on AbortError (timeout)', async () => {
    const f = vi.fn(async () => {
      const e = new Error('aborted');
      (e as Error & { name: string }).name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    const check = makeCheckReranker({ fetchFn: f });
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('timeout');
  });

  it('warns on non-2xx HTTP response', async () => {
    const f = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const check = makeCheckReranker({ fetchFn: f });
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('503');
    expect(result.remediation).toContain('Restart Angel');
  });
});
