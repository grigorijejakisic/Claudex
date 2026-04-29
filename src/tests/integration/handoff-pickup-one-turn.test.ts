/**
 * SC#4 — One-turn handoff pickup contract (Phase 5 Plan 07).
 *
 * Verifies the surface that SC#4 measures: a fresh session reads ACTIVE.md and
 * `initialUserMessage` is set to a `Resume handoff:` prime. The actual
 * agent-behavior aspect of SC#4 (no exploratory glob/grep before first
 * user-facing action) is verified by Plan 09's live-fire soak; this test locks
 * the structural surface the soak builds on.
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeInitialUserMessage } from '../../adapters/cc-hooks/session-start.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    tmpDir = null;
  }
});

function setup(opts: { phase: string; status: string; summary?: string; bodyFirstLine?: string }): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-sc4-'));
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `# Project State\n\n**Current Phase:** ${opts.phase}\n**Current Phase Name:** Test Phase\n`,
    'utf-8',
  );
  fs.mkdirSync(path.join(tmpDir, 'context', 'handoffs'), { recursive: true });
  const summaryLine = opts.summary ? `summary: ${opts.summary}\n` : '';
  const body = opts.bodyFirstLine ? `\n${opts.bodyFirstLine}\n` : '';
  fs.writeFileSync(
    path.join(tmpDir, 'context', 'handoffs', 'ACTIVE.md'),
    `---\nstatus: ${opts.status}\nphase: "${opts.phase}"\n${summaryLine}---\n${body}`,
    'utf-8',
  );
  return tmpDir;
}

describe('SC#4 — One-turn handoff pickup', () => {
  test('fresh session with active handoff + matching phase + summary → fires prime in expected format', () => {
    const cwd = setup({ phase: '5', status: 'active', summary: 'Resume Phase 5 wave 3' });
    const msg = computeInitialUserMessage(cwd);
    expect(msg).toBe(
      'Resume handoff: Resume Phase 5 wave 3. Full state at .planning/handoffs/ACTIVE.md.'
    );
  });

  test('prime begins with `Resume handoff: ` and includes ACTIVE.md path (semantic shape)', () => {
    const cwd = setup({ phase: '5', status: 'active', summary: 'Phase 5 Tier C ready' });
    const msg = computeInitialUserMessage(cwd);
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(/^Resume handoff: /);
    expect(msg!).toContain('.planning/handoffs/ACTIVE.md');
  });

  test('prime exists and is non-empty when contract is satisfied (gate for no-glob/grep behavior verified in Plan 09 soak)', () => {
    const cwd = setup({ phase: '5', status: 'active', summary: 'X' });
    const msg = computeInitialUserMessage(cwd);
    expect(msg).not.toBeNull();
    expect(msg!.length).toBeGreaterThan(0);
  });

  test('decimal phase (4.1) end-to-end works when handoff and STATE both at 4.1', () => {
    const cwd = setup({ phase: '4.1', status: 'active', summary: 'Resume 4.1 wave 5' });
    const msg = computeInitialUserMessage(cwd);
    expect(msg).toBe(
      'Resume handoff: Resume 4.1 wave 5. Full state at .planning/handoffs/ACTIVE.md.'
    );
  });

  test('regression — handoff 4.1 against STATE 4 does NOT prime (per team-lead Q3 verdict 2026-04-29)', () => {
    // STATE.md at phase 4, handoff frontmatter at 4.1 — must NOT prime
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-sc4-mix-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 4\n', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'context', 'handoffs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'context', 'handoffs', 'ACTIVE.md'),
      '---\nstatus: active\nphase: "4.1"\nsummary: stale handoff from previous decimal subphase\n---\n',
      'utf-8');
    expect(computeInitialUserMessage(tmpDir)).toBeNull();
  });
});
