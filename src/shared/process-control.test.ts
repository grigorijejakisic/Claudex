import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '', stderr: '' });
    }),
  };
});

import * as childProcess from 'child_process';
import { terminateProcess } from './process-control.js';

describe('terminateProcess', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalKill: typeof process.kill;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalKill = process.kill;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    process.kill = originalKill;
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  describe('Windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('uses taskkill /F when force=true', async () => {
      await terminateProcess(1234, { force: true });
      expect(childProcess.execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '1234', '/F'],
        expect.any(Function),
      );
    });

    it('uses taskkill without /F when force is absent', async () => {
      await terminateProcess(1234);
      expect(childProcess.execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '1234'],
        expect.any(Function),
      );
    });

    it('swallows "process not found" errors', async () => {
      vi.mocked(childProcess.execFile).mockImplementationOnce(
        ((_cmd: string, _args: string[], cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
          cb({ stderr: 'ERROR: The process "1234" not found.' }, { stdout: '', stderr: '' });
        }) as unknown as typeof childProcess.execFile,
      );
      await expect(terminateProcess(1234, { force: true })).resolves.toBeUndefined();
    });

    it('rethrows unrelated errors', async () => {
      vi.mocked(childProcess.execFile).mockImplementationOnce(
        ((_cmd: string, _args: string[], cb: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
          cb({ stderr: 'ERROR: Access denied.', code: 1, message: 'access denied' }, { stdout: '', stderr: '' });
        }) as unknown as typeof childProcess.execFile,
      );
      await expect(terminateProcess(1234, { force: true })).rejects.toBeDefined();
    });
  });

  describe('Unix', () => {
    beforeEach(() => setPlatform('linux'));

    it('sends SIGKILL when force=true', async () => {
      const killSpy = vi.fn();
      process.kill = killSpy as unknown as typeof process.kill;
      await terminateProcess(1234, { force: true });
      expect(killSpy).toHaveBeenCalledWith(1234, 'SIGKILL');
    });

    it('sends SIGTERM when force is absent', async () => {
      const killSpy = vi.fn();
      process.kill = killSpy as unknown as typeof process.kill;
      await terminateProcess(1234);
      expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
    });

    it('swallows ESRCH errors', async () => {
      const killSpy = vi.fn(() => {
        const err = new Error('No such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      });
      process.kill = killSpy as unknown as typeof process.kill;
      await expect(terminateProcess(1234, { force: true })).resolves.toBeUndefined();
    });

    it('rethrows non-ESRCH errors', async () => {
      const killSpy = vi.fn(() => {
        const err = new Error('EPERM: not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });
      process.kill = killSpy as unknown as typeof process.kill;
      await expect(terminateProcess(1234, { force: true })).rejects.toBeDefined();
    });
  });
});
