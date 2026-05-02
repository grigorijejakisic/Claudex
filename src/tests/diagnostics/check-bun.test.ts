import { describe, it, expect, afterEach } from 'vitest';
import { checkBun } from '../../diagnostics/check-bun.js';

const ORIGINAL_BUN = process.versions.bun;

function setBunVersion(value: string | undefined): void {
  if (value === undefined) {
    delete (process.versions as unknown as Record<string, unknown>).bun;
  } else {
    Object.defineProperty(process.versions, 'bun', { value, configurable: true });
  }
}

describe('checkBun', () => {
  afterEach(() => {
    setBunVersion(ORIGINAL_BUN);
  });

  it('passes for Bun >=1.3', async () => {
    setBunVersion('1.3.5');
    const result = await checkBun();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('Bun 1.3.5');
    expect(result.remediation).toBeUndefined();
  });

  it('fails when process.versions.bun is undefined', async () => {
    setBunVersion(undefined);
    const result = await checkBun();
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('Bun not found in PATH');
    expect(result.remediation).toContain('Install Bun');
  });

  it('fails when Bun version is too old', async () => {
    setBunVersion('1.2.0');
    const result = await checkBun();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Bun 1.2.0');
    expect(result.detail).toContain('>=1.3');
    expect(result.remediation).toContain('Install Bun');
  });

  it('passes for major-version newer than required', async () => {
    setBunVersion('2.0.0');
    const result = await checkBun();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe('Bun 2.0.0');
  });
});
