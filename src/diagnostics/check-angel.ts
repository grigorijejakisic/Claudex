/**
 * DIAG-07: Angel process liveness + heartbeat freshness.
 *
 * Three steps:
 *   1. PID file exists at ~/.claudex/angel.pid
 *   2. process.kill(pid, 0) succeeds (process is alive)
 *   3. mtime of the PID file is within HEARTBEAT_FRESHNESS_MS
 *
 * Heartbeat freshness uses the PID file mtime (touched by heartbeatTick on
 * each successful tick) to avoid a telemetry schema migration. Stale
 * heartbeat is `warn`, not `fail` — Angel may legitimately be in a long
 * consolidation cycle.
 */

import * as fs from 'fs';
import type { CheckFn } from './types.js';
import { getPidFilePath } from '../angel/pid-file.js';

const HEARTBEAT_FRESHNESS_MS = 60_000;

export interface CheckAngelOptions {
  pidPath?: string;
  freshnessMs?: number;
  killFn?: (pid: number, signal: number) => void;
  now?: () => number;
}

export function makeCheckAngel(opts: CheckAngelOptions = {}): CheckFn {
  const freshnessMs = opts.freshnessMs ?? HEARTBEAT_FRESHNESS_MS;
  const killFn =
    opts.killFn ??
    ((pid: number, signal: number) => {
      process.kill(pid, signal);
    });
  const now = opts.now ?? Date.now;

  return async () => {
    const pidPath = opts.pidPath ?? getPidFilePath();

    if (!fs.existsSync(pidPath)) {
      return {
        name: 'Angel',
        status: 'fail',
        detail: 'no PID file',
        remediation:
          "Angel not running. Open Claude Code (auto-spawns Angel via session-start hook) or run 'node dist/angel/index.cjs'.",
      };
    }

    const raw = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) {
      return {
        name: 'Angel',
        status: 'fail',
        detail: `PID file contains non-numeric value: '${raw}'`,
        remediation: `Delete ${pidPath} and restart Angel via Claude Code session-start.`,
      };
    }

    try {
      killFn(pid, 0);
    } catch {
      return {
        name: 'Angel',
        status: 'fail',
        detail: `PID ${pid} not running (stale PID file)`,
        remediation: `Delete ${pidPath} and restart Angel via Claude Code session-start.`,
      };
    }

    const stat = fs.statSync(pidPath);
    const ageMs = now() - stat.mtimeMs;
    const ageS = Math.max(0, Math.round(ageMs / 1000));

    if (ageMs >= freshnessMs) {
      return {
        name: 'Angel',
        status: 'warn',
        detail: `PID ${pid} alive but last heartbeat ${ageS}s ago (>=${Math.round(freshnessMs / 1000)}s)`,
        remediation:
          'Angel may be stuck in a long consolidation cycle. If this persists, restart via Claude Code session-end + session-start.',
      };
    }

    return {
      name: 'Angel',
      status: 'pass',
      detail: `PID ${pid}, heartbeat fresh (${ageS}s)`,
    };
  };
}

export const checkAngel: CheckFn = makeCheckAngel();
