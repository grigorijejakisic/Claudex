/**
 * Claudex v2 -- Phase Transition Handler Tests
 *
 * TDD tests for src/gsd/phase-transition.ts.
 * RED phase: this suite is added before module implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { upsertPressureScore } from '../../src/db/pressure.js';
import { storeObservation } from '../../src/db/observations.js';
import {
  handlePhaseStart,
  handlePhaseEnd,
  handlePlanComplete,
} from '../../src/gsd/phase-transition.js';

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface HandlerResult {
  success: boolean;
  message: string;
}

interface PhaseTransitionArgs {
  db: Database.Database;
  projectDir: string;
  projectName: string;
  phaseNumber: number;
}

interface PlanCompleteArgs extends PhaseTransitionArgs {
  planNumber: number;
  sessionId: string;
}

let tmpDir: string;
let db: Database.Database;

function setupDb(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const runner = new MigrationRunner(database);
  runner.run();
  return database;
}

function writeGsdFiles(projectDir: string, opts?: { phase?: number; plan?: number }): void {
  const phase = opts?.phase ?? 6;
  const plan = opts?.plan ?? 1;
  const planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  const stateContent = `# Project State

Phase: ${phase} of 8 (Phase Transition Hooks)
Plan: ${plan} of 2
Status: Executing
`;
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf-8');

  const roadmapContent = `# Roadmap

## Phase 5: Cross-Phase Intelligence
**Goal**: Cross-phase pattern detection
**Depends on**: Phase 4
**Requirements**: SUMM-03
**Success Criteria**:
  1. Cross-phase summary exists

## Phase 6: Phase Transition Hooks
**Goal**: Lifecycle handlers
**Depends on**: Phase 5
**Requirements**: LIFE-01, LIFE-02, LIFE-03
**Success Criteria**:
  1. Handlers execute correctly
`;
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmapContent, 'utf-8');

  fs.mkdirSync(path.join(planningDir, 'phases', '05-cross-phase-intelligence'), { recursive: true });
  fs.mkdirSync(path.join(planningDir, 'phases', '06-phase-transition-hooks'), { recursive: true });
}

function writePlanFile(
  projectDir: string,
  phaseDirName: string,
  planNum: number,
  filesModified: string[],
): void {
  const phaseDir = path.join(projectDir, '.planning', 'phases', phaseDirName);
  fs.mkdirSync(phaseDir, { recursive: true });

  const paddedPhase = phaseDirName.slice(0, 2);
  const paddedPlan = String(planNum).padStart(2, '0');
  const filename = `${paddedPhase}-${paddedPlan}-PLAN.md`;

  let content = '---\n';
  content += `phase: ${phaseDirName}\n`;
  content += `plan: ${paddedPlan}\n`;
  content += 'files_modified:\n';
  for (const file of filesModified) {
    content += `  - ${file}\n`;
  }
  content += '---\n\n';
  content += '# Plan\n';

  fs.writeFileSync(path.join(phaseDir, filename), content, 'utf-8');
}

function writePhaseSummaryForPatterns(
  projectDir: string,
  phaseDirName: string,
  planNum: number,
  filePath: string,
): void {
  const phaseDir = path.join(projectDir, '.planning', 'phases', phaseDirName);
  fs.mkdirSync(phaseDir, { recursive: true });

  const paddedPhase = phaseDirName.slice(0, 2);
  const paddedPlan = String(planNum).padStart(2, '0');
  const filename = `${paddedPhase}-${paddedPlan}-SUMMARY.md`;

  const content = `---
phase: ${phaseDirName}
plan: ${paddedPlan}
key-files:
  modified:
    - ${filePath}
---

# Summary
`;

  fs.writeFileSync(path.join(phaseDir, filename), content, 'utf-8');
}

function writeSessionLog(claudexDir: string, decision: string): void {
  const sessionsDir = path.join(claudexDir, 'context', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const content = `---
schema: claudex/session-log
version: 1
handoff_id: claudex-v2-gsd-phase6
---

## Decisions Made
- ${decision}
`;
  fs.writeFileSync(path.join(sessionsDir, '2026-02-27_session-1.md'), content, 'utf-8');
}

function createSummary(projectDir: string, content: string): string {
  const contextDir = path.join(projectDir, '.planning', 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  const summaryPath = path.join(contextDir, 'SUMMARY.md');
  fs.writeFileSync(summaryPath, content, 'utf-8');
  return summaryPath;
}

function makeArgs(overrides: Partial<PhaseTransitionArgs> = {}): PhaseTransitionArgs {
  return {
    db,
    projectDir: tmpDir,
    projectName: 'project-a',
    phaseNumber: 6,
    ...overrides,
  };
}

function makePlanCompleteArgs(overrides: Partial<PlanCompleteArgs> = {}): PlanCompleteArgs {
  return {
    ...makeArgs(),
    planNumber: 1,
    sessionId: 'session-06-01',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-phase-transition-'));
  db = setupDb();
  writeGsdFiles(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handlePhaseStart', () => {
  it('1. aggressively decays all project pressure scores by 0.1x with reclassification', () => {
    upsertPressureScore(db, {
      file_path: 'src/hot.ts',
      project: 'project-a',
      raw_pressure: 0.9,
      temperature: 'HOT',
      decay_rate: 0.05,
    });
    upsertPressureScore(db, {
      file_path: 'src/warm.ts',
      project: 'project-a',
      raw_pressure: 0.5,
      temperature: 'WARM',
      decay_rate: 0.05,
    });
    upsertPressureScore(db, {
      file_path: 'src/cold.ts',
      project: 'project-a',
      raw_pressure: 0.2,
      temperature: 'COLD',
      decay_rate: 0.05,
    });

    const result = handlePhaseStart(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const rows = db.prepare(`
      SELECT file_path, raw_pressure, temperature
      FROM pressure_scores
      WHERE project = ?
      ORDER BY file_path ASC
    `).all('project-a') as Array<{ file_path: string; raw_pressure: number; temperature: string }>;

    expect(rows).toHaveLength(3);
    expect(rows[0]!.raw_pressure).toBeCloseTo(0.02, 5);
    expect(rows[1]!.raw_pressure).toBeCloseTo(0.09, 5);
    expect(rows[2]!.raw_pressure).toBeCloseTo(0.05, 5);
    expect(rows.every(r => r.temperature === 'COLD')).toBe(true);
  });

  it('2. recalculates temperature after decay (no stale labels)', () => {
    upsertPressureScore(db, {
      file_path: 'src/max.ts',
      project: 'project-a',
      raw_pressure: 1.0,
      temperature: 'HOT',
      decay_rate: 0.05,
    });

    const result = handlePhaseStart(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const row = db.prepare(`
      SELECT raw_pressure, temperature
      FROM pressure_scores
      WHERE file_path = ? AND project = ?
    `).get('src/max.ts', 'project-a') as { raw_pressure: number; temperature: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.raw_pressure).toBeCloseTo(0.1, 5);
    expect(row!.temperature).toBe('COLD');
  });

  it('3. archives current SUMMARY.md using previous phase number and slug', () => {
    createSummary(tmpDir, '# Existing Summary\n');

    const result = handlePhaseStart(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    const archivePath = path.join(
      tmpDir,
      '.planning',
      'context',
      'archive',
      '05-cross-phase-intelligence.md',
    );

    expect(fs.existsSync(summaryPath)).toBe(false);
    expect(fs.existsSync(archivePath)).toBe(true);
  });

  it('4. seeds pressure from previous phase archive table entries (+0.3)', () => {
    const archiveDir = path.join(tmpDir, '.planning', 'context', 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, '05-cross-phase-intelligence.md'),
      `# Phase Summary

## Phase-Relevant Files

| File | Pressure | Temp |
|------|----------|------|
| \`src/gsd/types.ts\` | 0.80 | HOT |
| \`src/gsd/state-reader.ts\` | 0.55 | WARM |
`,
      'utf-8',
    );

    const result = handlePhaseStart(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const seeded = db.prepare(`
      SELECT file_path, raw_pressure, temperature
      FROM pressure_scores
      WHERE project = ?
      ORDER BY file_path ASC
    `).all('project-a') as Array<{ file_path: string; raw_pressure: number; temperature: string }>;

    expect(seeded).toHaveLength(2);
    expect(seeded[0]!.file_path).toBe('src/gsd/state-reader.ts');
    expect(seeded[0]!.raw_pressure).toBeCloseTo(0.3, 5);
    expect(seeded[0]!.temperature).toBe('WARM');
    expect(seeded[1]!.file_path).toBe('src/gsd/types.ts');
    expect(seeded[1]!.raw_pressure).toBeCloseTo(0.3, 5);
    expect(seeded[1]!.temperature).toBe('WARM');
  });

  it('5. handles first phase without previous archive gracefully', () => {
    writeGsdFiles(tmpDir, { phase: 1, plan: 1 });

    const result = handlePhaseStart(makeArgs({ phaseNumber: 1 })) as HandlerResult;
    expect(result.success).toBe(true);
  });

  it('6. decays only scores belonging to the provided project', () => {
    upsertPressureScore(db, {
      file_path: 'src/a.ts',
      project: 'project-a',
      raw_pressure: 0.9,
      temperature: 'HOT',
      decay_rate: 0.05,
    });
    upsertPressureScore(db, {
      file_path: 'src/b.ts',
      project: 'project-b',
      raw_pressure: 0.9,
      temperature: 'HOT',
      decay_rate: 0.05,
    });

    const result = handlePhaseStart(makeArgs({ projectName: 'project-a' })) as HandlerResult;
    expect(result.success).toBe(true);

    const a = db.prepare('SELECT raw_pressure FROM pressure_scores WHERE project = ?').get('project-a') as { raw_pressure: number };
    const b = db.prepare('SELECT raw_pressure FROM pressure_scores WHERE project = ?').get('project-b') as { raw_pressure: number };
    expect(a.raw_pressure).toBeCloseTo(0.09, 5);
    expect(b.raw_pressure).toBeCloseTo(0.9, 5);
  });

  it('7. never throws on DB errors and returns failure result', () => {
    const brokenDb = new Database(':memory:');
    brokenDb.close();

    let result: HandlerResult | undefined;
    expect(() => {
      result = handlePhaseStart(makeArgs({ db: brokenDb }));
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect(typeof result!.message).toBe('string');
  });
});

describe('handlePhaseEnd', () => {
  it('8. writes fresh phase summary even when SUMMARY.md is newer than debounce window', () => {
    createSummary(tmpDir, '# Fresh summary that should be replaced\n');

    const result = handlePhaseEnd(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const archiveDir = path.join(tmpDir, '.planning', 'context', 'archive');
    const archived = fs.readdirSync(archiveDir).find(f => f.startsWith('06-') && f.endsWith('.md'));
    expect(archived).toBeDefined();

    const archivedContent = fs.readFileSync(path.join(archiveDir, archived!), 'utf-8');
    expect(archivedContent).toContain('# Phase Summary');
    expect(archivedContent).not.toContain('Fresh summary that should be replaced');
  });

  it('9. archives phase summary with phase-based filename', () => {
    const result = handlePhaseEnd(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const archivePath = path.join(
      tmpDir,
      '.planning',
      'context',
      'archive',
      '06-phase-transition-hooks.md',
    );
    expect(fs.existsSync(archivePath)).toBe(true);
  });

  it('10. soft-deletes only observations inside phase timespan for same project', () => {
    const now = Date.now();

    const archiveDir = path.join(tmpDir, '.planning', 'context', 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const prevArchive = path.join(archiveDir, '05-cross-phase-intelligence.md');
    fs.writeFileSync(prevArchive, '# prev\n', 'utf-8');
    const phaseStart = now - 60_000;
    fs.utimesSync(prevArchive, new Date(phaseStart), new Date(phaseStart));

    storeObservation(db, {
      session_id: 's1',
      project: 'project-a',
      timestamp: new Date(now - 120_000).toISOString(),
      timestamp_epoch: now - 120_000,
      tool_name: 'Read',
      category: 'discovery',
      title: 'before-phase',
      content: '',
      importance: 3,
    });
    storeObservation(db, {
      session_id: 's1',
      project: 'project-a',
      timestamp: new Date(now - 30_000).toISOString(),
      timestamp_epoch: now - 30_000,
      tool_name: 'Read',
      category: 'discovery',
      title: 'during-phase',
      content: '',
      importance: 3,
    });
    storeObservation(db, {
      session_id: 's2',
      project: 'project-b',
      timestamp: new Date(now - 30_000).toISOString(),
      timestamp_epoch: now - 30_000,
      tool_name: 'Read',
      category: 'discovery',
      title: 'other-project',
      content: '',
      importance: 3,
    });

    const result = handlePhaseEnd(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const before = db.prepare('SELECT deleted_at_epoch FROM observations WHERE title = ?').get('before-phase') as { deleted_at_epoch: number | null };
    const during = db.prepare('SELECT deleted_at_epoch FROM observations WHERE title = ?').get('during-phase') as { deleted_at_epoch: number | null };
    const other = db.prepare('SELECT deleted_at_epoch FROM observations WHERE title = ?').get('other-project') as { deleted_at_epoch: number | null };

    expect(before.deleted_at_epoch).toBeNull();
    expect(during.deleted_at_epoch).not.toBeNull();
    expect(other.deleted_at_epoch).toBeNull();
  });

  it('11. handles absence of observations gracefully', () => {
    const result = handlePhaseEnd(makeArgs()) as HandlerResult;
    expect(result.success).toBe(true);
  });

  it('12. never throws and returns failure result on unrecoverable errors', () => {
    const brokenDb = new Database(':memory:');
    brokenDb.close();

    let result: HandlerResult | undefined;
    expect(() => {
      result = handlePhaseEnd(makeArgs({ db: brokenDb }));
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
  });
});

describe('handlePlanComplete', () => {
  it('13. writes checkpoint with plan-complete trigger', () => {
    const result = handlePlanComplete(makePlanCompleteArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const checkpointsDir = path.join(tmpDir, 'context', 'checkpoints');
    const files = fs.readdirSync(checkpointsDir).filter(f => f.endsWith('.yaml') && f !== 'latest.yaml');
    expect(files.length).toBeGreaterThan(0);

    const latest = files.sort()[files.length - 1]!;
    const checkpoint = yaml.load(
      fs.readFileSync(path.join(checkpointsDir, latest), 'utf-8'),
      { schema: yaml.JSON_SCHEMA },
    ) as { meta?: { trigger?: string } };

    expect(checkpoint.meta?.trigger).toBe('plan-complete');
  });

  it('14. re-scores pressure using next plan relevance set', () => {
    writePlanFile(tmpDir, '06-phase-transition-hooks', 1, ['src/current-plan.ts']);
    writePlanFile(tmpDir, '06-phase-transition-hooks', 2, ['src/next-plan.ts']);

    upsertPressureScore(db, {
      file_path: 'src/next-plan.ts',
      project: 'project-a',
      raw_pressure: 0.5,
      temperature: 'WARM',
      decay_rate: 0.05,
    });

    const result = handlePlanComplete(makePlanCompleteArgs({ planNumber: 1 })) as HandlerResult;
    expect(result.success).toBe(true);

    const row = db.prepare(`
      SELECT raw_pressure, temperature
      FROM pressure_scores
      WHERE file_path = ? AND project = ?
    `).get('src/next-plan.ts', 'project-a') as { raw_pressure: number; temperature: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.raw_pressure).toBeGreaterThan(0.5);
    expect(row!.temperature).toBe('HOT');
  });

  it('15. refreshes SUMMARY.md by bypassing debounce', () => {
    createSummary(tmpDir, '# Fresh summary that should be replaced\n');

    const result = handlePlanComplete(makePlanCompleteArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    const content = fs.readFileSync(summaryPath, 'utf-8');
    expect(content).toContain('# Phase Summary');
    expect(content).not.toContain('Fresh summary that should be replaced');
  });

  it('16. updates CROSS-PHASE.md', () => {
    writePhaseSummaryForPatterns(tmpDir, '01-state-reader', 1, 'src/gsd/types.ts');
    writePhaseSummaryForPatterns(tmpDir, '02-context-injection', 1, 'src/gsd/types.ts');
    writeSessionLog(path.join(tmpDir, 'Claudex'), 'Use phased transitions');

    const result = handlePlanComplete(makePlanCompleteArgs()) as HandlerResult;
    expect(result.success).toBe(true);

    const crossPhasePath = path.join(tmpDir, '.planning', 'context', 'CROSS-PHASE.md');
    expect(fs.existsSync(crossPhasePath)).toBe(true);
  });

  it('17. never throws and returns failure result on unrecoverable errors', () => {
    const badProjectDir = path.join(tmpDir, '\u0000invalid');

    let result: HandlerResult | undefined;
    expect(() => {
      result = handlePlanComplete(makePlanCompleteArgs({ projectDir: badProjectDir }));
    }).not.toThrow();

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
  });
});
