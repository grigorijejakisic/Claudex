/**
 * Tests for Phase 4.1 feedback → critical_rules promotion bridge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { promoteFeedbackToCriticalRules, normalizeRuleText } from '../../angel/feedback-promoter.js';
import { writeLesson } from '../../angel/lesson-writer.js';

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

describe('feedback-promoter', () => {
  let db: Database.Database;
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-promoter-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('normalizeRuleText lowercases and strips punctuation', () => {
    expect(normalizeRuleText('Always check Dependencies, before adding!'))
      .toBe('always check dependencies before adding');
  });

  it.each([0, 1, 2])('returns 0 with %i feedback lessons (below density-3)', (count) => {
    for (let i = 0; i < count; i++) {
      writeLesson({
        project: 'fb-density',
        type: 'feedback',
        slug: `r-${i}`,
        frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() },
        body: '# Rule body\n\nDetail.',
      });
    }
    const promoted = promoteFeedbackToCriticalRules(db, 'fb-density');
    expect(promoted).toBe(0);
  });

  it('3 feedback lessons with same normalized salience → 1 promotion', () => {
    const project = 'fb-3-same';
    writeLesson({ project, type: 'feedback', slug: 'a', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Always check existing dependencies\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'b', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Always check existing dependencies!\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'c', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Always check Existing Dependencies.\n\nbody' });

    const promoted = promoteFeedbackToCriticalRules(db, project);
    expect(promoted).toBe(1);

    const rows = db.prepare(
      `SELECT source, drift_risk, base_ttl, rule_text FROM critical_rules WHERE project = ?`,
    ).all(project) as Array<{ source: string; drift_risk: string; base_ttl: number; rule_text: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('system-promoted');
    expect(rows[0].base_ttl).toBe(8);
    expect(rows[0].drift_risk).toBe('working-method');
    expect(rows[0].rule_text.toLowerCase()).toContain('always check');
  });

  it('safety keywords (verify) trigger drift_risk=safety', () => {
    const project = 'fb-safety';
    writeLesson({ project, type: 'feedback', slug: 'a', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Verify before claiming done\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'b', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# verify before claiming done\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'c', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Verify before claiming done.\n\nbody' });

    promoteFeedbackToCriticalRules(db, project);
    const row = db.prepare(
      `SELECT drift_risk FROM critical_rules WHERE project = ?`,
    ).get(project) as { drift_risk: string };
    expect(row.drift_risk).toBe('safety');
  });

  it('idempotent: running promote twice → 1 then 0', () => {
    const project = 'fb-idem';
    writeLesson({ project, type: 'feedback', slug: 'a', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# X rule\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'b', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# X rule\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'c', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# X rule\n\nbody' });

    expect(promoteFeedbackToCriticalRules(db, project)).toBe(1);
    expect(promoteFeedbackToCriticalRules(db, project)).toBe(0);
  });

  it('3 lessons with different normalized text → 0 promotions', () => {
    const project = 'fb-diff';
    writeLesson({ project, type: 'feedback', slug: 'a', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Rule A\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'b', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Rule B\n\nbody' });
    writeLesson({ project, type: 'feedback', slug: 'c', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Rule C\n\nbody' });

    expect(promoteFeedbackToCriticalRules(db, project)).toBe(0);
  });

  it('empty first-line lessons skipped from grouping', () => {
    const project = 'fb-skip';
    // 1 normal + 2 with empty first lines → no group reaches density 3
    writeLesson({ project, type: 'feedback', slug: 'a', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Real rule\n\nbody' });
    // empty body would fail validation; use whitespace lines
    writeLesson({ project, type: 'feedback', slug: 'b', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '   \n\nactually has content' });
    writeLesson({ project, type: 'feedback', slug: 'c', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '\n\nfirst line indirect' });

    expect(promoteFeedbackToCriticalRules(db, project)).toBe(0);
  });

  it('cross-project isolation: project A lessons do not promote into project B', () => {
    const projectA = 'fb-iso-a';
    const projectB = 'fb-iso-b';
    writeLesson({ project: projectA, type: 'feedback', slug: 'a', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Same rule\n\nbody' });
    writeLesson({ project: projectA, type: 'feedback', slug: 'b', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Same rule\n\nbody' });
    writeLesson({ project: projectA, type: 'feedback', slug: 'c', frontmatter: { created_at_epoch: Date.now(), telemetry: baseTelemetry() }, body: '# Same rule\n\nbody' });

    promoteFeedbackToCriticalRules(db, projectA);
    expect(promoteFeedbackToCriticalRules(db, projectB)).toBe(0);

    const aRows = db.prepare(`SELECT COUNT(*) AS cnt FROM critical_rules WHERE project = ?`).get(projectA) as { cnt: number };
    const bRows = db.prepare(`SELECT COUNT(*) AS cnt FROM critical_rules WHERE project = ?`).get(projectB) as { cnt: number };
    expect(aRows.cnt).toBe(1);
    expect(bRows.cnt).toBe(0);
  });
});
