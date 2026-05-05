/**
 * Phase 6 boundary thresholds — env-configurable with CONTEXT.md locked defaults.
 *
 * All values are seconds. Sweep cadence reuses Angel's existing
 * `heartbeatIntervalMs` (DEFAULT_ANGEL_CONFIG in src/angel/types.ts).
 *
 * Override via environment variables; missing/malformed/non-positive values
 * fall back to LOCKED_DEFAULTS so a misconfiguration never weakens the
 * boundary detector below its CONTEXT-locked floor.
 */

export interface BoundaryThresholds {
  tJsonl: number;          // 15 min — dormant idle threshold
  tGrace: number;          // 15 min — dormant->terminated grace
  tHeartbeat: number;      // 5 min — heartbeat staleness (PID-dead corroborator)
  tJsonlShort: number;     // 5 min — short-window JSONL corroborator
  tReopen: number;         // 60 min — re-open vs anomaly window
  jsonlDebounceMs: number; // 200 ms — chokidar awaitWriteFinish stabilityThreshold
}

export const LOCKED_DEFAULTS: BoundaryThresholds = {
  tJsonl: 15 * 60,
  tGrace: 15 * 60,
  tHeartbeat: 5 * 60,
  tJsonlShort: 5 * 60,
  tReopen: 60 * 60,
  jsonlDebounceMs: 200,
};

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadThresholds(): BoundaryThresholds {
  return {
    tJsonl:          readEnvInt('CLAUDEX_EPISODE_T_JSONL_SECONDS',       LOCKED_DEFAULTS.tJsonl),
    tGrace:          readEnvInt('CLAUDEX_EPISODE_T_GRACE_SECONDS',       LOCKED_DEFAULTS.tGrace),
    tHeartbeat:      readEnvInt('CLAUDEX_EPISODE_T_HEARTBEAT_SECONDS',   LOCKED_DEFAULTS.tHeartbeat),
    tJsonlShort:     readEnvInt('CLAUDEX_EPISODE_T_JSONL_SHORT_SECONDS', LOCKED_DEFAULTS.tJsonlShort),
    tReopen:         readEnvInt('CLAUDEX_EPISODE_REOPEN_WINDOW_SECONDS', LOCKED_DEFAULTS.tReopen),
    jsonlDebounceMs: readEnvInt('CLAUDEX_EPISODE_JSONL_DEBOUNCE_MS',     LOCKED_DEFAULTS.jsonlDebounceMs),
  };
}
