import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';

// Mock fs-helpers, fs, and scope-detector for controlled testing
vi.mock('../../shared/fs-helpers.js', () => ({
  readJsonFile: vi.fn(() => null),
}));

vi.mock('../../shared/scope-detector.js', () => ({
  deriveProjectId: vi.fn((cwd: string) => {
    const path = require('path');
    const baseName = path.basename(cwd);
    return baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-test1234';
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readdirSync: vi.fn(() => []),
  };
});

import {
  buildProjectIndex,
  routeByContent,
  extractRoutingContent,
  type ProjectSignature,
} from '../../shared/content-router.js';
import { readJsonFile } from '../../shared/fs-helpers.js';

const mockReadJsonFile = vi.mocked(readJsonFile);
const mockReaddirSync = vi.mocked(fs.readdirSync);

// Helper to build a test ProjectSignature with precomputed fields
function sig(id: string, dirName: string, fullPath: string, aliases: string[]): ProjectSignature {
  const pathFwd = fullPath.toLowerCase().replace(/\\/g, '/');
  return {
    id,
    dirName,
    fullPath,
    pathFwd,
    msysPath: pathFwd.replace(/^([a-z]):/, '/$1'),
    aliases,
    aliasPatterns: aliases.map(a => ({
      pattern: new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      length: a.length,
    })),
  };
}

// Reusable test project index (sorted by path length desc, matching production behavior)
const testIndex: ProjectSignature[] = [
  sig('openclaw-main', 'openclaw-main', 'C:\\Users\\Test\\Desktop\\Projects\\openclaw-main', ['openclaw-main', 'openclaw', 'openclawmain']),
  sig('claudex-v3', 'CLAUDEXv3', 'C:\\Users\\Test\\Desktop\\Projects\\CLAUDEXv3', ['claudex-v3', 'claudexv3', 'claudex']),
  sig('paperclip', 'paperclip', 'C:\\Users\\Test\\Desktop\\Projects\\paperclip', ['paperclip']),
  sig('chell', 'Chell', 'C:\\Users\\Test\\Desktop\\Projects\\Chell', ['chell']),
  sig('vesna', 'Vesna', 'C:\\Users\\Test\\Desktop\\Projects\\Vesna', ['vesna']),
];

describe('routeByContent', () => {
  it('returns cwdProject for empty content', () => {
    expect(routeByContent('', 'claudex-v3', testIndex)).toBe('claudex-v3');
  });

  it('returns cwdProject for empty project index', () => {
    expect(routeByContent('discussing paperclip', 'claudex-v3', [])).toBe('claudex-v3');
  });

  it('returns cwdProject when no match found', () => {
    expect(routeByContent('random unrelated content about cooking', 'claudex-v3', testIndex))
      .toBe('claudex-v3');
  });

  // File path matching — strongest signal
  describe('file path routing', () => {
    it('routes by Windows file path', () => {
      const content = 'Reading C:\\Users\\Test\\Desktop\\Projects\\paperclip\\doc\\SPEC.md';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });

    it('routes by forward-slash file path', () => {
      const content = 'Reading c:/users/test/desktop/projects/paperclip/doc/SPEC.md';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });

    it('routes by MSYS/git-bash file path', () => {
      const content = 'File at /c/users/test/desktop/projects/openclaw-main/src/index.ts';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('openclaw-main');
    });

    it('does not reroute to CWD project (already default)', () => {
      const content = 'Reading C:\\Users\\Test\\Desktop\\Projects\\CLAUDEXv3\\src\\foo.ts';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('claudex-v3');
    });

    it('does not match path prefix collisions (app vs app-old)', () => {
      // Add a shorter-path project that could cause prefix collision
      const indexWithCollision = [
        sig('paperclip', 'paperclip', 'C:\\Users\\Test\\Desktop\\Projects\\paperclip', ['paperclip']),
        sig('paperclip-fix', 'paperclip-fix', 'C:\\Users\\Test\\Desktop\\Projects\\paperclip-fix', ['paperclip-fix']),
      ];
      // Content references paperclip-fix, should NOT match paperclip
      const content = 'Reading c:/users/test/desktop/projects/paperclip-fix/src/index.ts';
      expect(routeByContent(content, 'claudex-v3', indexWithCollision)).toBe('paperclip-fix');
    });

    it('matches exact project path without subpath', () => {
      const content = 'The project at C:\\Users\\Test\\Desktop\\Projects\\paperclip is important';
      // After the path, next char is space (not '/'), so boundary check passes
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });
  });

  // Project name matching — word boundary
  describe('name-based routing', () => {
    it('routes when project name mentioned enough times (above threshold)', () => {
      // "paperclip" (9 chars) × 3 mentions = score 27, above MIN_NAME_SCORE of 20
      const content = 'We need to update the paperclip orchestration spec for paperclip. paperclip is key.';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });

    it('does not route on single mention of short name (below threshold)', () => {
      // "chell" (5 chars) × 1 mention = score 5, below MIN_NAME_SCORE of 20
      const content = 'We discussed chell briefly in the meeting';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('claudex-v3');
    });

    it('routes by alias (stripped suffix) with enough mentions', () => {
      // "openclaw" (8 chars) × 3 mentions = score 24, above threshold
      const content = 'The openclaw gateway handles openclaw message routing in openclaw';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('openclaw-main');
    });

    it('routes to project with strongest match when multiple mentioned', () => {
      // "paperclip" mentioned 3 times (score 27) vs "chell" mentioned 1 time (score 5)
      const content = 'paperclip orchestrates paperclip tasks. chell is abandoned. paperclip is better.';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });

    it('respects word boundaries — no substring false positives', () => {
      // "vessel" contains "ves" but should not match "vesna"
      const content = 'The vessel docked at port';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('claudex-v3');
    });

    it('case insensitive matching (with enough mentions)', () => {
      const content = 'PAPERCLIP handles the PAPERCLIP orchestration layer for PAPERCLIP';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });

    it('does not reroute to archived project with shared alias', () => {
      // "claudex" is an alias of both claudex (archived) and claudex-v3 (CWD).
      // CWD project should win because its aliases also match — no reroute.
      const content = 'The claudex memory system handles observations';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('claudex-v3');
    });

    it('reroutes only when non-CWD project scores strictly higher and above threshold', () => {
      // "paperclip" mentioned 3 times (score 27), "claudex" mentioned 1 time
      // paperclip scores higher than CWD and above threshold, so it wins
      const content = 'paperclip paperclip paperclip uses claudex for memory';
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('handles null/undefined gracefully', () => {
      expect(routeByContent(null as unknown as string, 'claudex-v3', testIndex)).toBe('claudex-v3');
      expect(routeByContent(undefined as unknown as string, 'claudex-v3', testIndex)).toBe('claudex-v3');
    });

    it('handles very long content (performance cap)', () => {
      const longContent = 'a'.repeat(100000) + ' paperclip';
      // paperclip is beyond the 5000 char cap — should not match
      expect(routeByContent(longContent, 'claudex-v3', testIndex)).toBe('claudex-v3');
    });

    it('matches path within the cap limit', () => {
      // Path match bypasses score threshold — note path must be followed by /
      const content = 'C:\\Users\\Test\\Desktop\\Projects\\paperclip/doc.md ' + 'a'.repeat(100000);
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('paperclip');
    });

    it('does not match single name mention (below threshold)', () => {
      const content = 'paperclip ' + 'a'.repeat(100000);
      // Single "paperclip" mention (score 9) is below MIN_NAME_SCORE of 20
      expect(routeByContent(content, 'claudex-v3', testIndex)).toBe('claudex-v3');
    });
  });
});

describe('extractRoutingContent', () => {
  it('extracts file_path from tool input', () => {
    const result = extractRoutingContent({ file_path: '/c/Projects/paperclip/doc/SPEC.md' });
    expect(result).toContain('/c/Projects/paperclip/doc/SPEC.md');
  });

  it('extracts command from tool input', () => {
    const result = extractRoutingContent({ command: 'cd paperclip && npm test' });
    expect(result).toContain('paperclip');
  });

  it('includes tool output when provided', () => {
    const result = extractRoutingContent(
      { tool_name: 'Read' },
      { content: 'paperclip orchestration logic' },
    );
    expect(result).toContain('paperclip');
  });

  it('handles empty input gracefully', () => {
    const result = extractRoutingContent({});
    expect(typeof result).toBe('string');
  });

  it('caps output length', () => {
    const result = extractRoutingContent(
      { content: 'x'.repeat(10000) },
      { content: 'y'.repeat(10000) },
    );
    expect(result.length).toBeLessThanOrEqual(5000);
  });
});

describe('buildProjectIndex', () => {
  beforeEach(() => {
    mockReadJsonFile.mockReset();
    mockReaddirSync.mockReset();
  });

  it('builds index from projects.json', () => {
    mockReadJsonFile.mockReturnValue({
      projects: {
        'my-project': {
          path: 'C:\\Users\\Test\\Projects\\MyProject',
          status: 'active',
        },
      },
    });
    mockReaddirSync.mockReturnValue([]);

    const index = buildProjectIndex();
    expect(index.length).toBe(1);
    expect(index[0].id).toBe('my-project');
    expect(index[0].dirName).toBe('MyProject');
    expect(index[0].aliases).toContain('my-project');
    expect(index[0].aliases).toContain('myproject');
  });

  it('builds index from directory scan for unregistered projects', () => {
    mockReadJsonFile.mockReturnValue({ projects: {} });
    mockReaddirSync.mockReturnValue([
      { name: 'paperclip', isDirectory: () => true },
      { name: 'readme.md', isDirectory: () => false },
    ] as unknown as fs.Dirent[]);

    const index = buildProjectIndex();
    expect(index.length).toBe(1);
    // ID now uses deriveProjectId (sanitized + hash) for consistency with runtime
    expect(index[0].id).toBe('paperclip-test1234');
  });

  it('deduplicates registered vs scanned projects', () => {
    mockReadJsonFile.mockReturnValue({
      projects: {
        'my-proj': { path: 'C:\\Users\\Test\\Desktop\\Projects\\MyProj' },
      },
    });
    mockReaddirSync.mockReturnValue([
      { name: 'MyProj', isDirectory: () => true },
      { name: 'OtherProj', isDirectory: () => true },
    ] as unknown as fs.Dirent[]);

    const index = buildProjectIndex();
    // MyProj from registry + OtherProj from scan (MyProj not duplicated)
    expect(index.length).toBe(2);
    expect(index.map(p => p.id)).toContain('my-proj');
    expect(index.map(p => p.id)).toContain('otherproj-test1234');
  });

  it('handles missing projects.json gracefully', () => {
    mockReadJsonFile.mockReturnValue(null);
    mockReaddirSync.mockReturnValue([]);
    const index = buildProjectIndex();
    expect(index).toEqual([]);
  });

  it('handles directory scan failure gracefully', () => {
    mockReadJsonFile.mockReturnValue({ projects: {} });
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const index = buildProjectIndex();
    expect(index).toEqual([]);
  });
});
