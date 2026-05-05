/**
 * Regression tests for Angel heartbeat bug fixes.
 *
 * Covers:
 * - Process guard: isPythonScriptRunning checks for specific script name
 * - Services-down interval override: when critical services are observed down,
 *   the next-interval computation pins to ACTIVE cadence instead of drifting
 *   into idle backoff (so ensureRunning recovery happens on the next tick,
 *   not 10–30 min later).
 *
 * Phase 4 narrowing: the prior `definitiveOutcomes` regression cases were
 * dropped — that list lived in the deleted Site A pattern-extraction loop
 * (Plan 04-02). The list itself no longer exists in heartbeat.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { computeNextInterval } from '../../angel/heartbeat.js';
import type { TickResult } from '../../angel/heartbeat.js';

// ---------------------------------------------------------------------------
// Regression: Process guard checks for specific script name
// isPythonScriptRunning must check the command line for the specific script
// name, not just whether any python.exe is running. Without this, having
// ANY Python process running would prevent restarting the target script.
// ---------------------------------------------------------------------------

describe('Process guard — isPythonScriptRunning logic (regression)', () => {
  // Replicate the logic from heartbeat.ts without actually calling execSync
  function isPythonScriptRunningSimulated(
    commandLineOutput: string,
    scriptName: string,
  ): boolean {
    return commandLineOutput.toLowerCase().includes(scriptName.toLowerCase());
  }

  it('returns true when specific script is in command line', () => {
    const commandLines = 'python.exe C:\\Projects\\services\\reranker.py\n';
    expect(isPythonScriptRunningSimulated(commandLines, 'reranker.py')).toBe(true);
  });

  it('returns false when different Python script is running', () => {
    const commandLines = 'python.exe C:\\Other\\server.py\npython.exe C:\\ML\\train.py\n';
    expect(isPythonScriptRunningSimulated(commandLines, 'reranker.py')).toBe(false);
  });

  it('returns false when no Python processes are running', () => {
    const commandLines = '';
    expect(isPythonScriptRunningSimulated(commandLines, 'reranker.py')).toBe(false);
  });

  it('is case-insensitive', () => {
    const commandLines = 'python.exe C:\\SERVICES\\RERANKER.PY\n';
    expect(isPythonScriptRunningSimulated(commandLines, 'reranker.py')).toBe(true);
  });

  it('does not match different script names', () => {
    // "reranker_v2.py" does NOT contain "reranker.py" as a substring
    // (the _v2 breaks the match). This is correct behavior.
    const commandLines = 'python.exe C:\\services\\reranker_v2.py\n';
    expect(isPythonScriptRunningSimulated(commandLines, 'reranker.py')).toBe(false);
  });

  it('matches when exact script name appears in path', () => {
    // Full path with the exact script name should match
    const commandLines = 'python.exe C:\\services\\reranker.py --port 8080\n';
    expect(isPythonScriptRunningSimulated(commandLines, 'reranker.py')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: Services-down interval override
// When result.services_down contains at least one entry, computeNextInterval
// must return the ACTIVE cadence (2 min) with `idle: false`, regardless of
// whether there's a backlog, active sessions, or consecutive idle ticks.
// Without this, a service dying during an idle window would leave retrieval
// in fallback mode for up to MAX_INTERVAL_MS before the next ensureRunning
// recovery attempt.
// ---------------------------------------------------------------------------

describe('Services-down interval override (regression)', () => {
  const ACTIVE_INTERVAL_MS = 2 * 60 * 1000;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // computeNextInterval reads from `sessions` (for the active-session check)
    // and from the pending-backlog SQL. Create minimal schema so those queries
    // don't throw. Empty tables exercise the P0 services_down override path
    // before the backlog / active-session paths are reached.
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      );
      CREATE TABLE observations (id INTEGER PRIMARY KEY, processed INTEGER DEFAULT 0);
      CREATE TABLE artifacts (id INTEGER PRIMARY KEY, embedding BLOB);
      CREATE TABLE conversation_turns (id INTEGER PRIMARY KEY, processed INTEGER DEFAULT 0);
    `);
  });

  afterEach(() => {
    db.close();
  });

  function makeResult(overrides: Partial<TickResult> = {}): TickResult {
    return {
      idle_warnings_sent: 0,
      sessions_processed: 0,
      patterns_extracted: 0,
      domains_classified: 0,
      duration_ms: 10,
      ...overrides,
    };
  }

  it('pins to ACTIVE_INTERVAL_MS when one service is down', () => {
    const result = makeResult({ services_down: ['Reranker (Neural cross-encoder (CUDA))'] });
    const { intervalMs, idle } = computeNextInterval(db, result, 5); // 5 consecutive idle ticks
    expect(intervalMs).toBe(ACTIVE_INTERVAL_MS);
    expect(idle).toBe(false);
  });

  it('pins to ACTIVE_INTERVAL_MS when multiple services are down', () => {
    const result = makeResult({
      services_down: ['Reranker (cross-encoder)', 'CliProxy (LLM routing)'],
    });
    const { intervalMs, idle } = computeNextInterval(db, result, 10);
    expect(intervalMs).toBe(ACTIVE_INTERVAL_MS);
    expect(idle).toBe(false);
  });

  it('override beats idle exponential backoff', () => {
    // 10 consecutive idle ticks would normally drive the interval to MAX
    // (30 min) via exponential backoff. The override must take precedence.
    const result = makeResult({ services_down: ['Reranker (x)'] });
    const { intervalMs } = computeNextInterval(db, result, 10);
    expect(intervalMs).toBeLessThan(3 * 60 * 1000);
    expect(intervalMs).toBe(ACTIVE_INTERVAL_MS);
  });

  it('does NOT override when services_down is undefined', () => {
    // Empty DB + no backlog + no active sessions + no work done → should fall
    // through to the idle exponential backoff path. This is the control case
    // proving the test DB is wired correctly and the override is the reason
    // the previous cases returned ACTIVE_INTERVAL_MS.
    const result = makeResult(); // services_down undefined
    const { idle } = computeNextInterval(db, result, 0);
    expect(idle).toBe(true);
  });

  it('does NOT override when services_down is empty array', () => {
    // Defensive: an empty array from the heartbeat service-check block
    // (e.g., all services recovered within the tick) must NOT trigger the
    // override, otherwise we'd stay on active cadence forever after any
    // earlier down-service.
    const result = makeResult({ services_down: [] });
    const { idle } = computeNextInterval(db, result, 0);
    expect(idle).toBe(true);
  });
});
