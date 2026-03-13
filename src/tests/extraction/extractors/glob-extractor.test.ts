import { extractGlob } from '../../../extraction/extractors/glob.js';

describe('extractGlob', () => {
  it('title includes pattern and file count', () => {
    const result = extractGlob(
      { pattern: '**/*.ts' },
      { files: ['a.ts', 'b.ts', 'c.ts'] }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Glob: **/*.ts');
    expect(result!.title).toContain('3 files');
  });

  it('content lists matched files', () => {
    const result = extractGlob(
      { pattern: '*.js' },
      { files: ['index.js', 'app.js'] }
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('index.js');
  });

  it('files_modified is empty for glob', () => {
    const result = extractGlob(
      { pattern: '*.ts' },
      { files: ['a.ts'] }
    );
    expect(result).not.toBeNull();
    expect(result!.files_modified).toEqual([]);
  });

  it('returns null when no pattern', () => {
    expect(extractGlob({}, { files: [] })).toBeNull();
  });
});
