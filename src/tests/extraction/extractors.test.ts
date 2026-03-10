/**
 * Tests for all 10 per-tool extractors.
 * Each extractor produces ExtractionResult { title, content, files_modified } or null.
 */

import { extractRead } from '../../extraction/extractors/read.js';
import { extractEdit } from '../../extraction/extractors/edit.js';
import { extractWrite } from '../../extraction/extractors/write.js';
import { extractBash } from '../../extraction/extractors/bash.js';
import { extractGrep } from '../../extraction/extractors/grep.js';
import { extractGlob } from '../../extraction/extractors/glob.js';
import { extractWebFetch } from '../../extraction/extractors/web-fetch.js';
import { extractWebSearch } from '../../extraction/extractors/web-search.js';
import { extractTask } from '../../extraction/extractors/task.js';
import { extractNotebookEdit } from '../../extraction/extractors/notebook-edit.js';

// --- extractRead ---

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

// --- extractEdit ---

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

// --- extractWrite ---

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

// --- extractBash ---

describe('extractBash', () => {
  it('title has first 80 chars of command (within 120 char total)', () => {
    const result = extractBash(
      { command: 'npm run build --production --verbose' },
      { output: 'Build succeeded', exitCode: 0 }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Bash: npm run build');
  });

  it('includes exit code when non-zero', () => {
    const result = extractBash(
      { command: 'npm test' },
      { output: 'FAIL', exitCode: 1 }
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Exit code: 1');
  });

  it('content from stdout', () => {
    const result = extractBash(
      { command: 'git status' },
      { output: 'On branch main\nnothing to commit' }
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('On branch main');
  });

  it('files_modified is empty for bash', () => {
    const result = extractBash(
      { command: 'npm test' },
      { output: 'passed' }
    );
    expect(result).not.toBeNull();
    expect(result!.files_modified).toEqual([]);
  });

  it('returns null when no command', () => {
    expect(extractBash({}, { output: 'hello' })).toBeNull();
  });
});

// --- extractGrep ---

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

// --- extractGlob ---

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

// --- extractWebFetch ---

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

// --- extractWebSearch ---

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

// --- extractTask ---

describe('extractTask', () => {
  it('title includes agent description', () => {
    const result = extractTask(
      { description: 'Analyze code quality' },
      { result: 'All checks passed' }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('Task: Analyze code quality');
  });

  it('content includes task result', () => {
    const result = extractTask(
      { description: 'Run linter' },
      { result: 'No warnings found' }
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('No warnings found');
  });

  it('returns null when no description/name', () => {
    expect(extractTask({}, { result: 'done' })).toBeNull();
  });
});

// --- extractNotebookEdit ---

describe('extractNotebookEdit', () => {
  it('title includes cell/change info', () => {
    const result = extractNotebookEdit(
      { cell_id: 'cell-3', type: 'modify', notebook: '/nb.ipynb' },
      { content: 'print("hello")' }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('NotebookEdit: cell-3');
  });

  it('files_modified includes notebook path', () => {
    const result = extractNotebookEdit(
      { cell_id: 'cell-1', notebook: '/data/analysis.ipynb' },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.files_modified).toEqual(['/data/analysis.ipynb']);
  });

  it('returns null when no cell/change identifier', () => {
    expect(extractNotebookEdit({}, undefined)).toBeNull();
  });
});

// --- Cross-cutting tests ---

describe('all extractors', () => {
  const extractors = [
    { name: 'extractRead', fn: extractRead },
    { name: 'extractEdit', fn: extractEdit },
    { name: 'extractWrite', fn: extractWrite },
    { name: 'extractBash', fn: extractBash },
    { name: 'extractGrep', fn: extractGrep },
    { name: 'extractGlob', fn: extractGlob },
    { name: 'extractWebFetch', fn: extractWebFetch },
    { name: 'extractWebSearch', fn: extractWebSearch },
    { name: 'extractTask', fn: extractTask },
    { name: 'extractNotebookEdit', fn: extractNotebookEdit },
  ];

  it('return null on empty/malformed input', () => {
    for (const { fn } of extractors) {
      expect(fn({}, undefined)).toBeNull();
    }
  });

  it('truncate content at 2000 chars', () => {
    const longContent = 'a'.repeat(5000);

    // Test a few extractors with long content
    const readResult = extractRead(
      { file_path: '/src/file.ts' },
      { content: longContent }
    );
    expect(readResult).not.toBeNull();
    expect(readResult!.content.length).toBeLessThanOrEqual(2003); // 2000 + "..."

    const writeResult = extractWrite(
      { file_path: '/src/file.ts', content: longContent },
      undefined
    );
    expect(writeResult).not.toBeNull();
    expect(writeResult!.content.length).toBeLessThanOrEqual(2003);

    const bashResult = extractBash(
      { command: 'cat big.log' },
      { output: longContent }
    );
    expect(bashResult).not.toBeNull();
    expect(bashResult!.content.length).toBeLessThanOrEqual(2003);
  });
});
