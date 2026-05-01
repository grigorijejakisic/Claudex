/**
 * Single source of truth for the configurable projects directory used by
 * scope-detector, content-router, the MCP server's instructions text, and
 * assembly sections.
 *
 * Resolution order:
 *   1. process.env.CLAUDEX_PROJECTS_DIR (resolved against cwd if relative)
 *   2. path.join(os.homedir(), 'Projects')  -- cross-platform default
 *
 * Side-effect: best-effort `mkdir -p` on the resolved path. Never throws —
 * if the directory cannot be created, the resolved path is still returned
 * and the caller decides what to do. This is required because callers like
 * scope-detector and content-router run in hot paths with their own
 * try/catch + fallback semantics.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export const CLAUDEX_PROJECTS_DIR_ENV = 'CLAUDEX_PROJECTS_DIR';

export function getProjectsDir(): string {
  const fromEnv = process.env[CLAUDEX_PROJECTS_DIR_ENV];
  const resolved =
    fromEnv && fromEnv.length > 0
      ? path.resolve(fromEnv)
      : path.join(os.homedir(), 'Projects');

  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    // Best-effort: log and continue. Callers must not depend on existence.
    process.stderr.write(
      `[projects-dir] mkdir failed for ${resolved}: ${(err as Error).message}\n`,
    );
  }

  return resolved;
}
