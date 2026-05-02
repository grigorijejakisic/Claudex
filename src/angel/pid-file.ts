/**
 * Angel PID-file path resolver.
 *
 * Lives in its own module so that the Angel runtime (`index.ts`,
 * `heartbeat.ts`) and the Phase 15 doctor diagnostic (`check-angel.ts`)
 * can all import it without a circular dependency.
 *
 * The file mtime doubles as DIAG-07's heartbeat-freshness signal:
 * `heartbeatTick` touches it on each successful tick (`fs.utimesSync`),
 * and doctor reads it via `fs.statSync`. No telemetry-schema change.
 */

import * as path from 'path';
import { getClaudexHome } from '../shared/paths.js';

export function getPidFilePath(): string {
  return path.join(getClaudexHome(), 'angel.pid');
}
