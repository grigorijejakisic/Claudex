import { extractWebFetch } from '../../../extraction/extractors/web-fetch.js';

describe('extractWebFetch', () => {
  it('title includes URL', () => {
    const result = extractWebFetch(
      { url: 'https://example.com/api' },
      { status: 200, content: 'OK' }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('WebFetch: https://example.com/api');
  });

  it('content includes status and body', () => {
    const result = extractWebFetch(
      { url: 'https://example.com' },
      { status: 200, content: 'Hello World' }
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('200');
    expect(result!.content).toContain('Hello World');
  });

  it('returns null when no url', () => {
    expect(extractWebFetch({}, { content: 'data' })).toBeNull();
  });
});
