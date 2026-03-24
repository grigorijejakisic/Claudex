import { EmbeddingProvider, isLocalOrPrivateUrl } from '../../embeddings/embedding-provider.js';

// Mock global fetch
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

describe('EmbeddingProvider', () => {
  describe('isAvailable', () => {
    it('returns true when Ollama has snowflake-arctic-embed2 model', async () => {
      mockFetch(async () =>
        new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }))
      );
      const provider = new EmbeddingProvider();
      expect(await provider.isAvailable()).toBe(true);
    });

    it('returns false when Ollama is not running', async () => {
      mockFetch(async () => { throw new Error('ECONNREFUSED'); });
      const provider = new EmbeddingProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it('returns false when model not found in tags', async () => {
      mockFetch(async () =>
        new Response(JSON.stringify({ models: [{ name: 'llama3:latest' }] }))
      );
      const provider = new EmbeddingProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it('returns false on non-2xx response from /api/tags', async () => {
      mockFetch(async () =>
        new Response('Internal Server Error', { status: 500 })
      );
      const provider = new EmbeddingProvider();
      expect(await provider.isAvailable()).toBe(false);
    });

    it('caches availability result (avoids re-checking)', async () => {
      let callCount = 0;
      mockFetch(async () => {
        callCount++;
        return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
      });
      const provider = new EmbeddingProvider();
      await provider.isAvailable();
      await provider.isAvailable();
      expect(callCount).toBe(1);
    });
  });

  describe('embed', () => {
    it('returns embedding vector when available', async () => {
      const fakeEmb = [0.1, 0.2, 0.3];
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response(JSON.stringify({ embeddings: [fakeEmb] }));
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embed('test text');
      expect(result).toEqual(fakeEmb);
    });

    it('returns null when provider is unavailable', async () => {
      mockFetch(async () => { throw new Error('ECONNREFUSED'); });
      const provider = new EmbeddingProvider();
      await provider.isAvailable(); // caches false
      const result = await provider.embed('test');
      expect(result).toBeNull();
    });

    it('returns null on HTTP error (thrown)', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        throw new Error('Internal Server Error');
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embed('test');
      expect(result).toBeNull();
    });

    it('returns null on non-2xx response from /api/embed', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response('Bad Request', { status: 400 });
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embed('test');
      expect(result).toBeNull();
    });

    it('returns null on malformed response', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response('not json at all');
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embed('test');
      expect(result).toBeNull();
    });

    it('calls isAvailable first if not yet checked', async () => {
      let tagsCalled = false;
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          tagsCalled = true;
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response(JSON.stringify({ embeddings: [[0.1]] }));
      });
      const provider = new EmbeddingProvider();
      await provider.embed('test');
      expect(tagsCalled).toBe(true);
    });
  });

  describe('embedBatch', () => {
    it('returns embedding vectors for multiple texts in single call', async () => {
      const fakeEmbs = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response(JSON.stringify({ embeddings: fakeEmbs }));
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embedBatch(['text1', 'text2', 'text3']);
      expect(result).toEqual(fakeEmbs);
      expect(result.length).toBe(3);
    });

    it('sends all texts as input array in single HTTP call', async () => {
      let capturedBody: string | null = null;
      mockFetch(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ embeddings: [[0.1], [0.2], [0.3]] }));
      });
      const provider = new EmbeddingProvider();
      await provider.embedBatch(['alpha', 'beta', 'gamma']);
      expect(capturedBody).not.toBeNull();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.input).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('returns empty array for empty input', async () => {
      const provider = new EmbeddingProvider();
      const result = await provider.embedBatch([]);
      expect(result).toEqual([]);
    });

    it('delegates single-item batch to embed()', async () => {
      const fakeEmb = [0.1, 0.2, 0.3];
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response(JSON.stringify({ embeddings: [fakeEmb] }));
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embedBatch(['single']);
      expect(result).toEqual([fakeEmb]);
    });

    it('returns all-null array when provider is unavailable', async () => {
      mockFetch(async () => { throw new Error('ECONNREFUSED'); });
      const provider = new EmbeddingProvider();
      await provider.isAvailable();
      const result = await provider.embedBatch(['a', 'b', 'c']);
      expect(result).toEqual([null, null, null]);
    });

    it('returns null for missing positions in partial response', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        // Return only 2 embeddings for 3 inputs
        return new Response(JSON.stringify({ embeddings: [[0.1], [0.2]] }));
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embedBatch(['a', 'b', 'c']);
      expect(result[0]).toEqual([0.1]);
      expect(result[1]).toEqual([0.2]);
      expect(result[2]).toBeNull();
    });

    it('returns all-null on HTTP error (thrown)', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        throw new Error('Internal Server Error');
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embedBatch(['a', 'b']);
      expect(result).toEqual([null, null]);
    });

    it('returns all-null on non-2xx response from /api/embed', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response('Service Unavailable', { status: 503 });
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embedBatch(['a', 'b']);
      expect(result).toEqual([null, null]);
    });

    it('is non-throwing on malformed response', async () => {
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response('not json');
      });
      const provider = new EmbeddingProvider();
      const result = await provider.embedBatch(['a', 'b']);
      expect(result).toEqual([null, null]);
    });

    it('calls isAvailable first if not yet checked', async () => {
      let tagsCalled = false;
      mockFetch(async (url: string) => {
        if (url.includes('/api/tags')) {
          tagsCalled = true;
          return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
        }
        return new Response(JSON.stringify({ embeddings: [[0.1], [0.2]] }));
      });
      const provider = new EmbeddingProvider();
      await provider.embedBatch(['a', 'b']);
      expect(tagsCalled).toBe(true);
    });
  });

  describe('resetAvailability', () => {
    it('clears cached availability for re-check', async () => {
      let callCount = 0;
      mockFetch(async () => {
        callCount++;
        return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
      });
      const provider = new EmbeddingProvider();
      await provider.isAvailable();
      expect(callCount).toBe(1);
      provider.resetAvailability();
      await provider.isAvailable();
      expect(callCount).toBe(2);
    });

    it('does NOT reset URL-blocked providers (external URL stays blocked)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }));
      });
      const provider = new EmbeddingProvider({ baseUrl: 'http://evil.example.com:11434' });
      expect(await provider.isAvailable()).toBe(false);

      // Reset should be a no-op for URL-blocked providers
      provider.resetAvailability();
      expect(await provider.isAvailable()).toBe(false);
      expect(fetchCalled).toBe(false); // No network call made
      warnSpy.mockRestore();
    });
  });

  describe('edge cases', () => {
    it('is non-throwing on all error paths', async () => {
      mockFetch(async () => { throw new Error('crash'); });
      const provider = new EmbeddingProvider();
      expect(await provider.isAvailable()).toBe(false);
      expect(await provider.embed('test')).toBeNull();
    });

    it('handles timeout gracefully (returns null)', async () => {
      mockFetch(async (_url: string, init?: RequestInit) => {
        // Listen for abort signal and reject immediately when aborted
        return new Promise<Response>((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }
        });
      });
      const provider = new EmbeddingProvider();
      // Force available to true to skip health check and go straight to embed
      (provider as any).available = true;
      const result = await provider.embed('test');
      expect(result).toBeNull();
    });
  });
});

