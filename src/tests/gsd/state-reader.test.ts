import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readGsdState } from '../../gsd/state-reader.js';

let tmpDir: string;

function createProject(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(projectDir: string, relativePath: string, content: string): void {
  const fullPath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-gsd-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readGsdState', () => {
  it('reads phase, plan, and status from STATE.md', () => {
    const proj = createProject('test-state');
    writeFile(proj, '.planning/STATE.md', `# State\n\nPhase: 7 of 11\nPlan: 1 of 2\nStatus: executing task 1\n`);
    writeFile(proj, '.planning/ROADMAP.md', '');

    const state = readGsdState(proj);
    expect(state).not.toBeNull();
    expect(state!.phase).toBe(7);
    expect(state!.plan).toBe(1);
    expect(state!.status).toBe('executing task 1');
  });

  it('reads goal from ROADMAP.md for current phase', () => {
    const proj = createProject('test-goal');
    writeFile(proj, '.planning/STATE.md', 'Phase: 7\nPlan: 1\nStatus: active\n');
    writeFile(proj, '.planning/ROADMAP.md', `
### Phase 7: Supporting Subsystems
**Goal**: Token utilization is tracked, stale data decays, and GSD planning state is surfaced in context
**Success Criteria** (what must be TRUE):
  1. Token gauge reports utilization
  2. Decay engine calculates EI scores
`);

    const state = readGsdState(proj);
    expect(state!.goal).toContain('Token utilization is tracked');
  });

  it('reads success criteria from ROADMAP.md', () => {
    const proj = createProject('test-criteria');
    writeFile(proj, '.planning/STATE.md', 'Phase: 7\nPlan: 1\nStatus: active\n');
    writeFile(proj, '.planning/ROADMAP.md', `
### Phase 7: Supporting Subsystems
**Goal**: Token utilization is tracked
**Success Criteria** (what must be TRUE):
  1. Token gauge reports utilization
  2. Decay engine calculates EI scores
  3. GSD state reader surfaces planning state

### Phase 8: CC Hook Adapter
`);

    const state = readGsdState(proj);
    expect(state!.success_criteria).toHaveLength(3);
    expect(state!.success_criteria[0]).toContain('Token gauge');
    expect(state!.success_criteria[2]).toContain('GSD state');
  });

  it('counts checkboxes from phase plan files', () => {
    const proj = createProject('test-checkboxes');
    writeFile(proj, '.planning/STATE.md', 'Phase: 7\nPlan: 1\nStatus: active\n');
    writeFile(proj, '.planning/ROADMAP.md', '');
    writeFile(proj, '.planning/phases/07-subsystems/plan-a.md', `
- [x] Done item
- [x] Also done
- [ ] Not done
`);
    writeFile(proj, '.planning/phases/07-subsystems/plan-b.md', `
- [x] Third done
- [ ] Still pending
`);

    const state = readGsdState(proj);
    expect(state!.completion).toBe('3/5 requirements met');
  });

  it('returns null when .planning/ does not exist', () => {
    const proj = createProject('test-no-planning');
    expect(readGsdState(proj)).toBeNull();
  });

  it('returns null when STATE.md does not exist', () => {
    const proj = createProject('test-no-state');
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    expect(readGsdState(proj)).toBeNull();
  });

  it('returns null when STATE.md has no parseable phase', () => {
    const proj = createProject('test-bad-state');
    writeFile(proj, '.planning/STATE.md', 'Random content without phase info\n');
    expect(readGsdState(proj)).toBeNull();
  });

  it('handles missing ROADMAP.md gracefully', () => {
    const proj = createProject('test-no-roadmap');
    writeFile(proj, '.planning/STATE.md', 'Phase: 3\nPlan: 1\nStatus: active\n');

    const state = readGsdState(proj);
    expect(state).not.toBeNull();
    expect(state!.phase).toBe(3);
    expect(state!.goal).toBe('');
    expect(state!.success_criteria).toEqual([]);
  });

  it('handles "Phase: N" format (without "of M")', () => {
    const proj = createProject('test-simple-phase');
    writeFile(proj, '.planning/STATE.md', 'Phase: 3\nPlan: 2\nStatus: done\n');
    writeFile(proj, '.planning/ROADMAP.md', '');

    const state = readGsdState(proj);
    expect(state!.phase).toBe(3);
    expect(state!.plan).toBe(2);
  });

  it('is non-throwing on malformed content', () => {
    const proj = createProject('test-malformed');
    writeFile(proj, '.planning/STATE.md', '\0\0\0binary garbage\0\0');
    expect(() => readGsdState(proj)).not.toThrow();
  });
});

describe('parsing helpers', () => {
  it('parseStateMd handles various STATUS formats', () => {
    const proj = createProject('test-status-formats');
    writeFile(proj, '.planning/STATE.md', 'Phase: 6 of 11\nPlan: 2 of 2\nStatus: Phase 6 Complete -- Checkpoint writer done\n');
    writeFile(proj, '.planning/ROADMAP.md', '');

    const state = readGsdState(proj);
    expect(state!.status).toBe('Phase 6 Complete -- Checkpoint writer done');
  });

  it('countCheckboxes counts correctly across multiple files', () => {
    const proj = createProject('test-count');
    writeFile(proj, '.planning/STATE.md', 'Phase: 1\nPlan: 1\nStatus: active\n');
    writeFile(proj, '.planning/ROADMAP.md', '');
    writeFile(proj, '.planning/phases/01-storage/plan1.md', '- [x] A\n- [ ] B\n- [x] C\n');
    writeFile(proj, '.planning/phases/01-storage/plan2.md', '- [ ] D\n- [x] E\n');

    const state = readGsdState(proj);
    expect(state!.completion).toBe('3/5 requirements met');
  });
});
