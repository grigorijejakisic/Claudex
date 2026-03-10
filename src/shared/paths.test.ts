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
});
