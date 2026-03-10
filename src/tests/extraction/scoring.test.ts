import { classifyCategory, scoreImportance } from '../../extraction/scoring.js';

describe('scoring and classification', () => {
  // --- classifyCategory ---

  describe('classifyCategory', () => {
    it('error keywords -> error', () => {
      expect(classifyCategory('Bash', 'Build failed', 'exception thrown')).toBe('error');
    });

    it('test keywords -> test', () => {
      expect(classifyCategory('Bash', 'Run tests', 'assert passed')).toBe('test');
    });

    it('config keywords -> config', () => {
      expect(classifyCategory('Read', 'Read config', 'env variable settings')).toBe('config');
    });

    it('security keywords -> security', () => {
      expect(classifyCategory('Read', 'Check auth', 'credential management')).toBe('security');
    });

    it('first match wins (error before test)', () => {
      // Contains both "error" and "test" — error should win since it's first in the keyword map
      expect(classifyCategory('Bash', 'Test error found', 'test failure exception')).toBe('error');
    });

    it('default code for file-related tools', () => {
      expect(classifyCategory('Read', 'Read file', 'const x = 42')).toBe('code');
      expect(classifyCategory('Edit', 'Edit file', 'updated function')).toBe('code');
      expect(classifyCategory('Write', 'Write file', 'new module')).toBe('code');
      expect(classifyCategory('Grep', 'Search code', 'found something')).toBe('code');
      expect(classifyCategory('Glob', 'Find files', 'matched paths')).toBe('code');
      expect(classifyCategory('NotebookEdit', 'Edit notebook', 'cell content')).toBe('code');
    });

    it('default other for non-file tools', () => {
      expect(classifyCategory('Bash', 'Run command', 'output here')).toBe('other');
      expect(classifyCategory('WebFetch', 'Fetch page', 'html content')).toBe('other');
      expect(classifyCategory('Task', 'Spawn task', 'task output')).toBe('other');
    });
  });

  // --- scoreImportance ---

  describe('scoreImportance', () => {
    it('security category -> 5', () => {
      expect(scoreImportance('Read', 'security', 'some content')).toBe(5);
    });

    it('architecture category -> 5', () => {
      expect(scoreImportance('Read', 'architecture', 'some content')).toBe(5);
    });

    it('breaking change content -> 5', () => {
      expect(scoreImportance('Edit', 'code', 'this is a BREAKING change')).toBe(5);
    });

    it('config category -> 4', () => {
      expect(scoreImportance('Read', 'config', 'some config content')).toBe(4);
    });

    it('Edit tool -> 3', () => {
      expect(scoreImportance('Edit', 'code', 'updated function body')).toBe(3);
    });

    it('Write tool -> 3', () => {
      expect(scoreImportance('Write', 'code', 'new file content')).toBe(3);
    });

    it('Read tool -> 2', () => {
      expect(scoreImportance('Read', 'code', 'export function hello() { return true; }')).toBe(2);
    });

    it('unknown trivial -> 1', () => {
      expect(scoreImportance('SomeOtherTool', 'other', 'trivial output')).toBe(1);
    });
  });
});
