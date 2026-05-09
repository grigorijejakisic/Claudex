/**
 * POLISH-15/16 — phase-11-close script regression tests.
 *
 * Validates the conditional-branch applier + 11-RESULTS.md authoring + retag
 * annotation generator via spawnSync with synthetic verdict files. No live
 * cloud calls; no actual git tag mutations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'phase-11-close.cjs');

let workDir: string;
let phaseDir: string;
let originalCwd: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-close-'));
  phaseDir = path.join(workDir, '.planning', 'phases', '11-polish-land-v6-properly');
  fs.mkdirSync(phaseDir, { recursive: true });
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

function runClose(extraArgs: string[] = []): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [SCRIPT, ...extraArgs], {
    cwd: workDir,
    encoding: 'utf8',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function writeQ1(verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE'): void {
  fs.writeFileSync(path.join(phaseDir, 'q1-verdict.json'), JSON.stringify({
    verdict,
    fallback_rate_pct: 5.5,
    per_judge_errors_pct: { 'gemini-3-flash': 3.3 },
    paired_mcnemar: {
      a_only: 3, b_only: 14, discordant_pairs: 17,
      p_value: 0.0127, min_discordant_threshold: 5,
      verdict, by_replication: [],
    },
    q1_started_at: '2026-05-09T22:00:00.000Z',
    q1_completed_at: '2026-05-09T22:30:00.000Z',
    preflight: { reranker_health: 'ok' },
  }));
}

function writeQ2(verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE'): void {
  fs.writeFileSync(path.join(phaseDir, 'q2-verdict.json'), JSON.stringify({ verdict }));
}

function writeQ2Skipped(reason: string): void {
  fs.writeFileSync(path.join(phaseDir, 'q2-skipped.json'), JSON.stringify({
    skipped_at: '2026-05-09T22:30:00.000Z',
    skip_reason: reason,
    q1_verdict: 'BIND_NEGATIVE',
  }));
}

function writeQ3(verdict: 'BIND_POSITIVE' | 'BIND_NEGATIVE' | 'INCONCLUSIVE'): void {
  fs.writeFileSync(path.join(phaseDir, 'q3-verdict.json'), JSON.stringify({ verdict }));
}

describe('phase-11-close (POLISH-15/16)', () => {
  it('exits 2 when q1-verdict.json missing', () => {
    const r = runClose();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('q1-verdict.json missing');
  });

  it('Q1+Q2+Q3 all BIND_POSITIVE → engineering_close_strong_bind', () => {
    writeQ1('BIND_POSITIVE');
    writeQ2('BIND_POSITIVE');
    writeQ3('BIND_POSITIVE');
    const r = runClose();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('engineering_close_strong_bind');
    const md = fs.readFileSync(path.join(phaseDir, '11-RESULTS.md'), 'utf8');
    expect(md).toContain('cross-corpus generalization confirmed');
    expect(md).toContain('git tag -a v6.0.0');
  });

  it('Q1+Q2 BIND_POSITIVE, Q3 missing → engineering_close_within_corpus_bind', () => {
    writeQ1('BIND_POSITIVE');
    writeQ2('BIND_POSITIVE');
    const r = runClose();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('engineering_close_within_corpus_bind');
    const md = fs.readFileSync(path.join(phaseDir, '11-RESULTS.md'), 'utf8');
    expect(md).toContain('cross-corpus deferred');
  });

  it('Q1+Q2 BIND_POSITIVE, Q3 BIND_NEGATIVE → engineering_close_recursive_echo', () => {
    writeQ1('BIND_POSITIVE');
    writeQ2('BIND_POSITIVE');
    writeQ3('BIND_NEGATIVE');
    const r = runClose();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('engineering_close_recursive_echo');
    const md = fs.readFileSync(path.join(phaseDir, '11-RESULTS.md'), 'utf8');
    expect(md).toContain('echo-chamber risk confirmed');
  });

  it('Q1 BIND_POSITIVE + Q2 BIND_NEGATIVE → kill_receipt_q2_negative', () => {
    writeQ1('BIND_POSITIVE');
    writeQ2('BIND_NEGATIVE');
    const r = runClose();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('kill_receipt_q2_negative');
    const md = fs.readFileSync(path.join(phaseDir, '11-RESULTS.md'), 'utf8');
    expect(md).toContain('within-corpus bind was probe-set artifact');
  });

  it('Q1 BIND_POSITIVE + Q2 INCONCLUSIVE → p11_1_corpus_expansion (do NOT retag)', () => {
    writeQ1('BIND_POSITIVE');
    writeQ2('INCONCLUSIVE');
    const r = runClose();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('p11_1_corpus_expansion');
    const md = fs.readFileSync(path.join(phaseDir, '11-RESULTS.md'), 'utf8');
    expect(md).toContain('Phase 11.1 (corpus expansion)');
    expect(md).toContain('Do NOT retag');
  });

  it('Q1 BIND_NEGATIVE → kill_receipt_q1_negative', () => {
    writeQ1('BIND_NEGATIVE');
    writeQ2Skipped('Q1 not BIND_POSITIVE');
    const r = runClose();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('kill_receipt_q1_negative');
  });

  it('Q1 INCONCLUSIVE → kill_receipt_q1_inconclusive', () => {
    writeQ1('INCONCLUSIVE');
    writeQ2Skipped('Q1 INCONCLUSIVE');
    const r = runClose();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('kill_receipt_q1_inconclusive');
  });

  it('--print-retag-cmd-only emits only the annotation + retag cmd, no MD write', () => {
    writeQ1('BIND_POSITIVE');
    writeQ2('BIND_POSITIVE');
    writeQ3('BIND_POSITIVE');
    const r = runClose(['--print-retag-cmd-only']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('git tag -d v6.0.0');
    expect(r.stdout).toContain('git tag -a v6.0.0');
    expect(fs.existsSync(path.join(phaseDir, '11-RESULTS.md'))).toBe(false);
  });

  it('--dry-run prints MD content but does not write file', () => {
    writeQ1('BIND_POSITIVE');
    writeQ2('BIND_POSITIVE');
    writeQ3('BIND_POSITIVE');
    const r = runClose(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain('Phase 11 — RESULTS');
    expect(fs.existsSync(path.join(phaseDir, '11-RESULTS.md'))).toBe(false);
  });
});
