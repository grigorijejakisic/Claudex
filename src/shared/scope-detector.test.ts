import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import { detectProjectScope, getProjectId } from './scope-detector.js';
import * as paths from './paths.js';

describe('scope-detector', () => {
  let tmpDir: string;
  let projectsJsonPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-scope-test-'));
    projectsJsonPath = path.join(tmpDir, 'projects.json');
    vi.spyOn(paths, 'getProjectsJsonPath').mockReturnValue(projectsJsonPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe('detectProjectScope', () => {
    it('returns project ID for matching path', () => {
      const projectPath = path.join(tmpDir, 'my-project');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { [projectPath]: 'my-project-id' } }),
        'utf-8'
      );

      const result = detectProjectScope(projectPath);
      expect(result).toBe('my-project-id');
    });

    it('returns project ID for subdirectory of project path', () => {
      const projectPath = path.join(tmpDir, 'my-project');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { [projectPath]: 'my-project-id' } }),
        'utf-8'
      );

      const result = detectProjectScope(path.join(projectPath, 'src', 'foo'));
      expect(result).toBe('my-project-id');
    });

    it('returns null when no match', () => {
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { '/some/other/path': 'other-id' } }),
        'utf-8'
      );

      const result = detectProjectScope('/completely/different/path');
      expect(result).toBeNull();
    });

    it('returns null when no projects.json exists', () => {
      const result = detectProjectScope('/any/path');
      expect(result).toBeNull();
    });

    it('picks longest matching prefix', () => {
      const parent = path.join(tmpDir, 'workspace');
      const child = path.join(tmpDir, 'workspace', 'subproject');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({
          projects: {
            [parent]: 'parent-id',
            [child]: 'child-id',
          },
        }),
        'utf-8'
      );

      const result = detectProjectScope(path.join(child, 'src'));
      expect(result).toBe('child-id');
    });
  });

  describe('getProjectId', () => {
    it('returns derived name with hash when no projects.json exists', () => {
      const result = getProjectId('/some/path/MyProject');
      expect(result).toMatch(/^myproject-[0-9a-f]{8}$/);
    });

    it('returns detected scope when project is registered', () => {
      const projectPath = path.join(tmpDir, 'registered-project');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { [projectPath]: 'registered-id' } }),
        'utf-8'
      );

      const result = getProjectId(projectPath);
      expect(result).toBe('registered-id');
    });

    it('sanitizes directory name to alphanumeric+hyphens', () => {
      const result = getProjectId('/path/to/My_Special.Project!');
      expect(result).toMatch(/^[a-z0-9-]+$/);
    });
  });

  describe('paths with spaces', () => {
    it('detectProjectScope matches path with spaces', () => {
      const projectPath = path.join(tmpDir, 'My Project');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { [projectPath]: 'spaced-id' } }),
        'utf-8'
      );
      expect(detectProjectScope(projectPath)).toBe('spaced-id');
    });

    it('detectProjectScope matches subdirectory of path with spaces', () => {
      const projectPath = path.join(tmpDir, 'My Project');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { [projectPath]: 'spaced-id' } }),
        'utf-8'
      );
      expect(detectProjectScope(path.join(projectPath, 'src', 'utils'))).toBe('spaced-id');
    });

    it('getProjectId derives ID from directory with spaces', () => {
      const result = getProjectId(path.join(tmpDir, 'My Cool Project'));
      expect(result).toMatch(/^my-cool-project-[0-9a-f]{8}$/);
    });

  });

  describe('paths with unicode characters', () => {
    it('detectProjectScope matches path with unicode', () => {
      const projectPath = path.join(tmpDir, 'Ünîcödé-project');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { [projectPath]: 'unicode-id' } }),
        'utf-8'
      );
      expect(detectProjectScope(projectPath)).toBe('unicode-id');
    });

    it('detectProjectScope matches subdirectory of unicode path', () => {
      const projectPath = path.join(tmpDir, 'Ünîcödé-project');
      fs.writeFileSync(
        projectsJsonPath,
        JSON.stringify({ projects: { [projectPath]: 'unicode-id' } }),
        'utf-8'
      );
      expect(detectProjectScope(path.join(projectPath, 'src'))).toBe('unicode-id');
    });

    it('getProjectId derives ID from unicode directory name', () => {
      const result = getProjectId(path.join(tmpDir, 'Ünîcödé'));
      // Unicode letters get stripped by [^a-z0-9-] regex, leaving hyphens or empty
      // The hash should still be deterministic
      expect(result).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
    });

    it('getProjectId is deterministic for unicode paths', () => {
      const unicodePath = path.join(tmpDir, '日本語プロジェクト');
      const id1 = getProjectId(unicodePath);
      const id2 = getProjectId(unicodePath);
      expect(id1).toBe(id2);
    });

  });
});
