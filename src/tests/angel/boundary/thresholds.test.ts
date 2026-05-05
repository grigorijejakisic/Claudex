/**
 * Tests for src/angel/boundary/thresholds.ts.
 *
 * Verifies env-override path, fallback to LOCKED_DEFAULTS on missing,
 * malformed, zero, and negative values.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadThresholds, LOCKED_DEFAULTS } from '../../../angel/boundary/thresholds.js';

const ENV_KEYS = [
  'CLAUDEX_EPISODE_T_JSONL_SECONDS',
  'CLAUDEX_EPISODE_T_GRACE_SECONDS',
  'CLAUDEX_EPISODE_T_HEARTBEAT_SECONDS',
  'CLAUDEX_EPISODE_T_JSONL_SHORT_SECONDS',
  'CLAUDEX_EPISODE_REOPEN_WINDOW_SECONDS',
  'CLAUDEX_EPISODE_JSONL_DEBOUNCE_MS',
];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe('loadThresholds', () => {
  afterEach(() => { clearEnv(); });

  it('returns LOCKED_DEFAULTS when no env vars set', () => {
    clearEnv();
    expect(loadThresholds()).toEqual(LOCKED_DEFAULTS);
  });

  it('respects env override for tJsonl', () => {
    clearEnv();
    process.env.CLAUDEX_EPISODE_T_JSONL_SECONDS = '30';
    expect(loadThresholds().tJsonl).toBe(30);
  });

  it('respects env override for tHeartbeat', () => {
    clearEnv();
    process.env.CLAUDEX_EPISODE_T_HEARTBEAT_SECONDS = '120';
    expect(loadThresholds().tHeartbeat).toBe(120);
  });

  it('respects env override for jsonlDebounceMs', () => {
    clearEnv();
    process.env.CLAUDEX_EPISODE_JSONL_DEBOUNCE_MS = '500';
    expect(loadThresholds().jsonlDebounceMs).toBe(500);
  });

  it('falls back on malformed env value (alpha)', () => {
    clearEnv();
    process.env.CLAUDEX_EPISODE_T_JSONL_SECONDS = 'abc';
    expect(loadThresholds().tJsonl).toBe(LOCKED_DEFAULTS.tJsonl);
  });

  it('falls back on zero env value', () => {
    clearEnv();
    process.env.CLAUDEX_EPISODE_T_GRACE_SECONDS = '0';
    expect(loadThresholds().tGrace).toBe(LOCKED_DEFAULTS.tGrace);
  });

  it('falls back on negative env value', () => {
    clearEnv();
    process.env.CLAUDEX_EPISODE_T_GRACE_SECONDS = '-5';
    expect(loadThresholds().tGrace).toBe(LOCKED_DEFAULTS.tGrace);
  });

  it('falls back on empty string env value', () => {
    clearEnv();
    process.env.CLAUDEX_EPISODE_T_JSONL_SHORT_SECONDS = '';
    expect(loadThresholds().tJsonlShort).toBe(LOCKED_DEFAULTS.tJsonlShort);
  });

  it('LOCKED_DEFAULTS has CONTEXT-locked values', () => {
    expect(LOCKED_DEFAULTS.tJsonl).toBe(15 * 60);
    expect(LOCKED_DEFAULTS.tGrace).toBe(15 * 60);
    expect(LOCKED_DEFAULTS.tHeartbeat).toBe(5 * 60);
    expect(LOCKED_DEFAULTS.tJsonlShort).toBe(5 * 60);
    expect(LOCKED_DEFAULTS.tReopen).toBe(60 * 60);
    expect(LOCKED_DEFAULTS.jsonlDebounceMs).toBe(200);
  });
});
