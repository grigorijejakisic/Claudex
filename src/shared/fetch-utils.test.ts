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
});
