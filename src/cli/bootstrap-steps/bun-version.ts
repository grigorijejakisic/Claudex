/**
 * Bootstrap step: verify Bun >= MIN_BUN_VERSION.
 *
 * Pure read; idempotent. Returns ok:false (exit 1) if Bun is missing or older.
 */

import { execFileSync } from 'child_process';
import type { StepResult } from './types.js';

export const MIN_BUN_VERSION = '1.3.0';

export interface BunVersionStepOptions {
  execFn?: typeof execFileSync;
  minVersion?: string;
}

export async function checkBunVersion(
  opts: BunVersionStepOptions = {},
): Promise<StepResult> {
  const exec = opts.execFn ?? execFileSync;
  const min = opts.minVersion ?? MIN_BUN_VERSION;

  let raw: string;
  try {
    raw = exec('bun', ['--version'], { encoding: 'utf-8', timeout: 5000 }).toString().trim();
  } catch {
    return {
      ok: false,
      message: `Bun not found on PATH. Install: https://bun.sh`,
    };
  }

  const parsed = parseSemver(raw);
  if (!parsed) {
    return {
      ok: false,
      message: `Bun reported version "${raw}" — could not parse. Need >= ${min}.`,
    };
  }

  if (semverGte(parsed, parseSemver(min)!)) {
    return { ok: true, message: `Bun ${raw} (>= ${min})` };
  }

  return {
    ok: false,
    message: `Bun ${raw} too old. Need >= ${min}. Upgrade: https://bun.sh`,
  };
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(s: string): Semver | null {
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function semverGte(a: Semver, b: Semver): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}
