import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeCheckHooks } from '../../diagnostics/check-hooks.js';
import { EXPECTED_HOOK_NAMES } from '../../cli/hook-registry.js';

let tmpDir = '';

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

function writeSettings(settings: object): string {
  const p = tmpFile('settings.json');
  fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
  return p;
}

function buildAllHooks(): Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> {
  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};
  for (const name of EXPECTED_HOOK_NAMES) {
    hooks[name] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: `node 'C:\\path\\to\\claudex\\dist\\adapters\\cc-hooks\\${name}.cjs'` }],
      },
    ];
  }
  return hooks;
}

describe('checkHooks', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-doctor-hooks-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('passes when all expected hooks are registered as Claudex commands', async () => {
    const settingsPath = writeSettings({ hooks: buildAllHooks() });
    const result = await makeCheckHooks({ settingsPath })();
    expect(result.status).toBe('pass');
    expect(result.detail).toBe(`${EXPECTED_HOOK_NAMES.length} of ${EXPECTED_HOOK_NAMES.length} registered`);
  });

  it('fails when settings.json is missing', async () => {
    const settingsPath = path.join(tmpDir, 'does-not-exist.json');
    const result = await makeCheckHooks({ settingsPath })();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not found');
    expect(result.remediation).toContain("'bun run setup'");
  });

  it('fails when only a subset of hooks are registered (truncates missing list)', async () => {
    const all = buildAllHooks();
    const partial: typeof all = {};
    for (const name of EXPECTED_HOOK_NAMES.slice(0, 5)) partial[name] = all[name];
    const settingsPath = writeSettings({ hooks: partial });
    const result = await makeCheckHooks({ settingsPath })();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`5 of ${EXPECTED_HOOK_NAMES.length}`);
    expect(result.detail).toContain('missing:');
    expect(result.detail).toContain('+');
    expect(result.remediation).toContain("'bun run setup'");
  });

  it('fails when settings.json is malformed', async () => {
    const settingsPath = tmpFile('settings.json');
    fs.writeFileSync(settingsPath, 'not json {{{', 'utf-8');
    const result = await makeCheckHooks({ settingsPath })();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('malformed');
  });

  it('fails when hook entries exist but commands do not reference claudex', async () => {
    const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};
    for (const name of EXPECTED_HOOK_NAMES) {
      hooks[name] = [{ matcher: '', hooks: [{ type: 'command', command: 'node /elsewhere/some-other-hook.cjs' }] }];
    }
    const settingsPath = writeSettings({ hooks });
    const result = await makeCheckHooks({ settingsPath })();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`0 of ${EXPECTED_HOOK_NAMES.length}`);
  });
});