// --- isLocalOrPrivateUrl tests ---

describe('isLocalOrPrivateUrl', () => {
  describe('accepts valid local/private URLs', () => {
    it('accepts http://localhost:11434', () => {
      expect(isLocalOrPrivateUrl('http://localhost:11434')).toBe(true);
    });

    it('accepts http://127.0.0.1:11434', () => {
      expect(isLocalOrPrivateUrl('http://127.0.0.1:11434')).toBe(true);
    });

    it('accepts http://[::1]:11434', () => {
      expect(isLocalOrPrivateUrl('http://[::1]:11434')).toBe(true);
    });

    it('accepts http://0.0.0.0:11434', () => {
      expect(isLocalOrPrivateUrl('http://0.0.0.0:11434')).toBe(true);
    });

    it('accepts http://localhost (no port)', () => {
      expect(isLocalOrPrivateUrl('http://localhost')).toBe(true);
    });

    it('rejects private 10.x.x.x range by default (loopback-only)', () => {
      expect(isLocalOrPrivateUrl('http://10.0.0.1:8080')).toBe(false);
      expect(isLocalOrPrivateUrl('http://10.255.255.255')).toBe(false);
    });

    it('rejects private 172.16-31.x.x range by default (loopback-only)', () => {
      expect(isLocalOrPrivateUrl('http://172.16.0.1:8080')).toBe(false);
      expect(isLocalOrPrivateUrl('http://172.31.255.255')).toBe(false);
    });

    it('rejects private 192.168.x.x range by default (loopback-only)', () => {
      expect(isLocalOrPrivateUrl('http://192.168.0.1:11434')).toBe(false);
      expect(isLocalOrPrivateUrl('http://192.168.1.100')).toBe(false);
    });

    it('accepts private ranges when allowPrivateLan is true', () => {
      expect(isLocalOrPrivateUrl('http://10.0.0.1:8080', { allowPrivateLan: true })).toBe(true);
      expect(isLocalOrPrivateUrl('http://172.16.0.1:8080', { allowPrivateLan: true })).toBe(true);
      expect(isLocalOrPrivateUrl('http://192.168.1.100', { allowPrivateLan: true })).toBe(true);
    });
  });

  describe('rejects external URLs', () => {
    it('rejects public IP addresses', () => {
      expect(isLocalOrPrivateUrl('http://8.8.8.8:11434')).toBe(false);
      expect(isLocalOrPrivateUrl('http://1.2.3.4')).toBe(false);
    });

    it('rejects public hostnames', () => {
      expect(isLocalOrPrivateUrl('http://evil.example.com:11434')).toBe(false);
      expect(isLocalOrPrivateUrl('https://api.openai.com')).toBe(false);
    });

    it('rejects 172.x.x.x outside private range', () => {
      expect(isLocalOrPrivateUrl('http://172.15.0.1')).toBe(false);
      expect(isLocalOrPrivateUrl('http://172.32.0.1')).toBe(false);
    });

    it('rejects invalid URLs', () => {
      expect(isLocalOrPrivateUrl('')).toBe(false);
      expect(isLocalOrPrivateUrl('not-a-url')).toBe(false);
    });
  });
});

// --- baseUrl validation integration ---

describe('EmbeddingProvider baseUrl validation', () => {
  it('rejects external baseUrl at construction (sets available=false)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new EmbeddingProvider({ baseUrl: 'http://evil.example.com:11434' });

    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.embed('test')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('not a local/private address')
    );
    warnSpy.mockRestore();
  });

  it('allows localhost baseUrl (default)', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ models: [{ name: 'snowflake-arctic-embed2:latest' }] }))
    );
    const provider = new EmbeddingProvider();
    // Default is localhost — should proceed normally
    expect(await provider.isAvailable()).toBe(true);
  });

  it('rejects private network baseUrl by default (loopback-only)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new EmbeddingProvider({ baseUrl: 'http://192.168.1.50:11434' });
    expect(await provider.isAvailable()).toBe(false);
    warnSpy.mockRestore();
  });
});
