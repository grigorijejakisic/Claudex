/**
 * DIAG-02: Bun runtime version check.
 *
 * Reads `process.versions.bun` directly. Doctor must be invoked via
 * `bun run doctor` for this to be populated; that's the documented entry.
 * If invoked under raw Node, `process.versions.bun` is undefined and we
 * report fail — actionable since the README specifies `bun run doctor`.
 */

import type { CheckFn } from './types.js';

export const MIN_BUN_MAJOR = 1;
export const MIN_BUN_MINOR = 3;

export const checkBun: CheckFn = async () => {
  const bunVersion = process.versions.bun;

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
