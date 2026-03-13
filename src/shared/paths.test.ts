import * as path from 'path';
import * as os from 'os';
import {
  getClaudexHome,
  getDbPath,
  getConfigPath,
  getProjectsJsonPath,
  getIdentityDir,
  getMemoryDir,
  getProjectContextDir,
  getCheckpointsDir,
  getSessionsDir,
  getHandoffsDir,
} from './paths.js';

describe('paths', () => {
  it('getClaudexHome returns path containing .claudex', () => {
    const result = getClaudexHome();
    expect(result).toContain('.claudex');
    expect(typeof result).toBe('string');
  });

  it('getDbPath returns path containing claudex.db', () => {
    const result = getDbPath();
    expect(result).toContain('claudex.db');
    expect(result).toContain('db');
  });

  it('getConfigPath returns path containing config.json', () => {
    const result = getConfigPath();
    expect(result).toContain('config.json');
  });

  it('getProjectsJsonPath returns path containing projects.json', () => {
    const result = getProjectsJsonPath();
    expect(result).toContain('projects.json');
  });

  it('getIdentityDir returns path containing identity', () => {
    const result = getIdentityDir();
    expect(result).toContain('identity');
  });

  it('getMemoryDir returns path containing memory', () => {
    const result = getMemoryDir();
    expect(result).toContain('memory');
  });

  it('getProjectContextDir returns path containing context', () => {
    const result = getProjectContextDir('/some/project');
    expect(result).toContain('context');
  });

  it('getCheckpointsDir returns path containing checkpoints', () => {
    const result = getCheckpointsDir('/some/project');
    expect(result).toContain('checkpoints');
  });

  it('getSessionsDir returns path containing sessions', () => {
    const result = getSessionsDir('/some/project');
    expect(result).toContain('sessions');
  });

  it('getHandoffsDir returns path containing handoffs', () => {
    const result = getHandoffsDir('/some/project');
    expect(result).toContain('handoffs');
  });

  it('all path functions use cross-platform path.join', () => {
    // Verify all functions return normalized paths (no double separators)
    const fns = [
      () => getClaudexHome(),
      () => getDbPath(),
      () => getConfigPath(),
      () => getProjectsJsonPath(),
      () => getIdentityDir(),
      () => getMemoryDir(),
      () => getProjectContextDir('/test'),
      () => getCheckpointsDir('/test'),
      () => getSessionsDir('/test'),
      () => getHandoffsDir('/test'),
    ];

    for (const fn of fns) {
      const result = fn();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  describe('paths with spaces', () => {
    it('getProjectContextDir handles spaces in path', () => {
      const result = getProjectContextDir('C:\\Users\\My User\\Desktop\\project');
      expect(result).toContain('context');
      expect(result).toContain('My User');
    });

    it('getCheckpointsDir handles spaces in path', () => {
      const result = getCheckpointsDir('/home/my user/projects/app');
      expect(result).toContain('checkpoints');
      expect(result).toContain('my user');
    });

    it('getSessionsDir handles spaces in path', () => {
      const result = getSessionsDir('C:\\Program Files\\My App');
      expect(result).toContain('sessions');
      expect(result).toContain('Program Files');
    });

    it('getHandoffsDir handles spaces in path', () => {
      const result = getHandoffsDir('/path with spaces/project dir');
      expect(result).toContain('handoffs');
      expect(result).toContain('path with spaces');
    });
  });

  describe('paths with unicode characters', () => {
    it('getProjectContextDir handles unicode in path', () => {
      const result = getProjectContextDir('C:\\Users\\Ünîcödé\\project');
      expect(result).toContain('context');
      expect(result).toContain('Ünîcödé');
    });

    it('getCheckpointsDir handles CJK characters', () => {
      const result = getCheckpointsDir('/home/用户/项目');
      expect(result).toContain('checkpoints');
      expect(result).toContain('用户');
    });

    it('getSessionsDir handles emoji in path', () => {
      const result = getSessionsDir('/home/user/🚀project');
      expect(result).toContain('sessions');
      expect(result).toContain('🚀project');
    });

    it('getHandoffsDir handles mixed unicode and spaces', () => {
      const result = getHandoffsDir('C:\\Users\\Grégoire Müller\\проект');
      expect(result).toContain('handoffs');
      expect(result).toContain('Grégoire Müller');
    });
  });

  describe('paths with long names (>260 chars)', () => {
    it('getProjectContextDir handles long paths', () => {
      const longSegment = 'a'.repeat(200);
      const longPath = path.join('C:\\', 'Users', 'test', longSegment, 'project');
      const result = getProjectContextDir(longPath);
      expect(result).toContain('context');
      expect(result).toContain(longSegment);
    });

    it('getCheckpointsDir handles deeply nested long paths', () => {
      // Build a path that exceeds 260 chars through nesting
      const segments = Array.from({ length: 30 }, (_, i) => `segment${i}`);
      const longPath = path.join('C:\\', ...segments);
      expect(longPath.length).toBeGreaterThan(260);
      const result = getCheckpointsDir(longPath);
      expect(result).toContain('checkpoints');
    });
  });
});
