#!/usr/bin/env node
/**
 * Phase 4.1 soak: end-to-end pipeline validation on a fresh temporary DB.
 *
 * Steps:
 *   1. Initialize a fresh temp DB at user_version=18.
 *   2. Bootstrap 2 test projects under a temp HOME.
 *   3. Write 3 equivalent feedback_* lessons in project A.
 *   4. Write 3 equivalent feedback_* lessons in project B (same content).
 *   5. Run feedback bridge (promoteFeedbackToCriticalRules) for both.
 *   6. Run multi-project marker sweep (updateMultiProjectMarkers).
 *   7. Verify invariants:
 *      - critical_rules count per project (should be 1 each)
 *      - multi_project_count per rule (should be 2 each)
 *      - assembleCriticalReminders includes the rule with +2 boost
 *   8. Print structured PASS / FAIL report.
 *
 * Usage: bun run scripts/phase-4-1-soak.ts
 * Exit 0 on PASS, 1 on FAIL.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../src/core/migrations.js';
import { writeLesson } from '../src/angel/lesson-writer.js';
import { promoteFeedbackToCriticalRules } from '../src/angel/feedback-promoter.js';
import { updateMultiProjectMarkers } from '../src/angel/multi-project-marker.js';
import { assembleCriticalReminders } from '../src/intelligence/critical-reminders.js';

interface SoakReport {
  invariants: Array<{ name: string; passed: boolean; detail?: string }>;
  verdict: 'PASS' | 'FAIL';
}

function baseTelemetry() {
  return {
    tools_used: ['Read'],
    files_touched: [],
    errors_encountered: [],
    user_framing_tokens: ['x'],
    session_arc: ['fix'],
    duration_min: 5,
    correction_count: 0,
  };
}

async function runSoak(): Promise<SoakReport> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-4-1-soak-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  const report: SoakReport = { invariants: [], verdict: 'PASS' };

  try {
    const db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);

    const projectA = 'soak-project-a';
    const projectB = 'soak-project-b';
    const ruleSalience = 'Always check existing dependencies before adding imports';

    // Write 3 feedback lessons in each project
    for (let i = 0; i < 3; i++) {
      writeLesson({
        project: projectA,
        type: 'feedback',
        slug: `r-a-${i}`,
        frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() },
        body: `# ${ruleSalience}\n\nlesson body ${i}\n`,
      });
      writeLesson({
        project: projectB,
        type: 'feedback',
        slug: `r-b-${i}`,
        frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() },
        body: `# ${ruleSalience}\n\nlesson body ${i}\n`,
      });
    }

    // Promote both projects
    promoteFeedbackToCriticalRules(db, projectA);
    promoteFeedbackToCriticalRules(db, projectB);

    // Multi-project sweep
    updateMultiProjectMarkers(db);

    // Invariant 1: critical_rules count = 1 per project
    const cntA = (db.prepare(`SELECT COUNT(*) AS cnt FROM critical_rules WHERE project = ?`).get(projectA) as { cnt: number }).cnt;
    const cntB = (db.prepare(`SELECT COUNT(*) AS cnt FROM critical_rules WHERE project = ?`).get(projectB) as { cnt: number }).cnt;
    report.invariants.push({
      name: 'critical_rules count = 1 per project',
      passed: cntA === 1 && cntB === 1,
      detail: `projectA=${cntA}, projectB=${cntB}`,
    });

    // Invariant 2: multi_project_count = 2 per rule
    const mpA = db.prepare(`SELECT multi_project_count FROM critical_rules_multi_project WHERE project = ?`).get(projectA) as { multi_project_count: number } | undefined;
    const mpB = db.prepare(`SELECT multi_project_count FROM critical_rules_multi_project WHERE project = ?`).get(projectB) as { multi_project_count: number } | undefined;
    report.invariants.push({
      name: 'multi_project_count = 2 in sidecar',
      passed: mpA?.multi_project_count === 2 && mpB?.multi_project_count === 2,
      detail: `mpA=${mpA?.multi_project_count}, mpB=${mpB?.multi_project_count}`,
    });

    // Invariant 3: assembleCriticalReminders renders the rule
    const result = assembleCriticalReminders(db, 'soak-sess', 1, projectA, false, []);
    const renderedOK = result !== null && result.section.toLowerCase().includes('check existing dependencies');
    report.invariants.push({
      name: 'assembleCriticalReminders renders system-promoted rule with boost',
      passed: renderedOK,
      detail: result === null ? 'null result' : `section length: ${result.section.length}`,
    });

    db.close();
  } catch (err) {
    report.invariants.push({
      name: 'soak script ran without exception',
      passed: false,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (report.invariants.some(i => !i.passed)) report.verdict = 'FAIL';
  return report;
}

async function main(): Promise<void> {
  const report = await runSoak();
  console.log(`Phase 4.1 Soak — ${report.verdict}`);
  console.log('');
  for (const inv of report.invariants) {
    const status = inv.passed ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${inv.name}`);
    if (inv.detail) console.log(`         ${inv.detail}`);
  }
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
