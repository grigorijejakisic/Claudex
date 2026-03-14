import { fetchJsonWithTimeout } from './fetch-utils.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

describe('fetchJsonWithTimeout', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch(async () => new Response(JSON.stringify({ ok: true })));
    const result = await fetchJsonWithTimeout('http://localhost:1234/test');
    expect(result).toEqual({ ok: true });
  });

  it('returns null on non-2xx response', async () => {
    mockFetch(async () => new Response('Not Found', { status: 404 }));
    const result = await fetchJsonWithTimeout('http://localhost:1234/test');
    expect(result).toBeNull();
  });

  it('returns null on 500 response', async () => {
    mockFetch(async () => new Response('Internal Server Error', { status: 500 }));
    const result = await fetchJsonWithTimeout('http://localhost:1234/test');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    const result = await fetchJsonWithTimeout('http://localhost:1234/test');
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    mockFetch(async () => new Response('not json'));
    const result = await fetchJsonWithTimeout('http://localhost:1234/test');
    expect(result).toBeNull();
  });

  it('passes custom fetch options through', async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }));
    });
    await fetchJsonWithTimeout('http://localhost:1234/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.body).toBe('{}');
  });

  it('aborts on timeout', async () => {
    mockFetch(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    });
    const result = await fetchJsonWithTimeout('http://localhost:1234/test', { timeoutMs: 50 });
    expect(result).toBeNull();
  });

  it('is non-throwing on all error paths', async () => {
    mockFetch(async () => { throw new Error('crash'); });
    const result = await fetchJsonWithTimeout('http://localhost:1234/test');
    expect(result).toBeNull();
  });

  it('rejects responses exceeding maxResponseBytes even without content-length header', async () => {
    const largePayload = JSON.stringify({ data: 'x'.repeat(10000) });
    // Response without content-length header (chunked transfer simulation)
    mockFetch(async () => new Response(largePayload));
    const result = await fetchJsonWithTimeout('http://localhost:1234/test', {
      maxResponseBytes: 100,
    });
    expect(result).toBeNull();
  });

  it('allows responses within maxResponseBytes limit', async () => {
    const smallPayload = JSON.stringify({ ok: true });
    mockFetch(async () => new Response(smallPayload));
    const result = await fetchJsonWithTimeout('http://localhost:1234/test', {
      maxResponseBytes: 10000,
    });
    expect(result).toEqual({ ok: true });
  });

  it('does not enforce size limit when maxResponseBytes is not set', async () => {
    const largePayload = JSON.stringify({ data: 'x'.repeat(10000) });
    mockFetch(async () => new Response(largePayload));
    const result = await fetchJsonWithTimeout('http://localhost:1234/test');
    expect(result).toEqual({ data: 'x'.repeat(10000) });
  });
});
