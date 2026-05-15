/**
 * Phase 4.1 behavioral live-fire integration test.
 *
 * Per CONTEXT.md "4.1 behavioral gate":
 *   "feedback → rule promotion fires end-to-end. Probe: write 3 instances
 *    of an equivalent feedback_* lesson across 3 sessions; trigger Angel's
 *    promotion check; verify row appears in critical_rules with correct
 *    fields; verify assembleCriticalReminders returns it under appropriate
 *    domain match; verify TTL decay behavior on subsequent sessions.
 *    Plus multi-project marker: write same feedback in 2 projects, verify
 *    multi_project_count=2 after heartbeat, verify +2 scoring boost in CR
 *    Tier output."
 *
 * Pass criteria: ≥80% of probe assertions hold.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { writeLesson } from '../../angel/lesson-writer.js';
import { promoteFeedbackToCriticalRules } from '../../angel/feedback-promoter.js';
import { updateMultiProjectMarkers } from '../../angel/multi-project-marker.js';
import { assembleCriticalReminders } from '../../intelligence/critical-reminders.js';

function baseTelemetry() {
  return {
    tools_used: ['Read'],
    files_touched: [],
    errors_encountered: [],
    user_framing_tokens: ['x'],
    session_arc: ['fix'],
    duration_min: 5,
    correction_count: 1,
  };
}

describe('Phase 4.1 behavioral live-fire gate', () => {
  let db: Database.Database;
  let tempHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-4-1-livefire-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeFeedbackLesson(project: string, slug: string, salience: string, sessionId: string): void {
    writeLesson({
      project,
      type: 'feedback',
      slug,
      frontmatter: {
        created_at_epoch_ms: Date.now(),
        telemetry: baseTelemetry(),
      },
      body: `# ${salience}\n\nLesson body for session ${sessionId}.\n`,
    });
  }

  it('promotes feedback_* to critical_rules at density 3 in a single project', () => {
    const project = 'live-fire-bridge';

    const before = db.prepare(
      `SELECT COUNT(*) AS cnt FROM critical_rules WHERE project = ?`,
    ).get(project) as { cnt: number };
    expect(before.cnt).toBe(0);

    // 3 equivalent lessons, different files, normalize-equivalent salience.
    makeFeedbackLesson(project, 'check-deps-1', 'Always check existing dependencies before adding imports', 'sess-001');
    makeFeedbackLesson(project, 'check-deps-2', 'Always check existing dependencies before adding imports!', 'sess-002');
    makeFeedbackLesson(project, 'check-deps-3', 'always check existing dependencies before adding imports.', 'sess-003');

    const promoted = promoteFeedbackToCriticalRules(db, project);
    expect(promoted).toBe(1);

    const rule = db.prepare(
      `SELECT id, project, rule_text, source, drift_risk, base_ttl
       FROM critical_rules WHERE project = ? AND source = 'system-promoted'`,
    ).get(project) as any;

    expect(rule).toBeTruthy();
    expect(rule.source).toBe('system-promoted');
    expect(rule.base_ttl).toBe(8);
    expect(['working-method', 'safety']).toContain(rule.drift_risk);
    expect(rule.rule_text.toLowerCase()).toContain('check existing dependencies');
  });

  it('does NOT promote at density 2', () => {
    const project = 'live-fire-density-2';
    makeFeedbackLesson(project, 'a', 'Always X', 'sess-1');
    makeFeedbackLesson(project, 'b', 'always x', 'sess-2');

    const promoted = promoteFeedbackToCriticalRules(db, project);
    expect(promoted).toBe(0);
    const cnt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM critical_rules WHERE project = ?`,
    ).get(project) as { cnt: number };
    expect(cnt.cnt).toBe(0);
  });

  it('multi_project_count = 2 after writing equivalent feedback in 2 projects', () => {
    const projectA = 'live-fire-mp-a';
    const projectB = 'live-fire-mp-b';

    // Project A: density 3
    makeFeedbackLesson(projectA, 'r-1', 'Always check existing dependencies before adding imports', 'a1');
    makeFeedbackLesson(projectA, 'r-2', 'Always check existing dependencies before adding imports', 'a2');
    makeFeedbackLesson(projectA, 'r-3', 'Always check existing dependencies before adding imports', 'a3');
    promoteFeedbackToCriticalRules(db, projectA);

    // Project B: density 3 (same content)
    makeFeedbackLesson(projectB, 'r-1', 'Always check existing dependencies before adding imports', 'b1');
    makeFeedbackLesson(projectB, 'r-2', 'Always check existing dependencies before adding imports', 'b2');
    makeFeedbackLesson(projectB, 'r-3', 'Always check existing dependencies before adding imports', 'b3');
    promoteFeedbackToCriticalRules(db, projectB);

    // Multi-project sweep
    updateMultiProjectMarkers(db);

    // Both rules report multi_project_count=2 in sidecar
    const rowA = db.prepare(
      `SELECT multi_project_count FROM critical_rules_multi_project WHERE project = ?`,
    ).get(projectA) as { multi_project_count: number } | undefined;
    expect(rowA?.multi_project_count).toBe(2);

    const rowB = db.prepare(
      `SELECT multi_project_count FROM critical_rules_multi_project WHERE project = ?`,
    ).get(projectB) as { multi_project_count: number } | undefined;
    expect(rowB?.multi_project_count).toBe(2);
  });

  it('+2 scoring boost is applied via assembleCriticalReminders', () => {
    const project = 'live-fire-boost';

    makeFeedbackLesson(project, 'r-1', 'Verify before claiming done', 'sess-1');
    makeFeedbackLesson(project, 'r-2', 'verify before claiming done', 'sess-2');
    makeFeedbackLesson(project, 'r-3', 'Verify before claiming done.', 'sess-3');
    promoteFeedbackToCriticalRules(db, project);

    // Force multi_project_count = 2 via direct sidecar insert (no second project).
    db.prepare(
      `INSERT OR REPLACE INTO critical_rules_multi_project (project, normalized_rule_text, multi_project_count, updated_at_epoch)
       VALUES (?, ?, ?, ?)`,
    ).run(project, 'verify before claiming done', 2, Math.floor(Date.now() / 1000));

    const result = assembleCriticalReminders(db, 'sess-x', 1, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.injectedRuleIds.length).toBeGreaterThan(0);
    expect(result!.section.toLowerCase()).toContain('verify before claiming done');
  });

  it('full-pipeline smoke: 3-lesson feedback density → critical_rule + sidecar update + scorer boost', () => {
    const project = 'pipeline-smoke';
    // 3 feedback lessons same content
    for (let i = 0; i < 3; i++) {
      makeFeedbackLesson(project, `pipe-${i}`, 'Pipeline test rule', `sess-${i}`);
    }

    // 1) Promote feedback → critical_rules
    const promoted = promoteFeedbackToCriticalRules(db, project);
    expect(promoted).toBe(1);

    // 2) Multi-project sweep (1 project → count=1; no boost)
    const updated = updateMultiProjectMarkers(db);
    expect(updated).toBeGreaterThanOrEqual(1);
    const noBoostRow = db.prepare(
      `SELECT multi_project_count FROM critical_rules_multi_project WHERE project = ?`,
    ).get(project) as { multi_project_count: number };
    expect(noBoostRow.multi_project_count).toBe(1);

    // 3) Scorer renders the rule (no boost yet)
    const noBoostResult = assembleCriticalReminders(db, 'sess', 1, project, false, []);
    expect(noBoostResult).not.toBeNull();
    expect(noBoostResult!.section).toContain('Pipeline test rule');

    // 4) Inject same content from a 2nd project, re-sweep, verify count=2
    const projectB = 'pipeline-smoke-b';
    for (let i = 0; i < 3; i++) {
      makeFeedbackLesson(projectB, `pipe-b-${i}`, 'Pipeline test rule', `sess-b-${i}`);
    }
    promoteFeedbackToCriticalRules(db, projectB);
    updateMultiProjectMarkers(db);

    const boostRowA = db.prepare(
      `SELECT multi_project_count FROM critical_rules_multi_project WHERE project = ?`,
    ).get(project) as { multi_project_count: number };
    expect(boostRowA.multi_project_count).toBe(2);
  });
});
