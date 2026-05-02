import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeCheckAngel } from '../../diagnostics/check-angel.js';

let tmpDir = '';

function tmpPid(): string {
  return path.join(tmpDir, 'angel.pid');
}

describe('checkAngel', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-doctor-angel-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('passes when PID file points to a live process and mtime is fresh', async () => {
    const pidPath = tmpPid();
    fs.writeFileSync(pidPath, String(process.pid), 'utf-8');
    const check = makeCheckAngel({
      pidPath,
      killFn: () => { /* alive */ },
    });
    const result = await check();
    expect(result.status).toBe('pass');
    expect(result.detail).toContain(`PID ${process.pid}`);
    expect(result.detail).toContain('fresh');
  });

  it('fails when PID file is missing', async () => {
    const check = makeCheckAngel({ pidPath: path.join(tmpDir, 'missing.pid') });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toBe('no PID file');
    expect(result.remediation).toContain('Angel');
  });

  it('fails when PID file content is non-numeric', async () => {
    const pidPath = tmpPid();
    fs.writeFileSync(pidPath, 'not-a-pid\n', 'utf-8');
    const check = makeCheckAngel({ pidPath });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('non-numeric');
  });

  it('fails when process.kill throws (stale PID)', async () => {
    const pidPath = tmpPid();
    fs.writeFileSync(pidPath, '999999', 'utf-8');
    const check = makeCheckAngel({
      pidPath,
      killFn: () => { throw new Error('ESRCH'); },
    });
    const result = await check();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('stale PID');
  });

  it('warns when alive but heartbeat (mtime) is stale', async () => {
    const pidPath = tmpPid();
    fs.writeFileSync(pidPath, String(process.pid), 'utf-8');
    const ninetySecondsAgo = new Date(Date.now() - 90_000);
    fs.utimesSync(pidPath, ninetySecondsAgo, ninetySecondsAgo);

    const check = makeCheckAngel({
      pidPath,
      killFn: () => { /* alive */ },
    });
    const result = await check();
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('>=60s');
    expect(result.remediation).toContain('consolidation');
  });
});
