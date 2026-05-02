import { describe, it, expect, vi } from 'vitest';
import type { SpawnSyncReturns } from 'child_process';
import { makeCheckBun } from '../../diagnostics/check-bun.js';

function spawnOk(version: string) {
  return vi.fn(() => ({
    pid: 0,
    output: [],
    stdout: `${version}\n`,
    stderr: '',
    status: 0,
    signal: null,
  } as unknown as SpawnSyncReturns<string>));
}

function spawnMissing() {
  return vi.fn(() => {
    throw new Error('command not found: bun');
  });
}

describe('checkBun', () => {
  it('passes when process.versions.bun reports >=1.3', async () => {
    const check = makeCheckBun({ runtimeVersion: '1.3.5' });
    const result = await check();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('Bun 1.3.5');
    expect(result.remediation).toBeUndefined();
  });

  it('falls back to spawn(bun --version) when runtime is undefined', async () => {
    const check = makeCheckBun({
      runtimeVersion: undefined,
      skipRuntime: true,
      spawnFn: spawnOk('1.3.6') as unknown as typeof import('child_process').spawnSync,
    });
    const result = await check();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('Bun 1.3.6');
  });

  it('fails when neither runtime nor spawn yields a version', async () => {
    const check = makeCheckBun({
      skipRuntime: true,
      spawnFn: spawnMissing() as unknown as typeof import('child_process').spawnSync,
    });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('Bun not found in PATH');
    expect(result.remediation).toContain('Install Bun');
  });

  it('fails when Bun version is too old', async () => {
    const check = makeCheckBun({ runtimeVersion: '1.2.0' });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Bun 1.2.0');
    expect(result.detail).toContain('>=1.3');
    expect(result.remediation).toContain('Install Bun');
  });

  it('passes for major-version newer than required', async () => {
    const check = makeCheckBun({ runtimeVersion: '2.0.0' });
    const result = await check();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('Bun 2.0.0');
  });
});
