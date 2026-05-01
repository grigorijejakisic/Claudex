import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  getProjectsDir,
  CLAUDEX_PROJECTS_DIR_ENV,
} from '../../shared/projects-dir.js';

const TMP_ROOT = path.join(os.tmpdir(), 'claudex-projects-dir-tests');

describe('getProjectsDir', () => {
  let priorEnv: string | undefined;
  let priorStderrWrite: typeof process.stderr.write;
  let stderrChunks: string[] = [];

  beforeEach(() => {
    priorEnv = process.env[CLAUDEX_PROJECTS_DIR_ENV];
    stderrChunks = [];
    priorStderrWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr writes from the helper without polluting test output.
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      if (s.startsWith('[projects-dir]')) {
        stderrChunks.push(s);
        return true;
      }
      return priorStderrWrite(chunk as never);
    }) as typeof process.stderr.write;

    try {
      fs.mkdirSync(TMP_ROOT, { recursive: true });
    } catch {
      /* best-effort */
    }
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env[CLAUDEX_PROJECTS_DIR_ENV];
    else process.env[CLAUDEX_PROJECTS_DIR_ENV] = priorEnv;
    process.stderr.write = priorStderrWrite;
  });

  it('returns the env-var value when set to an absolute path', () => {
    const tmp = path.join(TMP_ROOT, `abs-${Date.now()}`);
    process.env[CLAUDEX_PROJECTS_DIR_ENV] = tmp;

    const result = getProjectsDir();

    expect(result).toBe(path.resolve(tmp));
    expect(fs.existsSync(result)).toBe(true);

    try {
      fs.rmdirSync(result);
    } catch {
      /* best-effort */
    }
  });

  it('resolves a relative env-var value to an absolute path', () => {
    const rel = path.join(
      'tmp-projects-rel',
      `claudex-${Date.now().toString(36)}`,
    );
    process.env[CLAUDEX_PROJECTS_DIR_ENV] = rel;

    const result = getProjectsDir();

    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve(rel));

    try {
      fs.rmdirSync(result);
      fs.rmdirSync(path.dirname(result));
    } catch {
      /* best-effort */
    }
  });

  it('returns ~/Projects when the env var is unset', () => {
    delete process.env[CLAUDEX_PROJECTS_DIR_ENV];

    const result = getProjectsDir();

    expect(result).toBe(path.join(os.homedir(), 'Projects'));
  });

  it('treats an empty-string env var as unset', () => {
    process.env[CLAUDEX_PROJECTS_DIR_ENV] = '';

    const result = getProjectsDir();

    expect(result).toBe(path.join(os.homedir(), 'Projects'));
  });

  it('does not throw when mkdir fails — returns the resolved path anyway', () => {
    // Use a path under a non-existent drive on Windows or a forbidden parent
    // on POSIX. Cross-platform "guaranteed to fail mkdirSync recursive=true":
    // a path containing a NUL byte triggers ERR_INVALID_ARG_VALUE / EINVAL on
    // every platform and bypasses recursive mkdir.
    const bogus =
      process.platform === 'win32'
        ? 'Z:\\__claudex_no_such_drive__\\projects'
        : '/proc/__claudex_unwritable__/projects';
    process.env[CLAUDEX_PROJECTS_DIR_ENV] = bogus;

    let result: string | undefined;
    expect(() => {
      result = getProjectsDir();
    }).not.toThrow();

    expect(result).toBe(path.resolve(bogus));
    // Helper logged the failure (best-effort visibility).
    expect(stderrChunks.length).toBeGreaterThan(0);
    expect(stderrChunks.some((s) => s.includes('mkdir failed'))).toBe(true);
  });
});
