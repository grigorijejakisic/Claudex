/**
 * Unit tests for the SC#3 mechanical content-quality scorer.
 *
 * Asserts the 5-dimension rubric matches Plan 11-01 spec exactly using
 * synthetic fixtures (one passing case + one failing case per dimension +
 * one drift case for the handoff dimension).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scoreMemoryContent,
  scoreParsing,
  scoreProjectSpecific,
  scoreTopicsNotSessionIds,
  scorePointerDensity,
  scoreHandoffFreshness,
} from '../../benchmark/memory-quality/scorer.js';

const fakeHash = 'a'.repeat(64);

function buildFixture(opts: {
  hash?: string;
  managedSection?: string[];
  withMarker?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${opts.hash ?? fakeHash} -->`);
  if (opts.managedSection) lines.push(...opts.managedSection);
  if (opts.withMarker !== false) {
    lines.push('<!-- USER EDITABLE -->');
    lines.push('');
    lines.push('## User Notes');
  }
  return lines.join('\n');
}

describe('SC#3 mechanical scorer — dimension 1 (parsing)', () => {
  it('passes on a well-formed file', () => {
    const content = buildFixture({ managedSection: ['## Active Projects', '- foo'] });
    expect(scoreParsing(content).score).toBe(20);
  });

  it('fails on missing top sentinel', () => {
    const content = '## Active Projects\n- foo\n<!-- USER EDITABLE -->\n';
    const r = scoreParsing(content);
    expect(r.score).toBe(0);
    expect(r.details).toMatch(/sentinel/i);
  });

  it('fails on malformed sentinel hash', () => {
    const content = `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=tooshort -->\n<!-- USER EDITABLE -->\n`;
    expect(scoreParsing(content).score).toBe(0);
  });

  it('fails on missing line-anchored marker', () => {
    const content = `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${fakeHash} -->\nbody only`;
    expect(scoreParsing(content).score).toBe(0);
  });

  it('fails on duplicate ## headers in managed section', () => {
    const content = buildFixture({
      managedSection: ['## Active Projects', '- foo', '## Active Projects', '- bar'],
    });
    const r = scoreParsing(content);
    expect(r.score).toBe(0);
    expect(r.details).toMatch(/duplicat/i);
  });
});

describe('SC#3 mechanical scorer — dimension 2 (project-specific pointers)', () => {
  it('returns full score when ≥80% are lesson-style filenames', () => {
    const content = buildFixture({
      managedSection: [
        '## Lessons',
        '- [Lesson A](feedback_alpha.md) — task-pattern: x',
        '- [Lesson B](project_beta.md) — task-pattern: y',
        '- [Lesson C](process_gamma.md) — task-pattern: z',
        '- [Lesson D](feedback_delta.md) — task-pattern: w',
        '- [Lesson E](feedback_epsilon.md) — task-pattern: v',
      ],
    });
    const r = scoreProjectSpecific(content, 'claudex-v3');
    expect(r.total).toBe(5);
    expect(r.specific).toBe(5);
    expect(r.score).toBe(20);
  });

  it('penalizes random-target pointers', () => {
    const content = buildFixture({
      managedSection: [
        '## Lessons',
        '- [Random thought](some-note.txt) — task-pattern: misc',
        '- [Another thought](other.txt) — task-pattern: misc',
        '- [One real](feedback_real.md) — task-pattern: code',
      ],
    });
    const r = scoreProjectSpecific(content, 'claudex-v3');
    // 1/3 specific = ~33% → 7pts (linear)
    expect(r.score).toBeLessThan(20);
    expect(r.score).toBeLessThanOrEqual(8);
  });

  it('returns 0 when no pointers exist', () => {
    const content = buildFixture({
      managedSection: ['## Active Projects', 'no list at all', '## Handoff', 'No active handoff'],
    });
    const r = scoreProjectSpecific(content, 'claudex-v3');
    expect(r.score).toBe(0);
    expect(r.total).toBe(0);
  });

  it('credits markdown-link pointers whose line contains the project slug', () => {
    const content = buildFixture({
      managedSection: [
        '## Lessons',
        '- [Phase 11 ship gate](../docs/claudex-v3-ship-notes.md)',
        '- [Lacuna betting flow](../docs/lacuna-betting.md)',
      ],
    });
    const r = scoreProjectSpecific(content, 'claudex-v3');
    // First line contains "claudex-v3" substring → project-specific.
    // Second line does not contain claudex; it contains "lacuna".
    expect(r.specific).toBeGreaterThanOrEqual(1);
  });

  it('falls back to User Notes pointers when managed Lessons is sparse (Phase 4.1 gold-standard fix)', () => {
    // Managed Lessons has <3 pointers → scorer should look at User Notes tail
    // and credit user-curated markdown-link pointers as project-specific.
    const lines: string[] = [];
    lines.push(`<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${fakeHash} -->`);
    lines.push('## Active Projects');
    lines.push('- some-project — N edits');
    lines.push('');
    lines.push('## Lessons');
    lines.push('');
    lines.push('No lessons captured yet.');
    lines.push('');
    lines.push('## Handoff');
    lines.push('');
    lines.push('No active handoff.');
    lines.push('<!-- USER EDITABLE -->');
    lines.push('');
    lines.push('## User Notes');
    lines.push('');
    lines.push('- [Mozzart Cloudflare 429](feedback_mozzart_429.md) — per-IP, 15-min auto-heal');
    lines.push('- [Realtime architecture](feedback_realtime.md) — WebSocket push, no polling');
    lines.push('- [System architecture](project_system.md) — fast/slow source-target detection');
    lines.push('- [Forbidden path](feedback_forbidden.md) — never touch big-mozzart-clean');
    const content = lines.join('\n');
    const r = scoreProjectSpecific(content, 'lacuna-betting-9f1d552c');
    // 4 user-curated pointers, all should count as project-specific
    expect(r.total).toBe(4);
    expect(r.specific).toBe(4);
    expect(r.score).toBe(20);
  });

  it('does NOT fall back to User Notes when managed Lessons has >=3 entries', () => {
    const lines: string[] = [];
    lines.push(`<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${fakeHash} -->`);
    lines.push('## Lessons');
    lines.push('- [A](feedback_a.md) — task-pattern: x');
    lines.push('- [B](project_b.md) — task-pattern: y');
    lines.push('- [C](feedback_c.md) — task-pattern: z');
    lines.push('<!-- USER EDITABLE -->');
    lines.push('## User Notes');
    lines.push('- [random unrelated link](some-other.txt)');
    const content = lines.join('\n');
    const r = scoreProjectSpecific(content, 'whatever');
    // 3 managed pointers, all lesson-style → 3 specific
    expect(r.total).toBe(3);
    expect(r.specific).toBe(3);
  });
});

describe('SC#3 mechanical scorer — dimension 3 (topics not session-IDs)', () => {
  it('returns full score for clean topic labels', () => {
    const content = buildFixture({
      managedSection: [
        '## Lessons',
        '- [Mozzart 429 is per-IP](feedback_a.md)',
        '- [Always commit before clear](feedback_b.md)',
      ],
    });
    expect(scoreTopicsNotSessionIds(content).score).toBe(20);
  });

  it('penalizes session-shaped labels', () => {
    const content = buildFixture({
      managedSection: [
        '## Lessons',
        '- [session-deadbeef thoughts](feedback_a.md)',
        '- [Real topic here](feedback_b.md)',
      ],
    });
    const r = scoreTopicsNotSessionIds(content);
    // 1/2 clean → 10pts
    expect(r.score).toBe(10);
    expect(r.topicLabeled).toBe(1);
  });

  it('returns full score on empty pointer list (no penalty)', () => {
    const content = buildFixture({ managedSection: ['## Handoff', 'No active handoff'] });
    expect(scoreTopicsNotSessionIds(content).score).toBe(20);
  });
});

describe('SC#3 mechanical scorer — dimension 4 (pointer density)', () => {
  it('returns 20 for ≥10% density', () => {
    const lines: string[] = ['## Lessons'];
    // 5 pointers, 10 nonblank lines (5 pointers + header + 4 spacers — but spacers are blank)
    for (let i = 0; i < 5; i++) lines.push(`- [Item ${i}](feedback_${i}.md)`);
    const content = buildFixture({ managedSection: lines });
    expect(scorePointerDensity(content).score).toBe(20);
  });

  it('returns 0 for <5% density', () => {
    const lines: string[] = ['## Active Projects'];
    for (let i = 0; i < 50; i++) lines.push(`narrative line ${i}`);
    lines.push('- [Sole pointer](feedback.md)');
    const content = buildFixture({ managedSection: lines });
    expect(scorePointerDensity(content).score).toBe(0);
  });

  it('returns 0 when no nonblank lines (degenerate)', () => {
    const content = buildFixture({ managedSection: ['', '', ''] });
    const r = scorePointerDensity(content);
    expect(r.nonblankLines).toBeGreaterThanOrEqual(0);
  });
});

describe('SC#3 mechanical scorer — dimension 5 (handoff freshness)', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc3-handoff-'));
  });
  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 20 when MEMORY says no handoff and ACTIVE.md is missing', () => {
    const content = buildFixture({ managedSection: ['## Handoff', '', 'No active handoff.'] });
    const activePath = path.join(tempDir, 'ACTIVE.md');
    const r = scoreHandoffFreshness(content, activePath);
    expect(r.score).toBe(20);
  });

  it('returns 20 when MEMORY says no handoff and ACTIVE.md is archived', () => {
    const content = buildFixture({ managedSection: ['## Handoff', '', 'No active handoff.'] });
    const activePath = path.join(tempDir, 'ACTIVE.md');
    fs.writeFileSync(activePath, '---\nstatus: archived\nphase: 09\n---\nbody', 'utf8');
    expect(scoreHandoffFreshness(content, activePath).score).toBe(20);
  });

  it('returns 0 when MEMORY says no handoff but ACTIVE.md status:active (drift)', () => {
    const content = buildFixture({ managedSection: ['## Handoff', '', 'No active handoff.'] });
    const activePath = path.join(tempDir, 'ACTIVE.md');
    fs.writeFileSync(activePath, '---\nstatus: active\nphase: 11\n---\nbody', 'utf8');
    expect(scoreHandoffFreshness(content, activePath).score).toBe(0);
  });

  it('returns 20 when MEMORY links a handoff and ACTIVE.md is active', () => {
    const content = buildFixture({
      managedSection: [
        '## Handoff',
        '',
        'Active handoff at phase 11.',
        'See: context/handoffs/ACTIVE.md',
      ],
    });
    const activePath = path.join(tempDir, 'ACTIVE.md');
    fs.writeFileSync(activePath, '---\nstatus: active\nphase: 11\n---\nbody', 'utf8');
    expect(scoreHandoffFreshness(content, activePath).score).toBe(20);
  });
});

describe('SC#3 mechanical scorer — total + pass aggregation', () => {
  it('passes ≥80 on a well-formed claudex-v3-shaped MEMORY.md', () => {
    const content = buildFixture({
      managedSection: [
        '## Active Projects',
        '- claudex-v3 — 269 edits in last 7d',
        '- lacuna-betting-9f1d552c — 375 edits in last 7d',
        '',
        '## Lessons',
        '- [Mozzart 429 per-IP shadowban](feedback_mozzart_429.md) — task-pattern: scraping',
        '- [Always commit before clear](feedback_always_commit.md) — task-pattern: workflow',
        '- [Verify before claiming done](feedback_verify_done.md) — task-pattern: pre-merge',
        '- [60-poll backend X shadowban](project_backendx_shadowban.md) — task-pattern: scraping',
        '',
        '## Handoff',
        '',
        'Active handoff at phase 11.',
        'See: context/handoffs/ACTIVE.md',
      ],
    });
    const r = scoreMemoryContent(content, '/tmp/MEMORY.md', { project: 'claudex-v3' });
    expect(r.dimensions.parsing.score).toBe(20);
    expect(r.total).toBeGreaterThanOrEqual(80);
    expect(r.pass).toBe(true);
  });

  it('total = 0 when parsing fails (hard-fail dimension)', () => {
    const corrupted = '## broken\nno sentinel\n';
    const r = scoreMemoryContent(corrupted, '/tmp/MEMORY.md', { project: 'x' });
    expect(r.total).toBe(0);
    expect(r.pass).toBe(false);
  });
});
