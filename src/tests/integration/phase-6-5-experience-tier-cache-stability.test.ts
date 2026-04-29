/**
 * Phase 6.5 — Experience Tier cache-stability invariance.
 *
 * Extends Phase 5's CACH-02 pattern: identical assembler inputs MUST
 * produce byte-identical Experience Tier output across runs, even under
 * volatile-state mutation (clock change, session-ID change for unrelated
 * sessions).
 *
 * Why this matters: cache stability is a load-bearing property of the
 * assembler — flaky outputs invalidate cached prefixes and burn tokens.
 * The Experience Tier introduces a new section into the assembled output;
 * if its scoring is non-deterministic, the entire cache breaks.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { assembleExperienceTier } from '../../intelligence/experience-tier.js';
import type { HandleSet } from '../../core/cross-project-equivalence.js';

function makeSeededDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  // Vocab.
  db.prepare(
    `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
       VALUES ('task_shape', 'auth-flow-design', ?, 4),
              ('task_shape', 'scraping-rate-limit-investigation', ?, 5)`
  ).run(Date.now(), Date.now());
  // Sessions.
  db.prepare(`INSERT INTO sessions (session_id, scope, project, status) VALUES ('seed', 'project', 'p', 'active')`).run();
  // Multiple cross-project candidates with overlapping signals.
  const ts = Math.floor(Date.now() / 1000);
  const insertA = db.prepare(
    `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch)
       VALUES (?, 'seed', ?, 'learning', ?, ?, 3, ?)`
  );
  const insertATP = db.prepare(
    `INSERT INTO artifact_task_pattern (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
       VALUES (?, ?, ?, 1.0, 'write_time')`
  );
  insertA.run(1001, 'lacuna-betting', 'Mozzart 429 rate limit shadowban',
              'Decision: per-IP rotation\nOutcome: 429 dropped',
              ts - 1 * 86400);
  insertATP.run(1001, 'scraping-rate-limit-investigation', Date.now());
  insertA.run(1002, 'oracle', 'auth flow login session token',
              'Decision: rotate refresh\nOutcome: stable',
              ts - 2 * 86400);
  insertATP.run(1002, 'auth-flow-design', Date.now());
  insertA.run(1003, 'oracle-2', 'auth flow secondary',
              'Decision: design session\nOutcome: ok',
              ts - 3 * 86400);
  insertATP.run(1003, 'auth-flow-design', Date.now());
  return db;
}

const HANDLES: HandleSet = {
  tools_used: [],
  files_touched: [],
  user_framing_tokens: ['auth', 'flow', 'design', 'rate', 'limit', 'investigation'],
  errors_encountered: [],
};

describe('Phase 6.5 Experience Tier — cache-stability invariance', () => {
  it('two consecutive runs with identical inputs produce byte-identical sections', () => {
    const db = makeSeededDb();
    const r1 = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', HANDLES);
    const r2 = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', HANDLES);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.section).toBe(r2!.section);
    expect(r1!.injectedArtifactIds).toEqual(r2!.injectedArtifactIds);
    expect(r1!.tokenCost).toBe(r2!.tokenCost);
    db.close();
  });

  it('changing the session_id in unrelated sessions does NOT change output', () => {
    const db = makeSeededDb();
    const r1 = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', HANDLES);
    // Pollute session_events with rows from a different session — should not
    // affect 'sess-A' Experience Tier scoring.
    db.prepare(
      `INSERT INTO session_events (session_id, project, event_type, entity, action)
         VALUES ('OTHER-SESSION', 'big-mozzy-v2', 'experience_tier_injected', '1001', 'inject')`
    ).run();
    const r2 = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', HANDLES);
    expect(r1!.section).toBe(r2!.section);
    expect(r1!.injectedArtifactIds).toEqual(r2!.injectedArtifactIds);
    db.close();
  });

  it('tiebreaks are deterministic — identical scores resolve to id ASC', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    db.prepare(
      `INSERT INTO shape_vocabulary (field, value, promoted_at_epoch, promoted_session_count)
         VALUES ('task_shape', 'auth-flow-design', ?, 4)`
    ).run(Date.now());
    db.prepare(`INSERT INTO sessions (session_id, scope, project, status) VALUES ('seed', 'project', 'p', 'active')`).run();
    const ts = Math.floor(Date.now() / 1000);
    // Two artifacts with identical scoring potential.
    db.prepare(
      `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch)
         VALUES (?, 'seed', ?, 'learning', ?, ?, 3, ?)`
    ).run(2002, 'p2', 'auth flow B', 'Decision: design B\nOutcome: ok', ts);
    db.prepare(
      `INSERT INTO artifact_task_pattern (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
         VALUES (?, 'auth-flow-design', ?, 1.0, 'write_time')`
    ).run(2002, Date.now());
    db.prepare(
      `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch)
         VALUES (?, 'seed', ?, 'learning', ?, ?, 3, ?)`
    ).run(2001, 'p1', 'auth flow A', 'Decision: design A\nOutcome: ok', ts);
    db.prepare(
      `INSERT INTO artifact_task_pattern (artifact_id, task_pattern, classified_at_epoch_ms, classifier_confidence, classifier_source)
         VALUES (?, 'auth-flow-design', ?, 1.0, 'write_time')`
    ).run(2001, Date.now());
    const r1 = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      { tools_used: [], files_touched: [], user_framing_tokens: ['auth', 'flow', 'design'], errors_encountered: [] },
    );
    const r2 = assembleExperienceTier(
      db, 'sess', 1, 'big-mozzy-v2',
      { tools_used: [], files_touched: [], user_framing_tokens: ['auth', 'flow', 'design'], errors_encountered: [] },
    );
    expect(r1!.injectedArtifactIds[0]).toBe(2001);
    expect(r1!.section).toBe(r2!.section);
    db.close();
  });

  it('section uses no clock-derived strings — output stable across simulated time advance', () => {
    const db = makeSeededDb();
    const r1 = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', HANDLES);
    // Simulate clock advance by recording it via timestamp_epoch on a NEW
    // unrelated row that wouldn't change any scoring (different project still
    // 'big-mozzy-v2', so it shouldn't surface anyway).
    const farFuture = Math.floor(Date.now() / 1000) + 10 * 365 * 86400;
    db.prepare(
      `INSERT INTO artifacts (id, session_id, project, artifact_type, summary, content, importance, timestamp_epoch)
         VALUES (9999, 'seed', 'big-mozzy-v2', 'learning', 'irrelevant', '', 3, ?)`
    ).run(farFuture);
    const r2 = assembleExperienceTier(db, 'sess-A', 1, 'big-mozzy-v2', HANDLES);
    expect(r1!.section).toBe(r2!.section);
    db.close();
  });
});
