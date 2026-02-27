import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { parseCliArgs } from '../../src/gsd/phase-transition-cli.js';

const CLI_DIST_PATH = path.join(process.cwd(), 'dist', 'phase-transition-cli.mjs');
const HAS_DIST_CLI = fs.existsSync(CLI_DIST_PATH);

describe('parseCliArgs', () => {
  it('1. parses valid phase-start arguments', () => {
    const result = parseCliArgs([
      '--event=phase-start',
      '--phase=6',
      '--project-dir=/tmp/test',
    ]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.event).toBe('phase-start');
    expect(result.phaseNumber).toBe(6);
    expect(result.projectDir).toBe('/tmp/test');
    expect(result.projectName).toBe('test');
  });

  it('2. parses valid plan-complete arguments', () => {
    const result = parseCliArgs([
      '--event=plan-complete',
      '--phase=6',
      '--plan=2',
      '--project-dir=/tmp/test',
      '--session-id=abc',
    ]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.event).toBe('plan-complete');
    expect(result.phaseNumber).toBe(6);
    expect(result.planNumber).toBe(2);
    expect(result.sessionId).toBe('abc');
  });

  it('3. returns error for missing --event', () => {
    const result = parseCliArgs(['--phase=6', '--project-dir=/tmp/test']);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('--event');
    }
  });

  it('4. returns error for invalid --event', () => {
    const result = parseCliArgs([
      '--event=invalid',
      '--phase=6',
      '--project-dir=/tmp/test',
    ]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Invalid --event value');
    }
  });

  it('5. returns error for missing --phase', () => {
    const result = parseCliArgs([
      '--event=phase-start',
      '--project-dir=/tmp/test',
    ]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('--phase');
    }
  });

  it('6. returns error for plan-complete without --plan', () => {
    const result = parseCliArgs([
      '--event=plan-complete',
      '--phase=6',
      '--project-dir=/tmp/test',
      '--session-id=abc',
    ]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('--plan');
    }
  });

  it('7. returns error for plan-complete without --session-id', () => {
    const result = parseCliArgs([
      '--event=plan-complete',
      '--phase=6',
      '--project-dir=/tmp/test',
      '--plan=2',
    ]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('--session-id');
    }
  });

  it('8. defaults project-name to basename of project-dir', () => {
    const result = parseCliArgs([
      '--event=phase-end',
      '--phase=6',
      '--project-dir=/home/user/my-project',
    ]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.projectName).toBe('my-project');
  });

  it('9. uses explicit --project-name when provided', () => {
    const result = parseCliArgs([
      '--event=phase-end',
      '--phase=6',
      '--project-dir=/home/user/my-project',
      '--project-name=custom-name',
    ]);

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.projectName).toBe('custom-name');
  });

  it('10. returns error for invalid argument format', () => {
    const result = parseCliArgs([
      '--event=phase-start',
      '--phase=6',
      '--project-dir',
    ]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Invalid argument format');
    }
  });
});

describe.skipIf(!HAS_DIST_CLI)('phase-transition CLI end-to-end', () => {
  it('11. exits non-zero when required args are missing', () => {
    let error: unknown;
    try {
      execSync(`node "${CLI_DIST_PATH}"`, { stdio: 'pipe' });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    const message = String(error);
    expect(message).toContain('Command failed');
  });

  it('12. runs phase-start and prints success output with valid args', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-transition-cli-'));

    try {
      const output = execSync(
        `node "${CLI_DIST_PATH}" --event=phase-start --phase=6 --project-dir="${tmpDir}"`,
        { stdio: 'pipe', encoding: 'utf-8' },
      );

      expect(output).toContain('[phase-transition] phase-start:');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
