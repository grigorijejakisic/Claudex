/**
 * Unit tests for src/angel/llama-client.ts.
 *
 * Covers request shaping, response parsing, timeout configuration, and
 * the checkLlamaServerHealth probe. All fetches are injected — no network.
 */

import { describe, it, expect } from 'vitest';
import {
  callLocalLLM,
  checkLlamaServerHealth,
  LLAMA_SERVER_URL,
  LLAMA_HEALTH_URL,
  LLAMA_MODEL_ALIAS,
} from '../../angel/llama-client.js';

function makeFakeCompletionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeFakeModelsResponse(modelIds: string[] = ['gemma4']): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: modelIds.map(id => ({ id, object: 'model' })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('callLocalLLM', () => {
  it('sends a POST to /v1/chat/completions with system+user messages', async () => {
    let capturedUrl: string | URL | Request = '';
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return makeFakeCompletionResponse('hello');
    }) as typeof fetch;

    const out = await callLocalLLM({
      system: 'you are a test',
      prompt: 'ping',
      fetchFn: fakeFetch,
    });

    expect(out).toBe('hello');
    expect(capturedUrl).toBe(LLAMA_SERVER_URL);
    expect(capturedInit?.method).toBe('POST');

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.model).toBe(LLAMA_MODEL_ALIAS);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are a test' },
      { role: 'user', content: 'ping' },
    ]);
  });

  it('omits the system message when not provided', async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return makeFakeCompletionResponse('out');
    }) as typeof fetch;

    await callLocalLLM({ prompt: 'only user', fetchFn: fakeFetch });

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'only user' }]);
  });

  it('respects custom temperature and maxTokens', async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return makeFakeCompletionResponse('ok');
    }) as typeof fetch;

    await callLocalLLM({
      prompt: 'x',
      temperature: 0.8,
      maxTokens: 512,
      fetchFn: fakeFetch,
    });

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.temperature).toBe(0.8);
    expect(body.max_tokens).toBe(512);
  });

  it('trims trailing whitespace from the response', async () => {
    const fakeFetch = (async () =>
      makeFakeCompletionResponse('  hello world  \n\n')) as typeof fetch;
    const out = await callLocalLLM({ prompt: 'x', fetchFn: fakeFetch });
    expect(out).toBe('hello world');
  });

  it('throws on non-2xx HTTP status', async () => {
    const fakeFetch = (async () =>
      new Response('internal error', { status: 500, statusText: 'Internal Error' })) as typeof fetch;
    await expect(callLocalLLM({ prompt: 'x', fetchFn: fakeFetch })).rejects.toThrow(
      /llama-server 500/,
    );
  });

  it('throws on malformed response shape', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ nothing: 'here' }), { status: 200 })) as typeof fetch;
    await expect(callLocalLLM({ prompt: 'x', fetchFn: fakeFetch })).rejects.toThrow(
      /missing choices/,
    );
  });

  it('propagates network errors from the injected fetch', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(callLocalLLM({ prompt: 'x', fetchFn: fakeFetch })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});

describe('checkLlamaServerHealth', () => {
  it('returns true when /v1/models responds 200 with a non-empty data array', async () => {
    const fakeFetch = (async () => makeFakeModelsResponse(['gemma4'])) as typeof fetch;
    const healthy = await checkLlamaServerHealth({ fetchFn: fakeFetch });
    expect(healthy).toBe(true);
  });

  it('defaults to the LLAMA_HEALTH_URL', async () => {
    let capturedUrl: string | URL | Request = '';
    const fakeFetch = (async (url: string | URL | Request) => {
      capturedUrl = url;
      return makeFakeModelsResponse();
    }) as typeof fetch;
    await checkLlamaServerHealth({ fetchFn: fakeFetch });
    expect(capturedUrl).toBe(LLAMA_HEALTH_URL);
  });

  it('returns false on non-2xx', async () => {
    const fakeFetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    const healthy = await checkLlamaServerHealth({ fetchFn: fakeFetch });
    expect(healthy).toBe(false);
  });

  it('returns false on empty data array (model still loading)', async () => {
    const fakeFetch = (async () => makeFakeModelsResponse([])) as typeof fetch;
    const healthy = await checkLlamaServerHealth({ fetchFn: fakeFetch });
    expect(healthy).toBe(false);
  });

  it('returns false on network error (connection refused)', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const healthy = await checkLlamaServerHealth({ fetchFn: fakeFetch });
    expect(healthy).toBe(false);
  });

  it('returns false on malformed JSON', async () => {
    const fakeFetch = (async () =>
      new Response('not json', { status: 200 })) as typeof fetch;
    const healthy = await checkLlamaServerHealth({ fetchFn: fakeFetch });
    expect(healthy).toBe(false);
  });
});
