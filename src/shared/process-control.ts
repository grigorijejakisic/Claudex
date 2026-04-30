/**
 * Cross-platform process termination.
 *
 * Windows uses `taskkill /PID <pid> [/F]`; Unix uses `process.kill(pid, signal)`.
 * "Process already dead" is treated as success — the goal is "ensure this PID
 * is no longer running"; if it's already gone, that's fine.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function terminateProcess(
  pid: number,
  options?: { force?: boolean },
): Promise<void> {
  const force = options?.force === true;

  if (process.platform === 'win32') {
    const args = ['/PID', String(pid)];
    if (force) args.push('/F');
    try {
      await execFileAsync('taskkill', args);
    } catch (err: unknown) {
      const e = err as { stderr?: string; code?: number | string; message?: string };
      const stderr = (e.stderr ?? '').toLowerCase();
      const message = (e.message ?? '').toLowerCase();
      if (
        stderr.includes('could not be found') ||
        stderr.includes('not found') ||
        message.includes('not found') ||
        e.code === 128
      ) {
        return;
      }
      throw err;
    }
  } else {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'ESRCH') return;
      throw err;
    }
  }
}
