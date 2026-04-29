/**
 * INJ-06 prime contract — unit-test matrix (Phase 5 Plan 07).
 *
 * Tests `computeInitialUserMessage(cwd)` directly to verify each branch
 * of the contract. Does NOT spin up a CC hook harness — this is a pure
 * function over the file system.
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeInitialUserMessage } from '../../../adapters/cc-hooks/session-start.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    tmpDir = null;
  }
});

interface SetupOpts {
  /** Frontmatter status (active|consumed|deferred) — pass null to skip frontmatter entirely. */
  status?: string | null;
  /** Frontmatter phase value. */
  handoffPhase?: string;
  /** STATE.md `Current Phase: <value>` value. Pass null to skip writing STATE.md. */
  statePhase?: string | null;
  /** Frontmatter summary value. */
  summary?: string;
  /** Body text (after the closing `---`). */
  body?: string;
  /** Skip the ACTIVE.md write entirely. */
  noActive?: boolean;
}

function setupCwd(opts: SetupOpts): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-prime-'));
  if (opts.statePhase !== null) {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** ${opts.statePhase ?? '5'}\n**Current Phase Name:** Test Phase\n`,
      'utf-8',
    );
  }
  if (!opts.noActive) {
    fs.mkdirSync(path.join(tmpDir, 'context', 'handoffs'), { recursive: true });
    let content = '';
    if (opts.status !== null) {
      const lines = ['---', `status: ${opts.status ?? 'active'}`];
      if (opts.handoffPhase !== undefined) lines.push(`phase: "${opts.handoffPhase}"`);
      if (opts.summary !== undefined) lines.push(`summary: ${opts.summary}`);
      lines.push('---', '');
      content = lines.join('\n');
    }
    if (opts.body !== undefined) content += opts.body;
    fs.writeFileSync(path.join(tmpDir, 'context', 'handoffs', 'ACTIVE.md'), content, 'utf-8');
  }
  return tmpDir;
}

describe('INJ-06 prime contract — computeInitialUserMessage', () => {
  test('1. status active + matching phase + summary present → fires', () => {
    const cwd = setupCwd({ status: 'active', handoffPhase: '5', statePhase: '5', summary: 'Resume Phase 5 wave 3' });
    expect(computeInitialUserMessage(cwd)).toBe(
      'Resume handoff: Resume Phase 5 wave 3. Full state at .planning/handoffs/ACTIVE.md.'
    );
  });

  test('2. status active + matching phase + body fallback (no summary key) → fires with body line', () => {
    const cwd = setupCwd({
      status: 'active', handoffPhase: '5', statePhase: '5',
      body: '# Phase 5 handoff\n\nResume from Tier C deletion.\n',
    });
    expect(computeInitialUserMessage(cwd)).toBe(
      'Resume handoff: Resume from Tier C deletion.. Full state at .planning/handoffs/ACTIVE.md.'
    );
  });

  test('3. status active + mismatched phase → no fire', () => {
    const cwd = setupCwd({ status: 'active', handoffPhase: '4', statePhase: '5', summary: 'X' });
    expect(computeInitialUserMessage(cwd)).toBeNull();
  });

  test('4. handoff phase=4.1 vs STATE phase=4 → no fire (EXACT match required, per team-lead Q3 verdict)', () => {
    const cwd = setupCwd({ status: 'active', handoffPhase: '4.1', statePhase: '4', summary: 'X' });
    expect(computeInitialUserMessage(cwd)).toBeNull();
  });

  test('5. status consumed → no fire', () => {
    const cwd = setupCwd({ status: 'consumed', handoffPhase: '5', statePhase: '5', summary: 'X' });
    expect(computeInitialUserMessage(cwd)).toBeNull();
  });

  test('6. no frontmatter → no fire', () => {
    const cwd = setupCwd({ status: null, statePhase: '5', body: '# Body only handoff' });
    expect(computeInitialUserMessage(cwd)).toBeNull();
  });

  test('7. no ACTIVE.md → no fire', () => {
    const cwd = setupCwd({ noActive: true, statePhase: '5' });
    expect(computeInitialUserMessage(cwd)).toBeNull();
  });

  test('8. no STATE.md → no fire (no phase to match)', () => {
    const cwd = setupCwd({ status: 'active', handoffPhase: '5', statePhase: null, summary: 'Resume X' });
    expect(computeInitialUserMessage(cwd)).toBeNull();
  });

  test('9. status Active (case insensitive) + phase quoted "5" → fires', () => {
    const cwd = setupCwd({ status: 'Active', handoffPhase: '5', statePhase: '5', summary: 'Resume Y' });
    expect(computeInitialUserMessage(cwd)).toBe(
      'Resume handoff: Resume Y. Full state at .planning/handoffs/ACTIVE.md.'
    );
  });

  test('10. only H1 in body, no summary key → no fire (no summary fallback)', () => {
    const cwd = setupCwd({
      status: 'active', handoffPhase: '5', statePhase: '5',
      body: '# Header only\n',
    });
    expect(computeInitialUserMessage(cwd)).toBeNull();
  });

  test('11. decimal-phase exact match (handoff 4.1 vs STATE 4.1) → fires', () => {
    const cwd = setupCwd({ status: 'active', handoffPhase: '4.1', statePhase: '4.1', summary: 'Resume 4.1' });
    expect(computeInitialUserMessage(cwd)).toBe(
      'Resume handoff: Resume 4.1. Full state at .planning/handoffs/ACTIVE.md.'
    );
  });

  test('12. summary with quote stripping ("Resume X") → fires with quotes stripped', () => {
    const cwd = setupCwd({ status: 'active', handoffPhase: '5', statePhase: '5', summary: '"Resume Z"' });
    expect(computeInitialUserMessage(cwd)).toBe(
      'Resume handoff: Resume Z. Full state at .planning/handoffs/ACTIVE.md.'
    );
  });
});
