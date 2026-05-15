/**
 * Tests for Phase 4.1 multi_project_count +2 scoring boost in critical-reminders.
 *
 * Uses the critical_rules_multi_project sidecar table (Plan 07 sidecar
 * fallback). Compatible with both pre-V17 environments (legacy real
 * critical_rules table) and post-V17 (view).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { assembleCriticalReminders } from '../../intelligence/critical-reminders.js';

function normalizeForMultiProject(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"\[\]\{\}\(\)]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function insertCriticalRule(
  db: Database.Database,
  project: string,
  ruleText: string,
  source: 'author' | 'system-promoted',
  multiProjectCount: number | null = null,
): void {
  // In pre-V17 fresh in-memory DB, critical_rules is a real legacy table
  // created by SCHEMA_V3. Insert directly.
  db.prepare(
    `INSERT INTO critical_rules (project, rule_text, source, drift_risk, domain_tags, base_ttl, current_ttl, last_injected_turn, injection_count, violation_count, compliance_count, variants)
     VALUES (?, ?, ?, 'working-method', NULL, 8, NULL, NULL, 0, 0, 0, NULL)`,
  ).run(project, ruleText, source);

  if (multiProjectCount != null) {
    db.prepare(
      `INSERT INTO critical_rules_multi_project (project, normalized_rule_text, multi_project_count, updated_at_epoch)
       VALUES (?, ?, ?, ?)`,
    ).run(project, normalizeForMultiProject(ruleText), multiProjectCount, Math.floor(Date.now() / 1000));
  }
}

describe('critical-reminders multi_project_count boost (Phase 4.1)', () => {
  let db: Database.Database;
  const project = 'cr-mp';

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('rule with multi_project_count=1 → no boost; scored normally', () => {
    insertCriticalRule(db, project, 'Single project rule', 'system-promoted', 1);
    const result = assembleCriticalReminders(db, 'sess', 1, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Single project rule');
    expect(result!.injectedRuleIds.length).toBe(1);
  });

  it('rule with multi_project_count=2 → +2 boost; appears in selected output', () => {
    insertCriticalRule(db, project, 'Multi project rule', 'system-promoted', 2);
    const result = assembleCriticalReminders(db, 'sess', 1, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Multi project rule');
  });

  it('rule with multi_project_count=5 → still +2 (flat boost, not tiered)', () => {
    insertCriticalRule(db, project, 'Low multi', 'system-promoted', 2);
    insertCriticalRule(db, project, 'High multi', 'system-promoted', 5);
    const result = assembleCriticalReminders(db, 'sess', 1, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.injectedRuleIds.length).toBe(2);
  });

  it('rule with no sidecar row (legacy/unswept) → defaults to 1, no boost', () => {
    insertCriticalRule(db, project, 'Legacy rule', 'system-promoted', null);
    const result = assembleCriticalReminders(db, 'sess', 1, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Legacy rule');
  });

  it('end-to-end: multi=2 wins over multi=1 in top-1 ordering', () => {
    insertCriticalRule(db, project, 'Single rule', 'system-promoted', 1);
    insertCriticalRule(db, project, 'Multi rule', 'system-promoted', 2);

    const result = assembleCriticalReminders(db, 'sess', 1, project, false, []);
    expect(result).not.toBeNull();
    // First rendered line after the header should be the multi rule
    // (higher score: 3 + 2 = 5 vs 3).
    const lines = result!.section.split('\n');
    const firstBullet = lines.find(l => l.startsWith('- '));
    expect(firstBullet).toBeDefined();
    expect(firstBullet).toContain('Multi rule');
  });

  it('author-source rules with multi=2 also receive boost (boost is source-agnostic)', () => {
    insertCriticalRule(db, project, 'Author multi rule', 'author', 2);
    const result = assembleCriticalReminders(db, 'sess', 1, project, false, []);
    expect(result).not.toBeNull();
    expect(result!.section).toContain('Author multi rule');
  });
});
