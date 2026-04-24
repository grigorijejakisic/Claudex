/**
 * Plan 04-06-01 — Angel log capture + rotation unit tests.
 *
 * Covers:
 *   - openAngelLogForAppend returns a writable fd under ~/.claudex/logs/angel.log
 *   - rotation triggers when the file exceeds ROTATE_AT_BYTES and preserves
 *     the last-1 generation as angel.log.1
 *   - a second rotation clobbers any previous angel.log.1
 *   - the helper is non-throwing when the log directory cannot be created
 *     (returns { fd: null, reason })
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  openAngelLogForAppend,
  getAngelLogPath,
  getAngelLogRotatedPath,
  ROTATE_AT_BYTES,
} from '../../../adapters/cc-hooks/angel-log.js';

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'angel-log-test-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe('angel-log — plan 04-06-01', () => {
  it('opens ~/.claudex/logs/angel.log on first run and returns an appendable fd', () => {
    const { fd, reason } = openAngelLogForAppend();
    expect(reason).toBeNull();
    expect(fd).not.toBeNull();
    try {
      fs.writeSync(fd!, 'hello\n');
      fs.closeSync(fd!);
    } catch (e) {
      // Clean up on assertion failure too.
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } }
      throw e;
    }

    const body = fs.readFileSync(getAngelLogPath(), 'utf-8');
    expect(body).toContain('hello');
  });

  it('rotates to angel.log.1 when existing log exceeds ROTATE_AT_BYTES', () => {
    const logPath = getAngelLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Seed an oversized log with a sentinel we can detect post-rotation.
    fs.writeFileSync(logPath, Buffer.concat([
      Buffer.from('OLD-CONTENT-START\n'),
      Buffer.alloc(ROTATE_AT_BYTES, 0x61),
    ]));
    expect(fs.statSync(logPath).size).toBeGreaterThanOrEqual(ROTATE_AT_BYTES);

    const { fd, reason } = openAngelLogForAppend();
    expect(reason).toBeNull();
    expect(fd).not.toBeNull();
    try { fs.writeSync(fd!, 'new-run\n'); } finally { fs.closeSync(fd!); }

    const rotated = getAngelLogRotatedPath();
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.readFileSync(rotated, 'utf-8')).toContain('OLD-CONTENT-START');

    // Fresh log starts after rotation — size equals just what we wrote.
    const fresh = fs.readFileSync(logPath, 'utf-8');
    expect(fresh).toBe('new-run\n');
  });

  it('second rotation clobbers the previous angel.log.1 (one generation)', () => {
    const logPath = getAngelLogPath();
    const rotated = getAngelLogRotatedPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // Pretend a previous rotation already produced a .1 with distinct content.
    fs.writeFileSync(rotated, 'FIRST-GEN\n');
    // And that the current log is oversized and contains GEN-2 content.
    fs.writeFileSync(logPath, Buffer.concat([
      Buffer.from('SECOND-GEN\n'),
      Buffer.alloc(ROTATE_AT_BYTES, 0x62),
    ]));

    const { fd } = openAngelLogForAppend();
    expect(fd).not.toBeNull();
    try { fs.writeSync(fd!, 'THIRD-GEN\n'); } finally { fs.closeSync(fd!); }

    // .1 must now carry SECOND-GEN, not FIRST-GEN — one-generation rotation.
    const rotatedBody = fs.readFileSync(rotated, 'utf-8');
    expect(rotatedBody.startsWith('SECOND-GEN')).toBe(true);
    expect(rotatedBody).not.toContain('FIRST-GEN');
  });

  it('does not rotate when the existing log is under the threshold', () => {
    const logPath = getAngelLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'small-existing\n');

    const { fd } = openAngelLogForAppend();
    expect(fd).not.toBeNull();
    try { fs.writeSync(fd!, 'appended\n'); } finally { fs.closeSync(fd!); }

    // No rotated file should exist (no threshold crossed).
    expect(fs.existsSync(getAngelLogRotatedPath())).toBe(false);
    const body = fs.readFileSync(logPath, 'utf-8');
    expect(body).toBe('small-existing\nappended\n');
  });

  it('returns { fd: null, reason } when the log path cannot be opened', () => {
    // On Windows we cannot easily force openSync to fail without OS-level
    // tricks, but we can force it on both platforms by creating a *file* at
    // the location where the logs directory is supposed to live — mkdirSync
    // then throws EEXIST with a non-directory at that path.
    const logsPath = path.join(tmpHome, '.claudex', 'logs');
    fs.mkdirSync(path.dirname(logsPath), { recursive: true });
    fs.writeFileSync(logsPath, 'not-a-directory');

    const { fd, reason } = openAngelLogForAppend();
    expect(fd).toBeNull();
    expect(reason).not.toBeNull();
    expect(reason!.length).toBeGreaterThan(0);
  });
});
