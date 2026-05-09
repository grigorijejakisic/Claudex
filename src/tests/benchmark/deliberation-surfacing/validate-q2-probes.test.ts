/**
 * POLISH-14 — Q2 disjoint-pool validator regression tests.
 *
 * Validates the validator script via spawnSync with synthetic fixtures.
 * No live cloud calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const VALIDATOR = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'validate-q2-probes.cjs');

let tmpDir: string;
let q2Path: string;
let p9Dir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q2-validator-'));
  q2Path = path.join(tmpDir, 'q2-locked-probes.json');
  p9Dir = path.join(tmpDir, 'p9');
  fs.mkdirSync(p9Dir, { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function writeP9Probe(id: string, sessionId: string, prompt: string): void {
  const probe = {
    id, kind: id.split('-')[1] as 'a' | 'b' | 'c' | 'd' | 'e', source: 'real',
    prompt, past_artifact_ref: ['x'],
    transcript_anchor: { session_id: sessionId, turn_index_range: [0, 5], description: 'min ten chars desc' },
    condition_shift: { past_state: 'past state', current_state: 'current state', delta: 'changed delta' },
    pass_criterion: 'Agent must surface the past-state-vs-current-state delta.',
  };
  fs.writeFileSync(path.join(p9Dir, `${id}.json`), JSON.stringify(probe));
}

function buildQ2Probe(
  id: string,
  kind: 'a' | 'b' | 'c' | 'd' | 'e',
  sessionId: string,
  prompt: string,
  source: 'real' | 'synthetic' = 'real',
  extra: Record<string, unknown> = {},
) {
  return {
    id, kind, source, prompt, past_artifact_ref: ['x'],
    transcript_anchor: { session_id: sessionId, turn_index_range: [0, 5], description: 'min ten chars desc' },
    condition_shift: { past_state: 'past state', current_state: 'current state', delta: 'changed delta' },
    pass_criterion: 'Agent must surface the past-state-vs-current-state delta.',
    ...extra,
  };
}

function buildValidPool() {
  // 12 probes per kind × 5 kinds = 60. ID convention q2-{kind}-{NN} 01..12.
  // 70%+ real → make 50 real, 10 synthetic.
  const probes = [];
  for (const kind of ['a', 'b', 'c', 'd', 'e'] as const) {
    for (let i = 1; i <= 12; i++) {
      const id = `q2-${kind}-${String(i).padStart(2, '0')}`;
      const source = i <= 10 ? 'real' : 'synthetic'; // 10 real per kind, 2 synthetic
      probes.push(buildQ2Probe(id, kind, `q2-sess-${kind}-${i}`, `Q2 prompt for ${id} probe`, source));
    }
  }
  return probes;
}

function runValidator(): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [VALIDATOR, '--probes', q2Path, '--p9-probes', p9Dir], {
    encoding: 'utf8',
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

describe('validate-q2-probes (POLISH-14)', () => {
  beforeEach(() => {
    // Seed P9 with 30 probes — same kind/count distribution as production.
    let n = 1;
    for (const kind of ['a', 'b', 'c', 'd', 'e']) {
      for (let i = 1; i <= 6; i++) {
        const id = `drift-${kind}-${String(i).padStart(2, '0')}`;
        writeP9Probe(id, `p9-sess-${kind}-${i}`, `Original P9 prompt for ${id}`);
        n++;
      }
    }
  });

  it('exits 0 on a valid 60-probe pool', () => {
    fs.writeFileSync(q2Path, JSON.stringify(buildValidPool()));
    const r = runValidator();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK — 60 probes pass');
  });

  it('exits 2 when q2-locked-probes.json is missing', () => {
    const r = runValidator();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not found');
  });

  it('exits 1 when probe count != 60', () => {
    fs.writeFileSync(q2Path, JSON.stringify(buildValidPool().slice(0, 59)));
    const r = runValidator();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('expected 60 probes, got 59');
  });

  it('exits 1 when kind balance is wrong', () => {
    const pool = buildValidPool();
    // Change one 'a' to 'b' → kind a = 11, kind b = 13.
    pool[0].kind = 'b';
    fs.writeFileSync(q2Path, JSON.stringify(pool));
    const r = runValidator();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/kind balance/);
  });

  it('exits 1 when probe ID uses forbidden drift- prefix', () => {
    const pool = buildValidPool();
    pool[0].id = 'drift-a-99';
    fs.writeFileSync(q2Path, JSON.stringify(pool));
    const r = runValidator();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/forbidden 'drift-' prefix/);
  });

  it('exits 1 when probe overlaps P9 anchor session_id', () => {
    const pool = buildValidPool();
    // Force a probe to share session_id with a P9 fixture.
    pool[0].transcript_anchor.session_id = 'p9-sess-a-1';
    fs.writeFileSync(q2Path, JSON.stringify(pool));
    const r = runValidator();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/overlaps with P9 fixture/);
  });

  it('exits 1 when source distribution < 70% real', () => {
    const pool = buildValidPool();
    // Flip many to synthetic → only 30 real / 60 = 50%.
    for (let i = 0; i < 30; i++) pool[i].source = 'synthetic';
    fs.writeFileSync(q2Path, JSON.stringify(pool));
    const r = runValidator();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/source distribution/);
  });

  it('exits 1 when probe contains parametric-likely terms without flag', () => {
    const pool = buildValidPool();
    pool[0].prompt = 'How do we configure react and django for OAuth?';
    fs.writeFileSync(q2Path, JSON.stringify(pool));
    const r = runValidator();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/parametric-likely/);
  });

  it('passes when parametric-likely term is explicitly flagged', () => {
    const pool = buildValidPool();
    pool[0].prompt = 'How do we configure react and OAuth?';
    (pool[0] as any).parametric_risk = 'mentioned';
    fs.writeFileSync(q2Path, JSON.stringify(pool));
    const r = runValidator();
    expect(r.status).toBe(0);
  });
});
