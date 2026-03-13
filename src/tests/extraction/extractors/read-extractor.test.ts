import { extractRead } from '../../../extraction/extractors/read.js';

describe('extractRead', () => {
  it('produces title with file basename', () => {
    const result = extractRead(
      { file_path: '/home/user/project/src/main.ts' },
      { content: 'export function main() {}' }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Read: main.ts');
  });

  it('extracts file content up to 2000 chars', () => {
    const longContent = 'x'.repeat(3000);
    const result = extractRead(
      { file_path: '/src/file.ts' },
      { content: longContent }
    );
    expect(result).not.toBeNull();
    // truncateText appends "..." so max is 2000 + 3
    expect(result!.content.length).toBeLessThanOrEqual(2003);
  });

  it('returns null when no file_path', () => {
    expect(extractRead({}, { content: 'hello' })).toBeNull();
  });

  it('handles filePath (camelCase variant)', () => {
    const result = extractRead(
      { filePath: '/src/utils.ts' },
      { content: 'export const x = 1;' }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Read: utils.ts');
  });
});
