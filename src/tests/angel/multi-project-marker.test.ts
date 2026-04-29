/**
 * Tests for Phase 4.1 multi-project marker sweep (sidecar table approach).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { updateMultiProjectMarkers } from '../../angel/multi-project-marker.js';

function insertCriticalRule(db: Database.Database, project: string, ruleText: string, source: 'author' | 'system-promoted'): void {
  db.prepare(
    `INSERT INTO critical_rules (project, rule_text, source, drift_risk, base_ttl)
     VALUES (?, ?, ?, 'working-method', 8)`,
  ).run(project, ruleText, source);
}

function getMultiProjectCount(db: Database.Database, project: string, normalizedText: string): number | null {
  const row = db.prepare(
    `SELECT multi_project_count FROM critical_rules_multi_project
     WHERE project = ? AND normalized_rule_text = ?`,
  ).get(project, normalizedText) as { multi_project_count: number } | undefined;
  return row?.multi_project_count ?? null;
}

describe('multi-project-marker (sidecar table)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runMigrations(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('returns 0 when no system-promoted rules exist', () => {
    expect(updateMultiProjectMarkers(db)).toBe(0);
  });

  it('1 system-promoted rule in 1 project → sidecar has multi_project_count=1', () => {
    insertCriticalRule(db, 'p1', 'Always check x', 'system-promoted');
    expect(updateMultiProjectMarkers(db)).toBeGreaterThanOrEqual(1);
    expect(getMultiProjectCount(db, 'p1', 'always check x')).toBe(1);
  });

  it('same normalized rule_text in 2 projects → both get multi_project_count=2', () => {
    insertCriticalRule(db, 'p-a', 'Always check x', 'system-promoted');
    insertCriticalRule(db, 'p-b', 'always Check x.', 'system-promoted'); // case + punct different, normalize-same
    updateMultiProjectMarkers(db);
    expect(getMultiProjectCount(db, 'p-a', 'always check x')).toBe(2);
    expect(getMultiProjectCount(db, 'p-b', 'always check x')).toBe(2);
  });

  it('same rule in 3 projects → all 3 get multi_project_count=3', () => {
    insertCriticalRule(db, 'p-a', 'Always check x', 'system-promoted');
    insertCriticalRule(db, 'p-b', 'always check x', 'system-promoted');
    insertCriticalRule(db, 'p-c', 'Always Check X.', 'system-promoted');
    updateMultiProjectMarkers(db);
    expect(getMultiProjectCount(db, 'p-a', 'always check x')).toBe(3);
    expect(getMultiProjectCount(db, 'p-b', 'always check x')).toBe(3);
    expect(getMultiProjectCount(db, 'p-c', 'always check x')).toBe(3);
  });

  it('author-source rules NOT updated by sweep', () => {
    insertCriticalRule(db, 'p-auth', 'Same rule text', 'author');
    insertCriticalRule(db, 'p-sys', 'Same rule text', 'system-promoted');
    updateMultiProjectMarkers(db);
    expect(getMultiProjectCount(db, 'p-auth', 'same rule text')).toBeNull();
    expect(getMultiProjectCount(db, 'p-sys', 'same rule text')).toBe(1);
  });

  it('different rule_text in 2 projects → each gets multi_project_count=1', () => {
    insertCriticalRule(db, 'p-a', 'Rule A', 'system-promoted');
    insertCriticalRule(db, 'p-b', 'Rule B', 'system-promoted');
    updateMultiProjectMarkers(db);
    expect(getMultiProjectCount(db, 'p-a', 'rule a')).toBe(1);
    expect(getMultiProjectCount(db, 'p-b', 'rule b')).toBe(1);
  });

  it('idempotent: running twice produces same field values', () => {
    insertCriticalRule(db, 'p-a', 'X', 'system-promoted');
    insertCriticalRule(db, 'p-b', 'X', 'system-promoted');
    updateMultiProjectMarkers(db);
    const before = getMultiProjectCount(db, 'p-a', 'x');
    updateMultiProjectMarkers(db);
    const after = getMultiProjectCount(db, 'p-a', 'x');
    expect(before).toBe(2);
    expect(after).toBe(2);
    expect(getMultiProjectCount(db, 'p-b', 'x')).toBe(2);
  });
});
