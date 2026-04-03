/**
 * Tests for claudex setup CLI logic.
 * Calls exported functions directly with temp directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import {
  getHookPaths,
  patchSettingsJson,
  getSettingsJsonPath,
} from '../../cli/setup.js';
import { detectV2Database } from '../../core/migrations.js';

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-setup-test-'));
}

// --- getHookPaths tests ---

describe('getHookPaths', () => {
  it('returns correct absolute paths for all 25 hooks', () => {
    const installDir = '/opt/claudex';
    const paths = getHookPaths(installDir);

    expect(Object.keys(paths)).toHaveLength(25);
    expect(paths.SessionStart).toContain('session-start.cjs');
    expect(paths.UserPromptSubmit).toContain('user-prompt-submit.cjs');
    expect(paths.PostToolUse).toContain('post-tool-use.cjs');
    expect(paths.Stop).toContain('stop.cjs');
    expect(paths.PreCompact).toContain('pre-compact.cjs');
    expect(paths.SessionEnd).toContain('session-end.cjs');
    expect(paths.PostCompact).toContain('post-compact.cjs');
    expect(paths.SubagentStart).toContain('subagent-start.cjs');
    expect(paths.SubagentStop).toContain('subagent-stop.cjs');
    expect(paths.TaskCreated).toContain('task-created.cjs');
    expect(paths.TaskCompleted).toContain('task-completed.cjs');
    expect(paths.PermissionRequest).toContain('permission-request.cjs');
    expect(paths.PermissionDenied).toContain('permission-denied.cjs');
    expect(paths.Elicitation).toContain('elicitation.cjs');
    expect(paths.ElicitationResult).toContain('elicitation-result.cjs');
    expect(paths.PostToolUseFailure).toContain('post-tool-use-failure.cjs');
    expect(paths.StopFailure).toContain('stop-failure.cjs');
    expect(paths.ConfigChange).toContain('config-change.cjs');
    expect(paths.InstructionsLoaded).toContain('instructions-loaded.cjs');
    expect(paths.CwdChanged).toContain('cwd-changed.cjs');
    expect(paths.Setup).toContain('setup.cjs');
    expect(paths.WorktreeCreate).toContain('worktree-create.cjs');
    expect(paths.WorktreeRemove).toContain('worktree-remove.cjs');
    expect(paths.PreToolUse).toContain('pre-tool-use.cjs');

    // Verify hook paths include correct dist subdirectory
    for (const hookPath of Object.values(paths)) {
      expect(hookPath).toContain(path.join('dist', 'adapters', 'cc-hooks'));
    }
  });

  it('paths are absolute', () => {
    const installDir = '/opt/claudex';
    const paths = getHookPaths(installDir);

    for (const hookPath of Object.values(paths)) {
      expect(path.isAbsolute(hookPath)).toBe(true);
    }
  });
});

// --- patchSettingsJson tests ---

describe('patchSettingsJson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const hookPaths: Record<string, string> = {
    SessionStart: '/opt/CLAUDEXv3/dist/session-start.js',
    UserPromptSubmit: '/opt/CLAUDEXv3/dist/user-prompt-submit.js',
    PostToolUse: '/opt/CLAUDEXv3/dist/post-tool-use.js',
    Stop: '/opt/CLAUDEXv3/dist/stop.js',
    PreCompact: '/opt/CLAUDEXv3/dist/pre-compact.js',
    SessionEnd: '/opt/CLAUDEXv3/dist/session-end.js',
  };

  it('creates new settings.json with hooks when file does not exist', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const result = patchSettingsJson(settingsPath, hookPaths);

    expect(result.patched).toBe(true);
    expect(result.created).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(Object.keys(settings.hooks)).toHaveLength(6);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('merges hooks into existing settings.json preserving other keys', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ someOtherKey: true, hooks: {} }));

    patchSettingsJson(settingsPath, hookPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.someOtherKey).toBe(true);
    expect(Object.keys(settings.hooks)).toHaveLength(6);
  });

  it('preserves existing non-Claudex hooks', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo pre-tool' }] },
          ],
        },
      })
    );

    patchSettingsJson(settingsPath, hookPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // PreToolUse preserved + 6 Claudex hooks
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it('updates existing Claudex hooks in-place (no duplicates)', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');

    // First patch
    patchSettingsJson(settingsPath, hookPaths);

    // Second patch with different install dir
    const newPaths: Record<string, string> = {};
    for (const [k, v] of Object.entries(hookPaths)) {
      newPaths[k] = v.replace('CLAUDEXv3', 'CLAUDEXv3-new');
    }
    patchSettingsJson(settingsPath, newPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // Should still be 1 entry per hook, not 2
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('CLAUDEXv3-new');
  });

  it('creates hooks object if settings exists but has no hooks key', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ version: 1 }));

    patchSettingsJson(settingsPath, hookPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.version).toBe(1);
    expect(Object.keys(settings.hooks)).toHaveLength(6);
  });

  it('generated command uses node with quoted absolute path', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    patchSettingsJson(settingsPath, hookPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    for (const hookEntries of Object.values(settings.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      for (const entry of hookEntries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toMatch(/^node '/);
          // Path should be wrapped in single quotes (shell-safe)
          const match = hook.command.match(/^node '(.+)'$/);
          expect(match).not.toBeNull();
          expect(path.isAbsolute(match![1])).toBe(true);
        }
      }
    }
  });

  it('generated hook commands have quoted paths (handles spaces)', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const spacedPaths: Record<string, string> = {
      SessionStart: '/opt/My Projects/CLAUDEXv3/dist/session-start.js',
      Stop: '/opt/My Projects/CLAUDEXv3/dist/stop.js',
    };
    patchSettingsJson(settingsPath, spacedPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const startCmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(startCmd).toBe("node '/opt/My Projects/CLAUDEXv3/dist/session-start.js'");
    const stopCmd = settings.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toBe("node '/opt/My Projects/CLAUDEXv3/dist/stop.js'");
  });
});

// --- Hook command Windows compatibility tests ---

describe('hook command Windows compatibility', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses single-quote wrapping in commands (POSIX style)', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const paths: Record<string, string> = {
      SessionStart: '/opt/CLAUDEXv3/dist/session-start.js',
    };
    patchSettingsJson(settingsPath, paths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    // Command wraps path in single quotes
    expect(cmd).toMatch(/^node '/);
    expect(cmd).toBe("node '/opt/CLAUDEXv3/dist/session-start.js'");
  });

  it('properly handles paths with spaces and special chars', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const paths: Record<string, string> = {
      SessionStart: 'C:\\Users\\My User\\CLAUDEXv3\\dist\\session-start.js',
    };
    patchSettingsJson(settingsPath, paths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    // Path is wrapped in single quotes (handles spaces)
    expect(cmd).toMatch(/^node '/);
    expect(cmd).toContain('My User');
  });

  it('handles paths with ampersand characters safely', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const paths: Record<string, string> = {
      SessionStart: 'C:\\Dev&Test\\CLAUDEXv3\\dist\\session-start.js',
    };
    patchSettingsJson(settingsPath, paths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    // Path with & is wrapped in single quotes (safe in POSIX)
    expect(cmd).toMatch(/^node '.*&.*'$/);
  });

  it('handles paths with pipe characters safely', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const paths: Record<string, string> = {
      SessionStart: 'C:\\path|weird\\dist\\session-start.js',
    };
    patchSettingsJson(settingsPath, paths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    // Path with | is wrapped in single quotes (safe in POSIX)
    expect(cmd).toMatch(/^node '.*\|.*'$/);
  });
});

// --- detectV2Database tests (imported from core/migrations) ---

describe('detectV2Database', () => {
  it('returns string or null (non-throwing)', () => {
    // detectV2Database() searches known claudex paths for a v2 DB.
    // In a test environment, it should return null (no v2 DB at standard paths)
    // or a string path. Either way, it must not throw.
    const result = detectV2Database();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('is non-throwing even if claudex home does not exist', () => {
    // The function catches all errors internally
    expect(() => detectV2Database()).not.toThrow();
  });
});

// --- Idempotency tests ---

describe('patchSettingsJson idempotency', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const hookPaths: Record<string, string> = {
    SessionStart: '/opt/CLAUDEXv3/dist/session-start.js',
    UserPromptSubmit: '/opt/CLAUDEXv3/dist/user-prompt-submit.js',
    PostToolUse: '/opt/CLAUDEXv3/dist/post-tool-use.js',
    Stop: '/opt/CLAUDEXv3/dist/stop.js',
    PreCompact: '/opt/CLAUDEXv3/dist/pre-compact.js',
    SessionEnd: '/opt/CLAUDEXv3/dist/session-end.js',
  };

  it('is idempotent', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    patchSettingsJson(settingsPath, hookPaths);
    patchSettingsJson(settingsPath, hookPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // Exactly 6 hook entries, not 12
    expect(Object.keys(settings.hooks)).toHaveLength(6);
    for (const entries of Object.values(settings.hooks) as Array<unknown[]>) {
      expect(entries).toHaveLength(1);
    }
  });

  it('settings.json hook format matches CC expected structure', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    patchSettingsJson(settingsPath, hookPaths);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    for (const [hookName, entries] of Object.entries(settings.hooks) as Array<[string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>]>) {
      expect(entries).toHaveLength(1);
      expect(entries[0]).toHaveProperty('matcher', '');
      expect(entries[0].hooks).toHaveLength(1);
      expect(entries[0].hooks[0]).toHaveProperty('type', 'command');
      expect(entries[0].hooks[0].command).toMatch(/^node '/);
    }
  });
});
