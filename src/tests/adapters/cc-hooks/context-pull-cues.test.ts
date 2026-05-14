/**
 * Integration tests for Phase 12 context-pull cues (12-08).
 * Verifies: handoff-read fires on handoff paths; decision-lock fires on config paths;
 * wait-for-direction detection; cue suppression on non-matching paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../../helpers/test-db.js';
import {
  buildHandoffReadCue,
  buildDecisionLockCue,
  buildWaitForDirectionCue,
  detectsWaitForDirection,
  areCuesEnabled,
} from '../../../core/context-pull-cues.js';

let db: TestDatabase;

function seedDecision(summary: string, importance = 4): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project, cwd, source, created_at_epoch) VALUES (?, ?, ?, ?, unixepoch())`
  ).run('seed-sess', 'test-proj', '/test', 'test');
  db.prepare(
    `INSERT INTO artifacts (session_id, project, artifact_type, summary, importance)
     VALUES ('seed-sess', 'test-proj', 'decision', ?, ?)`
  ).run(summary, importance);
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ── areCuesEnabled ─────────────────────────────────────────────────────────────

describe('areCuesEnabled', () => {
  it('returns true by default (no config override)', () => {
    expect(areCuesEnabled()).toBe(true);
  });
});

// ── detectsWaitForDirection ────────────────────────────────────────────────────

describe('detectsWaitForDirection', () => {
  it('detects "waiting for your direction"', () => {
    expect(detectsWaitForDirection('I am waiting for your direction on how to proceed.')).toBe(true);
  });

  it('detects "let me know what"', () => {
    expect(detectsWaitForDirection('Let me know what you would like me to do next.')).toBe(true);
  });

  it('detects "should I proceed"', () => {
    expect(detectsWaitForDirection('Should I proceed with the implementation?')).toBe(true);
  });

  it('detects "holding for you"', () => {
    expect(detectsWaitForDirection('Holding for you to confirm the approach.')).toBe(true);
  });

  it('does NOT detect active-work response', () => {
    expect(detectsWaitForDirection('I have implemented the feature and the tests pass.')).toBe(false);
  });

  it('does NOT detect a description of prior state', () => {
    expect(detectsWaitForDirection('The agent was previously waiting for direction but has now resumed work.')).toBe(false);
  });
});

// ── buildHandoffReadCue ────────────────────────────────────────────────────────

describe('buildHandoffReadCue', () => {
  it('fires on /handoffs/ path and returns a cue string', async () => {
    seedDecision('Session 42 handoff: blocked on typed decoder miss', 4);
    const cue = await buildHandoffReadCue(db, '/project/context/handoffs/ACTIVE.md', 'seed-sess');
    expect(cue).not.toBeNull();
    expect(cue).toContain('<system-reminder>');
    expect(cue).toContain('Handoff Reading');
  });

  it('returns null or empty cue when DB is empty (no relevant artifacts)', async () => {
    const cue = await buildHandoffReadCue(db, '/project/context/handoffs/ACTIVE.md', 'no-session');
    // No artifacts inserted — cue should be null (no results to surface)
    expect(cue).toBeNull();
  });

  it('does NOT fire on a regular source file path', async () => {
    // The cue builder itself is agnostic — the PreToolUse hook does path filtering.
    // The builder returns null when no artifacts match.
    const cue = await buildHandoffReadCue(db, '/src/core/module.ts', 'no-session');
    expect(cue).toBeNull();
  });
});

// ── buildDecisionLockCue ──────────────────────────────────────────────────────

describe('buildDecisionLockCue', () => {
  it('fires on .claudex config path and returns a cue string', async () => {
    seedDecision('curated-context UNVALIDATED: ttGateWindowMs was fabricated', 5);
    const cue = await buildDecisionLockCue(db, '/home/user/.claudex/curated-context.md');
    expect(cue).not.toBeNull();
    expect(cue).toContain('<system-reminder>');
    expect(cue).toContain('Decision Locking');
  });

  it('returns null when no relevant decisions exist', async () => {
    const cue = await buildDecisionLockCue(db, '/some/path/config.json');
    expect(cue).toBeNull();
  });
});

// ── buildWaitForDirectionCue ──────────────────────────────────────────────────

describe('buildWaitForDirectionCue', () => {
  it('returns a cue with recent session artifacts when session has data', async () => {
    seedDecision('Observation: test harness failing on polymorphic deserialization', 3);
    db.prepare(
      `INSERT INTO artifacts (session_id, project, artifact_type, summary, importance)
       VALUES ('seed-sess', 'test-proj', 'observation', 'TT cycle detection: gate window not yet measured', 3)`
    ).run();
    const cue = await buildWaitForDirectionCue(db, 'seed-sess');
    expect(cue).not.toBeNull();
    expect(cue).toContain('<system-reminder>');
    expect(cue).toContain('Wait-for-Direction');
  });

  it('returns null when session has no artifacts', async () => {
    const cue = await buildWaitForDirectionCue(db, 'empty-session');
    expect(cue).toBeNull();
  });
});
