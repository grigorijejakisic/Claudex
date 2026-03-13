import { extractWebSearch } from '../../../extraction/extractors/web-search.js';

describe('extractWebSearch', () => {
  it('title includes query', () => {
    const result = extractWebSearch(
      { query: 'bun test runner' },
      { results: [{ title: 'Bun docs', url: 'https://bun.sh' }] }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('WebSearch: bun test runner');
  });

  it('content lists results', () => {
    const result = extractWebSearch(
      { query: 'typescript' },
      { results: [{ title: 'TS Handbook' }, { title: 'TS Playground' }] }
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('2 results');
    expect(result!.content).toContain('TS Handbook');
  });

  it('returns null when no query', () => {
    expect(extractWebSearch({}, { results: [] })).toBeNull();
  });
});
