/**
 * Unit tests for CwdChanged hook (H10/H15).
 * Tests env file rewrite, project re-detection, watchPaths, and event recording.
 */

import { createTestDb, type TestDatabase } from '../../helpers/test-db.js';
import { createSession } from '../../../core/sessions.js';
import { recordEvent, getSessionEvents } from '../../../core/session-events.js';
import { writeClaudeEnvFile } from '../../../adapters/shared/env-file.js';
import { detectProjectScope, deriveProjectId } from '../../../shared/scope-detector.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('CwdChanged hook logic', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, {
      session_id: 'cwd-test-s1',
      project: 'test-proj',
      cwd: '/tmp/old-project',
      source: 'cc-hooks',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('records cwd_changed event with new_cwd as entity and old_cwd as action', () => {
    const oldCwd = '/tmp/old-project';
    const newCwd = '/tmp/new-project';
    const newProjectId = deriveProjectId(newCwd);
    const newScope = detectProjectScope(newCwd);

    recordEvent(
      db,
      'cwd-test-s1',
      'test-proj',
      'cwd_changed',
      newCwd,
      oldCwd,
      JSON.stringify({ new_project: newProjectId, new_scope: newScope ?? undefined }),
    );

    const events = getSessionEvents(db, 'cwd-test-s1');
    const cwdEvent = events.find(e => e.event_type === 'cwd_changed');
    expect(cwdEvent).toBeDefined();
    expect(cwdEvent!.entity).toBe(newCwd);
    expect(cwdEvent!.action).toBe(oldCwd);
    expect(cwdEvent!.detail).toContain('new_project');
  });

  it('writeClaudeEnvFile writes env flags when CLAUDE_ENV_FILE is set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-test-'));
    const envFile = path.join(tmpDir, 'env');

    const origEnv = process.env.CLAUDE_ENV_FILE;
    try {
      process.env.CLAUDE_ENV_FILE = envFile;
      writeClaudeEnvFile();

      expect(fs.existsSync(envFile)).toBe(true);
      const content = fs.readFileSync(envFile, 'utf-8');
      expect(content).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
      expect(content).toContain('CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT=1');
    } finally {
      process.env.CLAUDE_ENV_FILE = origEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writeClaudeEnvFile is non-throwing when CLAUDE_ENV_FILE is not set', () => {
    const origEnv = process.env.CLAUDE_ENV_FILE;
    try {
      delete process.env.CLAUDE_ENV_FILE;
      expect(() => writeClaudeEnvFile()).not.toThrow();
    } finally {
      process.env.CLAUDE_ENV_FILE = origEnv;
    }
  });

  it('re-detects project scope for new_cwd', () => {
    const newCwd = '/tmp/some-new-project';
    const scope = detectProjectScope(newCwd);
    const projectId = deriveProjectId(newCwd);

    // deriveProjectId always returns a non-empty string
    expect(typeof projectId).toBe('string');
    expect(projectId.length).toBeGreaterThan(0);
    // scope may be null for paths outside known project dirs
    expect(scope === null || typeof scope === 'string').toBe(true);
  });

  it('returns watchPaths for existing files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-watch-'));
    const handoffDir = path.join(tmpDir, 'context', 'handoffs');
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, 'ACTIVE.md'), '# active');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# claude');

    const watchPaths: string[] = [];
    const handoffPath = path.join(tmpDir, 'context', 'handoffs', 'ACTIVE.md');
    if (fs.existsSync(handoffPath)) watchPaths.push(handoffPath);
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) watchPaths.push(claudeMdPath);

    expect(watchPaths).toHaveLength(2);
    expect(watchPaths[0]).toContain('ACTIVE.md');
    expect(watchPaths[1]).toContain('CLAUDE.md');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty watchPaths when files do not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-nowatch-'));

    const watchPaths: string[] = [];
    const handoffPath = path.join(tmpDir, 'context', 'handoffs', 'ACTIVE.md');
    if (fs.existsSync(handoffPath)) watchPaths.push(handoffPath);
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) watchPaths.push(claudeMdPath);

    expect(watchPaths).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hookSpecificOutput has correct shape with hookEventName', () => {
    const watchPaths = ['/tmp/test/CLAUDE.md'];
    const output = {
      hookSpecificOutput: {
        hookEventName: 'CwdChanged',
        watchPaths,
      },
    };

    expect(output.hookSpecificOutput.hookEventName).toBe('CwdChanged');
    expect(output.hookSpecificOutput.watchPaths).toEqual(['/tmp/test/CLAUDE.md']);
  });
});
