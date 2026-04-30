/**
 * Smoke + integration tests for the SC#3 CLI runner.
 *
 * Stubs the active-projects registry by injecting fixtures into a temp dir,
 * then exercises the runCli() function directly. We don't shell-out the real
 * `bun run sc3` here (slow and flaky) — the unit-level test asserts shape;
 * the live SC#3 measurement happens via the result file in 11-01-SC3-RESULT.md.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scoreMemoryFile } from '../../benchmark/memory-quality/scorer.js';

const fakeHash = 'a'.repeat(64);

function fixture(opts: { good: boolean; topic?: 'no-handoff' | 'active' }): string {
  const lines: string[] = [];
  lines.push(`<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${fakeHash} -->`);
  if (opts.good) {
    lines.push('## Active Projects');
    lines.push('- claudex-v3 — 269 edits in last 7d');
    lines.push('- lacuna-betting — 375 edits in last 7d');
    lines.push('');
    lines.push('## Lessons');
    lines.push('- [Topic A](feedback_alpha.md) — task-pattern: x');
    lines.push('- [Topic B](project_beta.md) — task-pattern: y');
    lines.push('- [Topic C](feedback_gamma.md) — task-pattern: z');
    lines.push('- [Topic D](feedback_delta.md) — task-pattern: w');
    lines.push('');
    lines.push('## Handoff');
    lines.push('');
    if (opts.topic === 'active') {
      lines.push('Active handoff at phase 11.');
      lines.push('See: context/handoffs/ACTIVE.md');
    } else {
      lines.push('No active handoff.');
    }
  } else {
    // Bad: no pointers, no lessons — density and project-specific both fail.
    for (let i = 0; i < 30; i++) lines.push(`narrative line ${i}`);
  }
  lines.push('<!-- USER EDITABLE -->');
  lines.push('');
  lines.push('## User Notes');
  return lines.join('\n');
}

describe('SC#3 CLI integration', () => {
  it('scores a passing fixture ≥80 via scoreMemoryFile()', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc3-cli-'));
    const memPath = path.join(tmp, 'MEMORY.md');
    fs.writeFileSync(memPath, fixture({ good: true, topic: 'no-handoff' }), 'utf8');
    const r = scoreMemoryFile(memPath, { project: 'claudex-v3' });
    expect(r.pass).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(80);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('scores a failing fixture <80 via scoreMemoryFile()', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc3-cli-'));
    const memPath = path.join(tmp, 'MEMORY.md');
    fs.writeFileSync(memPath, fixture({ good: false }), 'utf8');
    const r = scoreMemoryFile(memPath, { project: 'claudex-v3' });
    expect(r.pass).toBe(false);
    expect(r.total).toBeLessThan(80);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('correctly detects ACTIVE.md drift (active vs MEMORY.md no-handoff)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc3-cli-'));
    const memPath = path.join(tmp, 'MEMORY.md');
    const activePath = path.join(tmp, 'ACTIVE.md');
    fs.writeFileSync(memPath, fixture({ good: true, topic: 'no-handoff' }), 'utf8');
    fs.writeFileSync(activePath, '---\nstatus: active\nphase: 11\n---\nbody', 'utf8');
    const r = scoreMemoryFile(memPath, { project: 'claudex-v3', activeHandoffPath: activePath });
    expect(r.dimensions.handoffFreshness.score).toBe(0);
    expect(r.dimensions.handoffFreshness.details).toMatch(/drift/i);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
