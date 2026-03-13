import { extractTask } from '../../../extraction/extractors/task.js';

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
