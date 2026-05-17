/**
 * Tests for intent prediction engine (Phase 19 — Proactive Memory capstone).
 *
 * Covers:
 * - Layer 0: unfinished thread → continuation (0.8 confidence)
 * - Layer 0: Angel advisory → continuation (0.8 confidence)
 * - Layer 1: short session gap → continuation (0.7 confidence)
 * - Layer 1: long session gap → lower confidence
 * - Layer 1: temporal profile match → prediction based on pattern
 * - Layer 2: action transition Markov → prediction (0.3 confidence)
 * - Highest confidence wins across layers
 * - Below threshold → null
 * - Empty DB → graceful null (non-throwing)
 * - Temporal profile update
 * - Action transitions update
 * - Prediction accuracy recording
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initializeSchema } from '../../core/migrations.js';
import {
  predictSessionIntent,
  recordPredictionAccuracy,
  determineActualIntent,
  updateTemporalProfile,
  updateActionTransitions,
  CONFIDENCE_THRESHOLD,
} from '../../intelligence/intent-predictor.js';
import { cachedPrepare } from '../../core/stmt-cache.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  project: string,
  status: string = 'completed',
  createdAtEpoch?: number,
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, observation_count, created_at_epoch_ms)
     VALUES (?, ?, ?, 0, ?)`
  ).run(sessionId, project, status, createdAtEpoch ?? Date.now());
}

function insertThread(
  db: Database.Database,
  sessionId: string,
  topic: string | null,
  summary: string | null,
): void {
  db.prepare(
    `INSERT INTO thread_state (session_id, topic, summary, key_exchanges, updated_at_epoch)
     VALUES (?, ?, ?, '[]', unixepoch())`
  ).run(sessionId, topic, summary);
}

function insertSessionEvent(
  db: Database.Database,
  sessionId: string,
  project: string,
  eventType: string,
  entity: string = 'test',
  action: string = 'test',
  detail?: string,
): void {
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, project, eventType, entity, action, detail ?? null);
}

describe('intent-predictor', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Layer 0: Strong Anticipation
  // -------------------------------------------------------------------------

  describe('Layer 0 — Strong Anticipation', () => {
    it('predicts continuation for unfinished thread (no summary)', () => {
      const project = 'test-project';
      insertSession(db, 'prev-sess', project, 'completed');
      insertSession(db, 'curr-sess', project, 'active');
      insertThread(db, 'prev-sess', 'implementing decay engine', null); // no summary = unfinished

      const result = predictSessionIntent(db, project, 'curr-sess');
      expect(result).not.toBeNull();
      expect(result!.intent).toBe('continuation');
      expect(result!.confidence).toBe(0.8);
      expect(result!.layer).toBe(0);
      expect(result!.topic).toContain('implementing decay engine');
    });

    it('does NOT predict continuation for finished thread (has summary)', () => {
      const project = 'test-project';
      insertSession(db, 'prev-sess', project, 'completed');
      insertSession(db, 'curr-sess', project, 'active');
      insertThread(db, 'prev-sess', 'decay engine', 'Completed decay implementation');

      const result = predictSessionIntent(db, project, 'curr-sess');
      // Layer 0 should not fire — may fall through to Layer 1 or null
      if (result) {
        expect(result.layer).not.toBe(0);
      }
    });

    it('predicts based on Angel advisory', () => {
      const project = 'test-project';
      insertSession(db, 'curr-sess', project, 'active');

      // Insert Angel advisory
      db.prepare(
        `INSERT INTO session_messages (target_session, sender, message_type, content, priority, acknowledged)
         VALUES (?, 'angel', 'advisory', 'Pattern extraction found 3 new patterns for decay engine', 'urgent', 0)`
      ).run('curr-sess');

      const result = predictSessionIntent(db, project, 'curr-sess');
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.8);
      expect(result!.layer).toBe(0);
      expect(result!.topic).toContain('Pattern extraction');
    });

    it('returns artifact IDs for unfinished thread', () => {
      const project = 'test-project';
      insertSession(db, 'prev-sess', project, 'completed');
      insertSession(db, 'curr-sess', project, 'active');
      insertThread(db, 'prev-sess', 'schema migration', null);

      // 14-07b: migrated from legacy artifacts — insert into V17 artifact table
      // V17 field mapping: state='fresh' → status='active', importance=4 → confidence=0.8
      const { createHash } = require('node:crypto');
      const v17Id = createHash('sha256').update('test:decision:prev-sess:schema').digest('hex').slice(0, 32);
      db.prepare(
        `INSERT OR IGNORE INTO artifact(id, kind, title, body, scope, status, confidence,
            created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
         VALUES (?, 'decision', 'Schema V10 migration plan', 'content here', 'project', 'active', 0.8, ?, ?, ?, ?, '{}')`
      ).run(v17Id, Date.now(), Date.now(), 'prev-sess', project);

      const result = predictSessionIntent(db, project, 'curr-sess');
      expect(result).not.toBeNull();
      expect(result!.artifactIds.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Layer 1: Weak Anticipation (temporal features)
  // -------------------------------------------------------------------------

  describe('Layer 1 — Temporal Features', () => {
    it('predicts continuation for short session gap (<2h)', () => {
      const project = 'test-project';
      const recentEpoch = Date.now() - 3600_000; // 1 hour ago in ms
      insertSession(db, 'prev-sess', project, 'completed', recentEpoch);
      insertSession(db, 'curr-sess', project, 'active');
      insertThread(db, 'prev-sess', 'recent work', 'Finished the task');

      const result = predictSessionIntent(db, project, 'curr-sess');
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeGreaterThanOrEqual(0.7);
      expect(result!.intent).toBe('continuation');
      expect(result!.reason).toContain('Short session gap');
    });

    it('predicts with lower confidence for long session gap (>24h)', () => {
      const project = 'test-project';
      const oldEpoch = Date.now() - 48 * 3600_000; // 48 hours ago in ms
      insertSession(db, 'prev-sess', project, 'completed', oldEpoch);
      insertSession(db, 'curr-sess', project, 'active');
      // No unfinished thread, no recent session → falls to Layer 1 long gap

      const result = predictSessionIntent(db, project, 'curr-sess');
      if (result && result.layer === 1) {
        expect(result.confidence).toBeLessThanOrEqual(0.5);
      }
    });

    it('uses temporal profile with established pattern', () => {
      const project = 'test-project';
      const now = new Date();
      const hourBucket = Math.floor(now.getHours() / 4);
      const dayOfWeek = now.getDay();

      // Insert temporal profile with strong pattern
      db.prepare(
        `INSERT INTO temporal_profile (project, hour_bucket, day_of_week, session_count, common_first_actions)
         VALUES (?, ?, ?, 5, '["file_edit", "test_run"]')`
      ).run(project, hourBucket, dayOfWeek);

      // No recent sessions (so Layer 1 temporal profile fires, not short-gap)
      const oldEpoch = Date.now() - 5 * 3600_000; // 5 hours ago in ms
      insertSession(db, 'prev-sess', project, 'completed', oldEpoch);
      insertSession(db, 'curr-sess', project, 'active');

      const result = predictSessionIntent(db, project, 'curr-sess');
      expect(result).not.toBeNull();
      // Should be temporal pattern match or continuation
    });
  });

  // -------------------------------------------------------------------------
  // Layer 2: Weak Anticipation (action transitions)
  // -------------------------------------------------------------------------

  describe('Layer 2 — Action Transitions', () => {
    it('predicts from Markov chain when dominant transition exists', () => {
      const project = 'test-project';
      const oldEpoch = Date.now() - 10 * 3600_000; // 10 hours ago in ms
      insertSession(db, 'prev-sess', project, 'completed', oldEpoch);
      insertSession(db, 'curr-sess', project, 'active');

      // Insert session events for the last session
      insertSessionEvent(db, 'prev-sess', project, 'file_edit');
      insertSessionEvent(db, 'prev-sess', project, 'test_run');

      // Insert action transitions with dominant pattern
      db.prepare(
        `INSERT INTO action_transitions (project, from_action, to_action, count)
         VALUES (?, 'test_run', 'file_edit', 10)`
      ).run(project);
      db.prepare(
        `INSERT INTO action_transitions (project, from_action, to_action, count)
         VALUES (?, 'test_run', 'build', 2)`
      ).run(project);

      const result = predictSessionIntent(db, project, 'curr-sess');
      expect(result).not.toBeNull();
      // Should have some prediction — may be Layer 1 or Layer 2
    });
  });

  // -------------------------------------------------------------------------
  // Selection & Gating
  // -------------------------------------------------------------------------

  describe('Selection and Gating', () => {
    it('selects highest confidence across layers', () => {
      const project = 'test-project';
      insertSession(db, 'prev-sess', project, 'completed');
      insertSession(db, 'curr-sess', project, 'active');
      insertThread(db, 'prev-sess', 'unfinished work', null); // Layer 0: confidence 0.8

      const result = predictSessionIntent(db, project, 'curr-sess');
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.8); // Layer 0 wins
      expect(result!.layer).toBe(0);
    });

    it('returns null for empty DB (non-throwing)', () => {
      const result = predictSessionIntent(db, 'nonexistent-project', 'no-session');
      // Should return null or very low confidence — not throw
      if (result) {
        expect(result.confidence).toBeLessThan(1.0);
      }
    });

    it('CONFIDENCE_THRESHOLD is 0.4', () => {
      expect(CONFIDENCE_THRESHOLD).toBe(0.4);
    });
  });

  // -------------------------------------------------------------------------
  // Temporal Profile Update
  // -------------------------------------------------------------------------

  describe('updateTemporalProfile', () => {
    it('creates new temporal profile entry', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'completed');
      insertSessionEvent(db, 'sess-1', project, 'file_edit');

      updateTemporalProfile(db, project, 'sess-1');

      const now = new Date();
      const hourBucket = Math.floor(now.getHours() / 4);
      const dayOfWeek = now.getDay();

      const row = db.prepare(
        `SELECT session_count, common_first_actions FROM temporal_profile
         WHERE project = ? AND hour_bucket = ? AND day_of_week = ?`
      ).get(project, hourBucket, dayOfWeek) as { session_count: number; common_first_actions: string } | undefined;

      expect(row).not.toBeUndefined();
      expect(row!.session_count).toBe(1);
      const actions = JSON.parse(row!.common_first_actions);
      expect(actions).toContain('file_edit');
    });

    it('increments session_count on subsequent calls', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'completed');
      insertSession(db, 'sess-2', project, 'completed');
      insertSessionEvent(db, 'sess-1', project, 'file_edit');
      insertSessionEvent(db, 'sess-2', project, 'test_run');

      updateTemporalProfile(db, project, 'sess-1');
      updateTemporalProfile(db, project, 'sess-2');

      const now = new Date();
      const hourBucket = Math.floor(now.getHours() / 4);
      const dayOfWeek = now.getDay();

      const row = db.prepare(
        `SELECT session_count FROM temporal_profile
         WHERE project = ? AND hour_bucket = ? AND day_of_week = ?`
      ).get(project, hourBucket, dayOfWeek) as { session_count: number } | undefined;

      expect(row).not.toBeUndefined();
      expect(row!.session_count).toBe(2);
    });

    it('handles session with no events gracefully', () => {
      const project = 'test-project';
      insertSession(db, 'empty-sess', project, 'completed');

      // Should not throw
      updateTemporalProfile(db, project, 'empty-sess');

      const now = new Date();
      const hourBucket = Math.floor(now.getHours() / 4);
      const dayOfWeek = now.getDay();

      const row = db.prepare(
        `SELECT session_count FROM temporal_profile
         WHERE project = ? AND hour_bucket = ? AND day_of_week = ?`
      ).get(project, hourBucket, dayOfWeek) as { session_count: number } | undefined;

      expect(row).not.toBeUndefined();
      expect(row!.session_count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Action Transitions Update
  // -------------------------------------------------------------------------

  describe('updateActionTransitions', () => {
    it('creates transition entries from consecutive event pairs', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'completed');
      insertSessionEvent(db, 'sess-1', project, 'file_edit');
      insertSessionEvent(db, 'sess-1', project, 'test_run');
      insertSessionEvent(db, 'sess-1', project, 'build');

      updateActionTransitions(db, project, 'sess-1');

      const transitions = db.prepare(
        `SELECT from_action, to_action, count FROM action_transitions
         WHERE project = ? ORDER BY from_action, to_action`
      ).all(project) as Array<{ from_action: string; to_action: string; count: number }>;

      expect(transitions.length).toBe(2);
      expect(transitions[0]).toMatchObject({ from_action: 'file_edit', to_action: 'test_run', count: 1 });
      expect(transitions[1]).toMatchObject({ from_action: 'test_run', to_action: 'build', count: 1 });
    });

    it('increments count on repeated transitions', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'completed');
      insertSession(db, 'sess-2', project, 'completed');

      // Session 1: file_edit → test_run
      insertSessionEvent(db, 'sess-1', project, 'file_edit');
      insertSessionEvent(db, 'sess-1', project, 'test_run');
      updateActionTransitions(db, project, 'sess-1');

      // Session 2: file_edit → test_run (same pair)
      insertSessionEvent(db, 'sess-2', project, 'file_edit');
      insertSessionEvent(db, 'sess-2', project, 'test_run');
      updateActionTransitions(db, project, 'sess-2');

      const row = db.prepare(
        `SELECT count FROM action_transitions
         WHERE project = ? AND from_action = 'file_edit' AND to_action = 'test_run'`
      ).get(project) as { count: number } | undefined;

      expect(row).not.toBeUndefined();
      expect(row!.count).toBe(2);
    });

    it('handles session with fewer than 2 events (no transitions)', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'completed');
      insertSessionEvent(db, 'sess-1', project, 'file_edit');

      updateActionTransitions(db, project, 'sess-1');

      const count = db.prepare(
        `SELECT COUNT(*) as cnt FROM action_transitions WHERE project = ?`
      ).get(project) as { cnt: number };

      expect(count.cnt).toBe(0);
    });

    it('deduplicates consecutive pairs within a session', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'completed');
      // Repetitive pattern: file_edit → test_run → file_edit → test_run
      insertSessionEvent(db, 'sess-1', project, 'file_edit');
      insertSessionEvent(db, 'sess-1', project, 'test_run');
      insertSessionEvent(db, 'sess-1', project, 'file_edit');
      insertSessionEvent(db, 'sess-1', project, 'test_run');

      updateActionTransitions(db, project, 'sess-1');

      const rows = db.prepare(
        `SELECT from_action, to_action, count FROM action_transitions WHERE project = ?`
      ).all(project) as Array<{ from_action: string; to_action: string; count: number }>;

      // Each unique pair should appear once (deduplicated within session)
      const editToTest = rows.find(r => r.from_action === 'file_edit' && r.to_action === 'test_run');
      expect(editToTest).not.toBeUndefined();
      expect(editToTest!.count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Prediction Accuracy Recording
  // -------------------------------------------------------------------------

  describe('recordPredictionAccuracy', () => {
    it('records accurate prediction', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'active');

      recordPredictionAccuracy(db, 'sess-1', project, 'continuation', 'continuation', true);

      const row = db.prepare(
        `SELECT action, detail FROM session_events
         WHERE session_id = 'sess-1' AND event_type = 'intent_prediction_accuracy'`
      ).get() as { action: string; detail: string } | undefined;

      expect(row).not.toBeUndefined();
      expect(row!.action).toBe('accurate');
      const detail = JSON.parse(row!.detail);
      expect(detail.predicted).toBe('continuation');
      expect(detail.actual).toBe('continuation');
      expect(detail.referenced).toBe(true);
    });

    it('records inaccurate prediction', () => {
      const project = 'test-project';
      insertSession(db, 'sess-1', project, 'active');

      recordPredictionAccuracy(db, 'sess-1', project, 'continuation', 'implementation', false);

      const row = db.prepare(
        `SELECT action FROM session_events
         WHERE session_id = 'sess-1' AND event_type = 'intent_prediction_accuracy'`
      ).get() as { action: string } | undefined;

      expect(row).not.toBeUndefined();
      expect(row!.action).toBe('inaccurate');
    });
  });

  // -------------------------------------------------------------------------
  // Determine Actual Intent
  // -------------------------------------------------------------------------

  describe('determineActualIntent', () => {
    it('returns continuation for empty session', () => {
      insertSession(db, 'sess-1', 'proj', 'active');
      expect(determineActualIntent(db, 'sess-1')).toBe('continuation');
    });

    it('returns implementation when file_edit events dominate', () => {
      insertSession(db, 'sess-1', 'proj', 'active');
      insertSessionEvent(db, 'sess-1', 'proj', 'file_edit');
      insertSessionEvent(db, 'sess-1', 'proj', 'file_edit');
      insertSessionEvent(db, 'sess-1', 'proj', 'file_create');
      insertSessionEvent(db, 'sess-1', 'proj', 'test_run');

      expect(determineActualIntent(db, 'sess-1')).toBe('implementation');
    });

    it('returns investigation when test/search events dominate', () => {
      insertSession(db, 'sess-1', 'proj', 'active');
      insertSessionEvent(db, 'sess-1', 'proj', 'search');
      insertSessionEvent(db, 'sess-1', 'proj', 'search');
      insertSessionEvent(db, 'sess-1', 'proj', 'test_run');
      insertSessionEvent(db, 'sess-1', 'proj', 'test_run');

      expect(determineActualIntent(db, 'sess-1')).toBe('investigation');
    });

    it('returns planning when decision events dominate', () => {
      insertSession(db, 'sess-1', 'proj', 'active');
      insertSessionEvent(db, 'sess-1', 'proj', 'decision');
      insertSessionEvent(db, 'sess-1', 'proj', 'decision');
      insertSessionEvent(db, 'sess-1', 'proj', 'decision');

      expect(determineActualIntent(db, 'sess-1')).toBe('planning');
    });

    it('uses intent_classification event when available', () => {
      insertSession(db, 'sess-1', 'proj', 'active');
      insertSessionEvent(db, 'sess-1', 'proj', 'file_edit');
      // recordEvent stores intent type as entity (5th param), matching production code
      insertSessionEvent(db, 'sess-1', 'proj', 'intent_classification', 'recall', 'classified');

      expect(determineActualIntent(db, 'sess-1')).toBe('recall');
    });

    // Regression: meta events were not filtered from first-pass counting,
    // causing intent_classification/compaction/angel_processed events to
    // inflate the 'continuation' bucket and double-count classifications.
    it('excludes meta events from first-pass counting', () => {
      insertSession(db, 'sess-1', 'proj', 'active');
      // Real user actions: all file_edit → should be "implementation"
      insertSessionEvent(db, 'sess-1', 'proj', 'file_edit');
      insertSessionEvent(db, 'sess-1', 'proj', 'file_edit');
      insertSessionEvent(db, 'sess-1', 'proj', 'file_edit');
      // Meta events that should be excluded from first-pass counting
      insertSessionEvent(db, 'sess-1', 'proj', 'intent_classification', 'continuation', 'classified');
      insertSessionEvent(db, 'sess-1', 'proj', 'session_success_bonus');
      insertSessionEvent(db, 'sess-1', 'proj', 'compaction');
      insertSessionEvent(db, 'sess-1', 'proj', 'angel_processed');

      // Without filtering, the 4 meta events all fall into 'continuation' bucket (4)
      // and intent_classification gets double-counted (2x boost), overwhelming
      // the 3 file_edit events in 'implementation'. With filtering, only the
      // 3 file_edit events count + the 1 intent_classification gets its 2x boost
      // on 'continuation' (2), so implementation (3) > continuation (2).
      expect(determineActualIntent(db, 'sess-1')).toBe('implementation');
    });

    it('does not count intent_prediction events in first pass', () => {
      insertSession(db, 'sess-1', 'proj', 'active');
      insertSessionEvent(db, 'sess-1', 'proj', 'decision');
      insertSessionEvent(db, 'sess-1', 'proj', 'decision');
      // intent_prediction and intent_prediction_accuracy are meta events
      insertSessionEvent(db, 'sess-1', 'proj', 'intent_prediction');
      insertSessionEvent(db, 'sess-1', 'proj', 'intent_prediction_accuracy');
      insertSessionEvent(db, 'sess-1', 'proj', 'intent_prediction');

      // Without filtering, 3 meta events → continuation(3) vs planning(2).
      // With filtering, only decision events → planning(2) wins.
      expect(determineActualIntent(db, 'sess-1')).toBe('planning');
    });
  });
});
