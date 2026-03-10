import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import { detectProjectScope, registerProject, getProjectId } from './scope-detector.js';
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
    it('returns derived name when no projects.json exists', () => {
      const result = getProjectId('/some/path/MyProject');
      expect(result).toBe('myproject');
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

  describe('registerProject', () => {
    it('registers and detects a project', async () => {
      const projectPath = path.join(tmpDir, 'new-project');
      const registered = await registerProject(projectPath, 'new-id');
      expect(registered).toBe(true);

      const detected = detectProjectScope(projectPath);
      expect(detected).toBe('new-id');
    });
  });
});
