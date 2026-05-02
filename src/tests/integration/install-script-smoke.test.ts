/**
 * install.sh / install.bat integrity tests — static parse of the two
 * first-touch install scripts at the repo root. They MUST:
 *   1. Exist
 *   2. Pre-flight `bun` presence (fail fast with install link)
 *   3. Invoke `bun install --frozen-lockfile`, `bun run build`, `bun run setup`
 *      in that order
 *
 * Windows install.bat additionally MUST use `call bun ...` (not bare `bun ...`)
 * because `bun` ships as `bun.cmd` on Windows; without `call`, control transfers
 * and never returns — breaking the chain after the first command.
 *
 * Catches accidental damage to the install entry points (e.g., reordered steps,
 * missing `--frozen-lockfile`, dropped `call`).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const INSTALL_BAT = path.join(REPO_ROOT, 'install.bat');

describe('install scripts', () => {
  describe('install.sh (POSIX)', () => {
    it('exists at repo root', () => {
      expect(fs.existsSync(INSTALL_SH)).toBe(true);
    });

    it('uses portable shebang', () => {
      const text = fs.readFileSync(INSTALL_SH, 'utf-8');
      // /usr/bin/env bash is portable across macOS, Linux, Git Bash.
      expect(text.split('\n')[0]).toMatch(/^#!\/usr\/bin\/env bash/);
    });

    it('pre-flights bun presence with install link on miss', () => {
      const text = fs.readFileSync(INSTALL_SH, 'utf-8');
      expect(text).toMatch(/command -v bun/);
      expect(text).toMatch(/https:\/\/bun\.sh/);
      expect(text).toMatch(/exit 1/);
    });

    it('invokes bun install --frozen-lockfile, bun run build, bun run setup in order', () => {
      const text = fs.readFileSync(INSTALL_SH, 'utf-8');
      // Multiline-anchor matches actual commands, NOT the header comment that
      // also mentions `bun run setup` (would match earlier and break ordering check).
      const installIdx = text.search(/^bun install --frozen-lockfile\b/m);
      const buildIdx = text.search(/^bun run build\b/m);
      const setupIdx = text.search(/^bun run setup\b/m);

      expect(installIdx, 'missing `bun install --frozen-lockfile` command line').toBeGreaterThan(0);
      expect(buildIdx, 'missing `bun run build` command line').toBeGreaterThan(installIdx);
      expect(setupIdx, 'missing `bun run setup` command line').toBeGreaterThan(buildIdx);
    });

    it('uses `set -e` for fail-fast', () => {
      const text = fs.readFileSync(INSTALL_SH, 'utf-8');
      expect(text).toMatch(/^set -e\b/m);
    });
  });

  describe('install.bat (Windows)', () => {
    it('exists at repo root', () => {
      expect(fs.existsSync(INSTALL_BAT)).toBe(true);
    });

    it('uses @echo off for clean output', () => {
      const text = fs.readFileSync(INSTALL_BAT, 'utf-8');
      expect(text.split('\n')[0]).toMatch(/^@echo off/);
    });

    it('pre-flights bun presence with install link on miss', () => {
      const text = fs.readFileSync(INSTALL_BAT, 'utf-8');
      expect(text).toMatch(/where bun/);
      expect(text).toMatch(/https:\/\/bun\.sh/);
      expect(text).toMatch(/exit \/b 1/);
    });

    it('uses `call bun` not bare `bun` (Windows bun.cmd transfer-of-control trap)', () => {
      const text = fs.readFileSync(INSTALL_BAT, 'utf-8');

      // Every bun invocation must be prefixed with `call`.
      const lines = text.split('\n');
      for (const [i, line] of lines.entries()) {
        const trimmed = line.trim();
        if (/^bun\b/.test(trimmed)) {
          throw new Error(
            `install.bat line ${i + 1}: bare \`bun\` invocation (\`${trimmed}\`); ` +
            `must use \`call bun\` because bun.cmd transfers control without returning`
          );
        }
      }

      // And we must see at least 3 `call bun ...` invocations (install/build/setup).
      const callBunCount = (text.match(/^call bun /gm) ?? []).length;
      expect(callBunCount, 'expected 3+ `call bun ...` invocations').toBeGreaterThanOrEqual(3);
    });

    it('invokes bun install --frozen-lockfile, bun run build, bun run setup in order', () => {
      const text = fs.readFileSync(INSTALL_BAT, 'utf-8');
      // Multiline-anchor matches actual commands, not REM comment lines.
      const installIdx = text.search(/^call bun install --frozen-lockfile\b/m);
      const buildIdx = text.search(/^call bun run build\b/m);
      const setupIdx = text.search(/^call bun run setup\b/m);

      expect(installIdx, 'missing `call bun install --frozen-lockfile` command line').toBeGreaterThan(0);
      expect(buildIdx, 'missing `call bun run build` command line').toBeGreaterThan(installIdx);
      expect(setupIdx, 'missing `call bun run setup` command line').toBeGreaterThan(buildIdx);
    });

    it('checks errorlevel after each step for fail-fast', () => {
      const text = fs.readFileSync(INSTALL_BAT, 'utf-8');
      // At least 3 errorlevel checks (one per call bun step).
      const errLevelCount = (text.match(/if errorlevel 1 exit \/b 1/g) ?? []).length;
      expect(errLevelCount, 'expected 3+ errorlevel checks').toBeGreaterThanOrEqual(3);
    });
  });
});
