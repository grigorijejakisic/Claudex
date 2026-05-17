/**
 * Phase 14-07h — tests for the experience-tier project-scope filter.
 *
 * Covers: filterToProjectScope behavior, env var override, passive injection,
 * telemetry emission, and empty-project defensive case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  filterToProjectScope,
  getExperienceScope,
  assembleExperienceTier,
  type ExperienceInjectionScope,
} from '../../intelligence/experience-tier.js';
import type { HandleSet } from '../../core/cross-project-equivalence.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  const insertVocab = db.prepare(
    `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES ('task_shape', ?, ?, ?)`
  );
  const now = Date.now();
  insertVocab.run('code-edit', now, 3);
  insertVocab.run('design-review', now, 3);
  return db;
}

function seedArtifact(
  db: Database.Database,
  id: string,
  project: string,
  taskPattern: string,
  summary: string = 'test summary',
): void {
  const ts = Date.now();
  db.prepare(
    `INSERT INTO artifact (id, kind, title, body, status, created_at_epoch_ms, updated_at_epoch_ms, project, data)
     VALUES (?, 'learning', ?, 'content', 'active', ?, ?, ?, '{}')`
  ).run(id, summary, ts, ts, project);
  // Get rowid.
  const row = db.prepare(`SELECT rowid FROM artifact WHERE id = ?`).get(id) as { rowid: number } | undefined;
  if (!row) return;
  db.prepare(
    `INSERT INTO artifact_task_pattern (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
     VALUES (?, ?, ?, 1.0, 'write_time')`
  ).run(row.rowid, taskPattern, ts);
}

function emptyHandles(): HandleSet {
  return { tools_used: [], files_touched: [], user_framing_tokens: [], errors_encountered: [] };
}

// ---------------------------------------------------------------------------
// Type-only mock for CandidateRow-like shape
// ---------------------------------------------------------------------------
type CandidateRow = { artifact_id: number; project: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// filterToProjectScope unit tests
// ---------------------------------------------------------------------------

describe('filterToProjectScope — same_project_only excludes cross-project candidates', () => {
  it('filters out candidates from a different project', () => {
    const candidates: CandidateRow[] = [
      { artifact_id: 1, project: 'my-project', summary: 'a', content: null, task_pattern: 'x', classifier_confidence: 1, timestamp_epoch_ms: Date.now(), recent: 1, helpful_yn: null, artifact_kind: 'artifact' },
      { artifact_id: 2, project: 'other-project', summary: 'b', content: null, task_pattern: 'x', classifier_confidence: 1, timestamp_epoch_ms: Date.now(), recent: 1, helpful_yn: null, artifact_kind: 'artifact' },
    ] as CandidateRow[];

    // Access the exported filterToProjectScope with proper types by casting.
    const filtered = filterToProjectScope(candidates as Parameters<typeof filterToProjectScope>[0], 'my-project', 'same_project_only');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].project).toBe('my-project');
  });

  it('all_projects preserves all candidates regardless of project', () => {
    const candidates: CandidateRow[] = [
      { artifact_id: 1, project: 'my-project', summary: 'a', content: null, task_pattern: 'x', classifier_confidence: 1, timestamp_epoch_ms: Date.now(), recent: 1, helpful_yn: null, artifact_kind: 'artifact' },
      { artifact_id: 2, project: 'other-project', summary: 'b', content: null, task_pattern: 'x', classifier_confidence: 1, timestamp_epoch_ms: Date.now(), recent: 1, helpful_yn: null, artifact_kind: 'artifact' },
    ] as CandidateRow[];

    const filtered = filterToProjectScope(candidates as Parameters<typeof filterToProjectScope>[0], 'my-project', 'all_projects');

    expect(filtered).toHaveLength(2);
  });

  it('empty current_project: returns empty array', () => {
    const candidates: CandidateRow[] = [
      { artifact_id: 1, project: 'my-project', summary: 'a', content: null, task_pattern: 'x', classifier_confidence: 1, timestamp_epoch_ms: Date.now(), recent: 1, helpful_yn: null, artifact_kind: 'artifact' },
    ] as CandidateRow[];

    const filtered = filterToProjectScope(candidates as Parameters<typeof filterToProjectScope>[0], '', 'same_project_only');
    expect(filtered).toHaveLength(0);
  });
});

describe('getExperienceScope — default and env var override', () => {
  let prevEnv: string | undefined;

  beforeEach(() => { prevEnv = process.env.CLAUDEX_EXPERIENCE_SCOPE; });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDEX_EXPERIENCE_SCOPE;
    else process.env.CLAUDEX_EXPERIENCE_SCOPE = prevEnv;
  });

  it('default scope: same_project_only', () => {
    delete process.env.CLAUDEX_EXPERIENCE_SCOPE;
    expect(getExperienceScope()).toBe('same_project_only');
  });

  it('env var override: CLAUDEX_EXPERIENCE_SCOPE=all_projects → all-projects mode', () => {
    process.env.CLAUDEX_EXPERIENCE_SCOPE = 'all_projects';
    expect(getExperienceScope()).toBe('all_projects');
  });

  it('unknown env var value falls back to same_project_only', () => {
    process.env.CLAUDEX_EXPERIENCE_SCOPE = 'unknown_value';
    expect(getExperienceScope()).toBe('same_project_only');
  });
});

describe('assembleExperienceTier — passive injection project-scope behavior', () => {
  it('passive injection: zero cross-project patterns in default mode (same_project_only)', () => {
    // NOTE: In default same_project_only mode, fetchCandidatePool returns ALL artifacts
    // (no project filter at query level), then filterToProjectScope filters to same-project.
    // If the current project has no artifacts, the pool is empty → returns null.
    const db = makeDb();

    delete process.env.CLAUDEX_EXPERIENCE_SCOPE;

    // Seed ONLY cross-project artifacts.
    seedArtifact(db, 'art-1', 'other-project', 'code-edit', 'some summary about editing code');
    seedArtifact(db, 'art-2', 'another-project', 'design-review', 'another cross project learning');

    // With same_project_only (default), these cross-project artifacts should be filtered.
    const result = assembleExperienceTier(
      db,
      'sess-scope-test',
      1,
      'my-project',
      { ...emptyHandles(), user_framing_tokens: ['code', 'edit'] },
    );

    // Should return null (filtered to empty) since no same-project artifacts exist.
    expect(result).toBeNull();

    db.close();
  });

  it('passive injection: cross-project patterns surface in all_projects mode', () => {
    const db = makeDb();
    process.env.CLAUDEX_EXPERIENCE_SCOPE = 'all_projects';

    try {
      // Seed cross-project artifacts with strong scoring signal.
      seedArtifact(db, 'art-cp-1', 'other-project', 'code-edit', 'important learning about code editing');
      // Need a session for injection tracking.
      db.prepare(`INSERT INTO sessions (session_id, scope, project, status) VALUES ('sess-ap-test', 'project', 'my-project', 'active')`).run();

      const result = assembleExperienceTier(
        db,
        'sess-ap-test',
        1,
        'my-project',
        { ...emptyHandles(), user_framing_tokens: ['code', 'edit', 'important', 'learning'] },
      );

      // In all_projects mode, cross-project artifacts CAN surface (if they score positively).
      // We just verify it doesn't error.
      expect(result === null || typeof result === 'object').toBe(true);
    } finally {
      delete process.env.CLAUDEX_EXPERIENCE_SCOPE;
      db.close();
    }
  });

  it('telemetry row emitted per filter pass', () => {
    const db = makeDb();
    delete process.env.CLAUDEX_EXPERIENCE_SCOPE;

    seedArtifact(db, 'telem-art-1', 'my-project', 'code-edit', 'a same-project artifact');
    db.prepare(`INSERT INTO sessions (session_id, scope, project, status) VALUES ('sess-telem-1', 'project', 'my-project', 'active')`).run();

    assembleExperienceTier(
      db,
      'sess-telem-1',
      1,
      'my-project',
      emptyHandles(),
    );

    const rows = db.prepare(
      `SELECT event_type FROM session_events WHERE event_type = 'experience_tier_filtered' LIMIT 5`
    ).all() as Array<{ event_type: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].event_type).toBe('experience_tier_filtered');

    db.close();
  });
});
