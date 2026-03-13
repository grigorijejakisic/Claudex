import { extractEdit } from '../../../extraction/extractors/edit.js';

describe('extractEdit', () => {
  it('produces title with file basename', () => {
    const result = extractEdit(
      { file_path: '/src/auth.ts', old_string: 'foo', new_string: 'bar' },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Edit: auth.ts');
  });

  it('captures old/new diff in content', () => {
    const result = extractEdit(
      { file_path: '/src/auth.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('const a = 1;');
    expect(result!.content).toContain('const a = 2;');
  });

  it('sets files_modified', () => {
    const result = extractEdit(
      { file_path: '/src/auth.ts', old_string: 'a', new_string: 'b' },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.files_modified).toEqual(['/src/auth.ts']);
  });

  it('returns null when no file_path', () => {
    expect(extractEdit({ old_string: 'a', new_string: 'b' }, undefined)).toBeNull();
  });
});
