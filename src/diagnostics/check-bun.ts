/**
 * DIAG-02: Bun runtime version check.
 *
 * Detection priority:
 *   1. `process.versions.bun` (set when running under Bun directly)
 *   2. `bun --version` subprocess (when invoked under Node — the default
 *      package.json `doctor` script is `node dist/cli/doctor.cjs`)
 *
 * Either source must report >=1.3.
 */

import { spawnSync } from 'child_process';
import type { CheckFn } from './types.js';

export const MIN_BUN_MAJOR = 1;
export const MIN_BUN_MINOR = 3;

export interface CheckBunOptions {
  spawnFn?: typeof spawnSync;
  /** Override `process.versions.bun` for tests. */
  runtimeVersion?: string;
  /** When true, skip the runtime probe and only use spawnFn. */
  skipRuntime?: boolean;
}

function detectBunVersion(opts: CheckBunOptions): string | null {
  if (!opts.skipRuntime) {
    const fromRuntime = opts.runtimeVersion ?? process.versions.bun;
    if (typeof fromRuntime === 'string' && fromRuntime.length > 0) {
      return fromRuntime;
    }
  }

  const spawnFn = opts.spawnFn ?? spawnSync;
  try {
    const result = spawnFn('bun', ['--version'], {
      encoding: 'utf-8',
      timeout: 2000,
      shell: true,
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const version = result.stdout.trim();
      if (version.length > 0) return version;
    }
  } catch {
    // fall through — bun not on PATH
  }
  return null;
}

export function makeCheckBun(opts: CheckBunOptions = {}): CheckFn {
  return async () => {
    const bunVersion = detectBunVersion(opts);

    if (!bunVersion) {
      return {
        name: 'Bun version',
        status: 'fail',
        detail: 'Bun not found in PATH',
        remediation: `Install Bun >=${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}: https://bun.sh`,
      };
    }

    const [majorStr, minorStr] = bunVersion.split('.');
    const major = parseInt(majorStr, 10);
    const minor = parseInt(minorStr, 10);

    if (
      isNaN(major) ||
      isNaN(minor) ||
      major < MIN_BUN_MAJOR ||
      (major === MIN_BUN_MAJOR && minor < MIN_BUN_MINOR)
    ) {
      return {
        name: 'Bun version',
        status: 'fail',
        detail: `Bun ${bunVersion} (need >=${MIN_BUN_MAJOR}.${MIN_BUN_MINOR})`,
        remediation: `Install Bun >=${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}: https://bun.sh`,
      };
    }

    return {
      name: 'Bun version',
      status: 'pass',
      detail: `Bun ${bunVersion}`,
    };
  };
}

export const checkBun: CheckFn = makeCheckBun();
