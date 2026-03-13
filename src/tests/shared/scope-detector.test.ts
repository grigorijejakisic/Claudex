import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// Mock fs-helpers so detectProjectScope reads from our fake projects.json
vi.mock('../../shared/fs-helpers.js', () => ({
  readJsonFile: vi.fn(() => null),
  writeJsonFile: vi.fn(async () => true),
}));

import { detectProjectScope, getProjectId } from '../../shared/scope-detector.js';
import { readJsonFile } from '../../shared/fs-helpers.js';

const mockReadJsonFile = vi.mocked(readJsonFile);

describe('detectProjectScope', () => {
  beforeEach(() => {
    mockReadJsonFile.mockReset();
  });

  it('returns null when projects.json is missing', () => {
    mockReadJsonFile.mockReturnValue(null);
    expect(detectProjectScope('C:\\Work\\App')).toBeNull();
  });

  it('returns project ID for exact match', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Work\\App': 'my-app' },
    });
    expect(detectProjectScope('C:\\Work\\App')).toBe('my-app');
  });

  it('returns project ID for subdirectory match', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Work\\App': 'my-app' },
    });
    expect(detectProjectScope('C:\\Work\\App\\src\\index.ts')).toBe('my-app');
  });

  it('does NOT match sibling directory with shared prefix (path boundary bug)', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Work\\App': 'my-app' },
    });
    // C:\Work\App-archive should NOT match C:\Work\App
    expect(detectProjectScope('C:\\Work\\App-archive')).toBeNull();
  });

  it('does NOT match longer name starting with project path', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Work\\App': 'my-app' },
    });
    expect(detectProjectScope('C:\\Work\\AppData')).toBeNull();
  });

  it('selects longest matching path when multiple projects match', () => {
    mockReadJsonFile.mockReturnValue({
      projects: {
        'C:\\Work': 'work',
        'C:\\Work\\App': 'my-app',
      },
    });
    expect(detectProjectScope('C:\\Work\\App\\src')).toBe('my-app');
  });
});

describe('getProjectId', () => {
  beforeEach(() => {
    mockReadJsonFile.mockReset();
    mockReadJsonFile.mockReturnValue(null); // No projects.json — force fallback path
  });

  it('returns detected scope if available', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Work\\App': 'registered-id' },
    });
    expect(getProjectId('C:\\Work\\App')).toBe('registered-id');
  });

  it('derives sanitized name from directory basename', () => {
    const id = getProjectId('C:\\Work\\MyProject');
    // Should start with sanitized basename
    expect(id).toMatch(/^myproject-[0-9a-f]{8}$/);
  });

  it('two different paths with same basename produce different IDs', () => {
    const id1 = getProjectId('C:\\Users\\Alice\\Projects\\App');
    const id2 = getProjectId('C:\\Users\\Bob\\Projects\\App');
    expect(id1).not.toBe(id2);
    // Both should start with 'app-'
    expect(id1).toMatch(/^app-/);
    expect(id2).toMatch(/^app-/);
  });

  it('same path always produces the same ID (deterministic)', () => {
    const id1 = getProjectId('C:\\Work\\App');
    const id2 = getProjectId('C:\\Work\\App');
    expect(id1).toBe(id2);
  });

  it('handles special characters in directory name', () => {
    const id = getProjectId('C:\\Work\\My Cool Project!');
    expect(id).toMatch(/^my-cool-project-[0-9a-f]{8}$/);
  });

  it('handles unicode characters in directory name', () => {
    const id = getProjectId('C:\\Users\\Ünîcödé\\project');
    // Unicode stripped by sanitizer, but hash provides uniqueness
    expect(id).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
  });

  it('is deterministic for unicode paths', () => {
    const id1 = getProjectId('C:\\Users\\日本語\\プロジェクト');
    const id2 = getProjectId('C:\\Users\\日本語\\プロジェクト');
    expect(id1).toBe(id2);
  });

  it('different unicode paths produce different IDs', () => {
    const id1 = getProjectId('C:\\Users\\Ünîcödé\\project');
    const id2 = getProjectId('C:\\Users\\Grégoire\\project');
    expect(id1).not.toBe(id2);
  });
});

describe('detectProjectScope — paths with spaces', () => {
  beforeEach(() => {
    mockReadJsonFile.mockReset();
  });

  it('matches path with spaces exactly', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Users\\My User\\Desktop\\project': 'spaced-id' },
    });
    expect(detectProjectScope('C:\\Users\\My User\\Desktop\\project')).toBe('spaced-id');
  });

  it('matches subdirectory of path with spaces', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Users\\My User\\Desktop\\project': 'spaced-id' },
    });
    expect(detectProjectScope('C:\\Users\\My User\\Desktop\\project\\src')).toBe('spaced-id');
  });

  it('does not match sibling with shared prefix when spaces present', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Users\\My User\\App': 'app-id' },
    });
    expect(detectProjectScope('C:\\Users\\My User\\App-backup')).toBeNull();
  });
});

describe('detectProjectScope — paths with unicode', () => {
  beforeEach(() => {
    mockReadJsonFile.mockReset();
  });

  it('matches path with unicode characters', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Users\\Ünîcödé\\project': 'unicode-id' },
    });
    expect(detectProjectScope('C:\\Users\\Ünîcödé\\project')).toBe('unicode-id');
  });

  it('matches subdirectory of unicode path', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Users\\Ünîcödé\\project': 'unicode-id' },
    });
    expect(detectProjectScope('C:\\Users\\Ünîcödé\\project\\src\\lib')).toBe('unicode-id');
  });

  it('matches CJK paths', () => {
    mockReadJsonFile.mockReturnValue({
      projects: { 'C:\\Users\\用户\\项目': 'cjk-id' },
    });
    expect(detectProjectScope('C:\\Users\\用户\\项目')).toBe('cjk-id');
  });
});
