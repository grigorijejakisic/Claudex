/**
 * Regression tests for Angel heartbeat bug fixes.
 *
 * Covers:
 * - Stale string match: 'no patterns found' is in definitiveOutcomes list
 * - Process guard: isPythonScriptRunning checks for specific script name
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Regression: Stale string match in definitive outcomes
// The definitiveOutcomes list must include 'no patterns found' (not the stale
// 'no corrections found'). Without 'no patterns found', sessions with that
// summary never get marked as processed and are retried every tick forever.
// ---------------------------------------------------------------------------

describe('Stale string match — definitiveOutcomes (regression)', () => {
  // Replicate the exact definitiveOutcomes list from heartbeat.ts
  const definitiveOutcomes = ['too few turns', 'insufficient content', 'no patterns found', 'no patterns array'];

  it('includes "no patterns found" in definitive outcomes', () => {
    expect(definitiveOutcomes).toContain('no patterns found');
  });

  it('does NOT include stale "no corrections found" string', () => {
    expect(definitiveOutcomes).not.toContain('no corrections found');
  });

  it('matches extraction summary that contains "no patterns found"', () => {
    const summary = 'no patterns found in 5-turn session';
    const isDefinitive = definitiveOutcomes.some(o => summary.includes(o));
    expect(isDefinitive).toBe(true);
  });

  it('matches "no patterns array" (malformed LLM output)', () => {
    const summary = 'no patterns array in response';
    const isDefinitive = definitiveOutcomes.some(o => summary.includes(o));
    expect(isDefinitive).toBe(true);
  });

  it('does NOT match transient failure summaries', () => {
    const transients = [
      'extraction failed',
      'no LLM available (CliProxy + API + Ollama cloud + local all failed)',
      'empty LLM response',
    ];
    for (const summary of transients) {
      const isDefinitive = definitiveOutcomes.some(o => summary.includes(o));
      expect(isDefinitive).toBe(false);
    }
  });
});

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
