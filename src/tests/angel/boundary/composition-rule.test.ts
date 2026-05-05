/**
 * Truth-table coverage for classifySession (Phase 6 EBD-03).
 *
 * Uses LOCKED_DEFAULTS thresholds:
 *   tJsonl=15min, tGrace=15min, tHeartbeat=5min, tJsonlShort=5min,
 *   tReopen=60min, jsonlDebounceMs=200ms.
 *
 * Critical case: #2 (hooks dead, JSONL fresh, PID alive) MUST classify ALIVE.
 * If that breaks, JSONL-trumps-heartbeat is broken and the boundary detector
 * will close active sessions whose hooks happen to be slow.
 */

import { describe, it, expect } from 'vitest';
import { classifySession, type SessionLivenessRow } from '../../../angel/boundary/composition-rule.js';
import { LOCKED_DEFAULTS } from '../../../angel/boundary/thresholds.js';

const NOW = 10_000;
const t = LOCKED_DEFAULTS;

function row(overrides: Partial<SessionLivenessRow>): SessionLivenessRow {
  return {
    session_id: 's1',
    project: 'p1',
    pid: 12345,
    pid_alive: true,
    last_heartbeat_ts: NOW,
    last_jsonl_write_ts: NOW,
    has_clean_endsession: false,
    ...overrides,
  };
}

describe('classifySession truth table', () => {
  it('1) fresh PID-alive session → alive', () => {
    const r = row({ last_jsonl_write_ts: NOW - 60, last_heartbeat_ts: NOW - 60 });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'alive' });
  });

  it('2) hooks dead, JSONL fresh, PID alive → alive (JSONL-trumps-heartbeat)', () => {
    // 3h-old heartbeat, 1min-old JSONL, PID alive.
    // Plan 04 truth-table case #2 — load-bearing test.
    const r = row({
      last_heartbeat_ts: NOW - 3 * 3600,
      last_jsonl_write_ts: NOW - 60,
      pid_alive: true,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'alive' });
  });

  it('3) both signals fresh but PID dead → dormant (PID-dead requires AND-corroboration)', () => {
    const r = row({
      last_heartbeat_ts: NOW - 60,
      last_jsonl_write_ts: NOW - 60,
      pid_alive: false,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'dormant' });
  });

  it('4) JSONL stale, heartbeat fresh, PID alive → dormant (jsonlFreshFull=false; not yet T_jsonl+T_grace)', () => {
    const r = row({
      last_jsonl_write_ts: NOW - 16 * 60,
      last_heartbeat_ts: NOW - 60,
      pid_alive: true,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'dormant' });
  });

  it('5) idle_timeout: JSONL ≥ T_jsonl+T_grace (35min) → terminated, idle_timeout', () => {
    const r = row({
      last_jsonl_write_ts: NOW - 35 * 60,
      last_heartbeat_ts: NOW - 35 * 60,
      pid_alive: false,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'terminated', close_reason: 'idle_timeout' });
  });

  it('6) PID dead corroborated, JSONL still fresh-full but past T_jsonl_short → pid_dead', () => {
    // jsonl 6min, heartbeat 6min, pid=false → pidDeadCorroborated; jsonl 6 < T_jsonl=15 → pid_dead
    const r = row({
      last_jsonl_write_ts: NOW - 6 * 60,
      last_heartbeat_ts: NOW - 6 * 60,
      pid_alive: false,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'terminated', close_reason: 'pid_dead' });
  });

  it('7) PID dead, JSONL past T_jsonl but < T_jsonl+T_grace → jsonl_silent', () => {
    // jsonl 16min, heartbeat 16min, pid=false → pidDeadCorroborated; jsonl ≥ T_jsonl=15 → jsonl_silent
    const r = row({
      last_jsonl_write_ts: NOW - 16 * 60,
      last_heartbeat_ts: NOW - 16 * 60,
      pid_alive: false,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'terminated', close_reason: 'jsonl_silent' });
  });

  it('8) clean_endsession short-circuits all timing windows', () => {
    const r = row({
      last_jsonl_write_ts: NOW - 60,
      last_heartbeat_ts: NOW - 60,
      pid_alive: true,
      has_clean_endsession: true,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'terminated', close_reason: 'clean_endsession' });
  });

  it('9) all timestamps NULL, PID alive → terminated, idle_timeout (defensive: caller should not feed this; jsonlAge=Infinity dominates)', () => {
    const r = row({
      last_jsonl_write_ts: null,
      last_heartbeat_ts: null,
      pid_alive: true,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'terminated', close_reason: 'idle_timeout' });
  });

  it('10) all timestamps NULL, PID dead → terminated, idle_timeout (Infinity ≥ T_jsonl+T_grace)', () => {
    const r = row({
      last_jsonl_write_ts: null,
      last_heartbeat_ts: null,
      pid_alive: false,
    });
    expect(classifySession(NOW, r, t)).toEqual({ state: 'terminated', close_reason: 'idle_timeout' });
  });
});
