import { passesQualityGate } from '../../extraction/quality-gate.js';

describe('quality gates', () => {
  // --- Read ---

  it('Read: passes with structural content >= 100 chars', () => {
    const content = 'export function hello() {\n  return "world";\n}\n' + 'a'.repeat(60);
    const result = passesQualityGate('Read', {}, { content });
    expect(result.pass).toBe(true);
  });

  it('Read: fails with short content', () => {
    const result = passesQualityGate('Read', {}, { content: 'short' });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('read_too_short');
  });

  it('Read: fails with no structural elements', () => {
    const content = 'a'.repeat(150); // long but no structure
    const result = passesQualityGate('Read', {}, { content });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('read_no_structure');
  });

  // --- Edit / Write ---

  it('Edit: always passes', () => {
    const result = passesQualityGate('Edit', {}, {});
    expect(result.pass).toBe(true);
  });

  it('Write: always passes', () => {
    const result = passesQualityGate('Write', {}, {});
    expect(result.pass).toBe(true);
  });

  // --- Bash ---

  it('Bash: fails for trivial commands (ls, cd, pwd)', () => {
    for (const cmd of ['ls', 'cd /tmp', 'pwd', 'echo hello', 'cat file', 'which node', 'type cmd']) {
      const result = passesQualityGate('Bash', { command: cmd }, { output: '' });
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('bash_trivial_command');
    }
  });

  it('Bash: passes for non-trivial command with output >= 20 chars', () => {
    const result = passesQualityGate(
      'Bash',
      { command: 'npm install' },
      { output: 'added 42 packages in 3s' }
    );
    expect(result.pass).toBe(true);
  });

  it('Bash: passes for command with non-zero exit code', () => {
    const result = passesQualityGate(
      'Bash',
      { command: 'npm test' },
      { exitCode: 1, output: 'fail' }
    );
    expect(result.pass).toBe(true);
  });

  it('Bash: passes for non-trivial command with stdout (not output) >= 20 chars', () => {
    const result = passesQualityGate(
      'Bash',
      { command: 'npm install' },
      { stdout: 'added 42 packages in 3s' }
    );
    expect(result.pass).toBe(true);
  });

  it('Bash: fails for non-trivial command with < 20 chars output', () => {
    const result = passesQualityGate(
      'Bash',
      { command: 'npm install' },
      { output: 'ok' }
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('bash_no_output');
  });

  // --- Grep ---

  it('Grep: passes with >= 1 match', () => {
    const result = passesQualityGate('Grep', {}, { matchCount: 3 });
    expect(result.pass).toBe(true);
  });

  it('Grep: fails with 0 matches', () => {
    const result = passesQualityGate('Grep', {}, { matchCount: 0 });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('grep_no_matches');
  });

  it('Grep: passes with matchCount but no content field', () => {
    const result = passesQualityGate('Grep', {}, { matchCount: 5 });
    expect(result.pass).toBe(true);
  });

  it('Grep: passes with matches array but no matchCount', () => {
    const result = passesQualityGate('Grep', {}, { matches: ['line1', 'line2'] });
    expect(result.pass).toBe(true);
  });

  it('Grep: passes with files array but no matchCount', () => {
    const result = passesQualityGate('Grep', {}, { files: ['file1.ts', 'file2.ts'] });
    expect(result.pass).toBe(true);
  });

  it('Grep: passes with content string but no matchCount', () => {
    const result = passesQualityGate('Grep', {}, { content: 'found: something' });
    expect(result.pass).toBe(true);
  });

  it('Grep: fails with empty matches, empty files, and no content', () => {
    const result = passesQualityGate('Grep', {}, { matchCount: 0, matches: [], files: [] });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('grep_no_matches');
  });

  // --- Glob ---

  it('Glob: passes with >= 3 matches', () => {
    const result = passesQualityGate('Glob', {}, { files: ['a', 'b', 'c'] });
    expect(result.pass).toBe(true);
  });

  it('Glob: fails with < 3 matches', () => {
    const result = passesQualityGate('Glob', {}, { files: ['a'] });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('glob_too_few');
  });

  // --- Always-pass tools ---

  it('WebFetch: always passes', () => {
    const result = passesQualityGate('WebFetch', {}, {});
    expect(result.pass).toBe(true);
  });

  it('WebSearch: always passes', () => {
    const result = passesQualityGate('WebSearch', {}, {});
    expect(result.pass).toBe(true);
  });

  it('Task: always passes', () => {
    const result = passesQualityGate('Task', {}, {});
    expect(result.pass).toBe(true);
  });

  it('NotebookEdit: always passes', () => {
    const result = passesQualityGate('NotebookEdit', {}, {});
    expect(result.pass).toBe(true);
  });

  it('Unknown tool: always passes', () => {
    const result = passesQualityGate('SomeNewTool', {}, {});
    expect(result.pass).toBe(true);
  });
});
