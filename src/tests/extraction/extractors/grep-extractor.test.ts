import { extractGrep } from '../../../extraction/extractors/grep.js';

describe('extractGrep', () => {
  it('title includes pattern and match count', () => {
    const result = extractGrep(
      { pattern: 'TODO' },
      { matchCount: 5, files: ['a.ts', 'b.ts'] }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Grep: TODO');
    expect(result!.title).toContain('5 matches');
  });

  it('content lists matched files', () => {
    const result = extractGrep(
      { pattern: 'import' },
      { matchCount: 3, files: ['src/a.ts', 'src/b.ts'] }
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('src/a.ts');
    expect(result!.content).toContain('src/b.ts');
  });

  it('files_modified contains matched file paths', () => {
    const result = extractGrep(
      { pattern: 'foo' },
      { matchCount: 2, files: ['x.ts', 'y.ts'] }
    );
    expect(result).not.toBeNull();
    expect(result!.files_modified).toEqual(['x.ts', 'y.ts']);
  });

  it('returns null when no pattern', () => {
    expect(extractGrep({}, { matchCount: 0 })).toBeNull();
  });
});
