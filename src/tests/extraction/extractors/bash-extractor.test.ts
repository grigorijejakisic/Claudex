import { extractBash } from '../../../extraction/extractors/bash.js';

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
