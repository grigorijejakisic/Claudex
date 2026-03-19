/**
 * Runtime path helpers using os.homedir() + path.join().
 * All functions are defensive non-throwing and cross-platform.
 */

import * as path from 'path';
import * as os from 'os';

const CLAUDEX_DIR = '.claudex';

/** Returns ~/.claudex/ directory path. Never throws. */
export function getClaudexHome(): string {
  try {
    return path.normalize(path.join(os.homedir(), CLAUDEX_DIR));
  } catch {
    // Non-throwing: no DB access — os.homedir() failed, fall back to relative path
    return path.normalize(path.join('.', CLAUDEX_DIR));
  }
}

/** Returns ~/.claudex/db/claudex.db path. Respects CLAUDEX_DB_PATH env var. Never throws. */
export function getDbPath(): string {
  try {
    // Allow override for smoke tests, CI, and isolated environments
    const envPath = process.env.CLAUDEX_DB_PATH;
    if (envPath) return path.normalize(envPath);
    return path.normalize(path.join(getClaudexHome(), 'db', 'claudex.db'));
  } catch {
    return path.normalize(path.join('.', CLAUDEX_DIR, 'db', 'claudex.db'));
  }
}

/** Returns ~/.claudex/config.json path. Never throws. */
export function getConfigPath(): string {
  try {
    return path.normalize(path.join(getClaudexHome(), 'config.json'));
  } catch {
    // Non-throwing: no DB access — fall back to relative path
    return path.normalize(path.join('.', CLAUDEX_DIR, 'config.json'));
  }
}

/** Returns ~/.claudex/projects.json path. Never throws. */
export function getProjectsJsonPath(): string {
  try {
    return path.normalize(path.join(getClaudexHome(), 'projects.json'));
  } catch {
    // Non-throwing: no DB access — fall back to relative path
    return path.normalize(path.join('.', CLAUDEX_DIR, 'projects.json'));
  }
}

/** Returns ~/.claudex/identity/ directory path. Never throws. */
export function getIdentityDir(): string {
  try {
    return path.normalize(path.join(getClaudexHome(), 'identity'));
  } catch {
    // Non-throwing: no DB access — fall back to relative path
    return path.normalize(path.join('.', CLAUDEX_DIR, 'identity'));
  }
}

/** Returns {projectDir}/context/checkpoints/ directory path. Never throws. */
export function getCheckpointsDir(projectDir: string): string {
  try {
    return path.normalize(path.join(projectDir, 'context', 'checkpoints'));
  } catch {
    // Non-throwing: no DB access — path.join failed (invalid input), fall back to relative path
    return path.normalize(path.join('.', 'context', 'checkpoints'));
  }
}

/** Returns {projectDir}/context/sessions/ directory path. Never throws. */
export function getSessionsDir(projectDir: string): string {
  try {
    return path.normalize(path.join(projectDir, 'context', 'sessions'));
  } catch {
    // Non-throwing: no DB access — fall back to relative path
    return path.normalize(path.join('.', 'context', 'sessions'));
  }
}

/** Returns {projectDir}/context/handoffs/ directory path. Never throws. */
export function getHandoffsDir(projectDir: string): string {
  try {
    return path.normalize(path.join(projectDir, 'context', 'handoffs'));
  } catch {
    // Non-throwing: no DB access — fall back to relative path
    return path.normalize(path.join('.', 'context', 'handoffs'));
  }
}
