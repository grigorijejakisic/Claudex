import { extractWrite } from '../../../extraction/extractors/write.js';

describe('extractWrite', () => {
  it('produces title with file basename', () => {
    const result = extractWrite(
      { file_path: '/src/new-file.ts', content: 'hello world' },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Write: new-file.ts');
  });

  it('extracts written content', () => {
    const result = extractWrite(
      { file_path: '/src/file.ts', content: 'export const x = 42;' },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.content).toBe('export const x = 42;');
  });

  it('returns null when no file_path', () => {
    expect(extractWrite({ content: 'hello' }, undefined)).toBeNull();
  });
});
