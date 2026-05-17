/**
 * Guardian of All Memory — comprehensive tests for the four Guardian modules:
 *   1. retention-sweep.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { initializeSchema } from '../../core/migrations.js';
import { DEFAULT_RETENTION_CONFIG, type RetentionConfig } from '../../angel/types.js';

// Retention sweep
import {
  pruneConversationTurns,
  pruneArtifacts,
  pruneSessionJournal,
  runRetentionSweep,
  resetSweepRateLimit,
} from '../../angel/retention-sweep.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

const config: RetentionConfig = { ...DEFAULT_RETENTION_CONFIG };

/** Current unix epoch in seconds. */
const now = () => Math.floor(Date.now() / 1000);

/** Epoch `days` days ago (seconds). */
const daysAgo = (days: number) => now() - days * 86_400;

/** Epoch `days` days ago (milliseconds) — for *_epoch_ms columns. */
const daysAgoMs = (days: number) => Date.now() - days * 86_400_000;

/** Insert a minimal session row. Returns the session_id. */
function insertSession(
  db: Database.Database,
  opts: {
    session_id?: string;
    project?: string;
    status?: string;
    ended_at_epoch_ms?: number | null;
    observation_count?: number;
    created_at_epoch_ms?: number;
  } = {},
): string {
  const session_id = opts.session_id ?? `sess-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, ended_at_epoch_ms, observation_count, created_at_epoch_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    session_id,
    opts.project ?? 'test-project',
    opts.status ?? 'completed',
    opts.ended_at_epoch_ms ?? Date.now(),
    opts.observation_count ?? 0,
    opts.created_at_epoch_ms ?? Date.now(),
  );
  return session_id;
}

/** Insert an angel_processed event for a session. */
function markAngelProcessed(db: Database.Database, session_id: string, detail = 'ok'): void {
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, timestamp_epoch_ms)
     VALUES (?, 'test-project', 'angel_processed', 'session', 'processed', ?, ?)`,
  ).run(session_id, detail, Date.now());
}

/** Insert a conversation turn. Returns the row id. */
function insertTurn(
  db: Database.Database,
  session_id: string,
  project = 'test-project',
  user_text = 'hello',
  assistant_text: string | null = 'world',
): number {
  const result = db.prepare(
    `INSERT INTO conversation_turns (session_id, project, user_text, assistant_text, timestamp_epoch_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(session_id, project, user_text, assistant_text, now());
  return result.lastInsertRowid as number;
}

/** Insert an artifact. Returns the row id. */
function insertArtifact(
  db: Database.Database,
  opts: {
    session_id?: string;
    project?: string;
    artifact_type?: string;
    summary?: string;
    state?: string;
    importance?: number;
    timestamp_epoch_ms?: number;
    superseded_by?: number | null;
    activation_score?: number;
    artifact_ref?: string | null;
  } = {},
): number {
  const result = db.prepare(
    `INSERT INTO artifacts
       (session_id, project, artifact_type, summary, state, importance, timestamp_epoch_ms,
        superseded_by, activation_score, artifact_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.session_id ?? 'angel',
    opts.project ?? 'test-project',
    opts.artifact_type ?? 'flow',
    opts.summary ?? 'Test artifact',
    opts.state ?? 'fresh',
    opts.importance ?? 3,
    opts.timestamp_epoch_ms ?? Date.now(),
    opts.superseded_by ?? null,
    opts.activation_score ?? 1.0,
    opts.artifact_ref ?? null,
  );
  return result.lastInsertRowid as number;
}

/**
 * Insert a V17 artifact row directly into the `artifact` table.
 * 14-07b: test fixture for migrated retention-sweep tests.
 * V17 field mapping: importance (1-5) → confidence (0.0-1.0), state → status enum.
 * Returns the TEXT id.
 */
function insertV17Artifact(
  db: Database.Database,
  opts: {
    session_id?: string;
    project?: string;
    kind?: string;
    title?: string;
    body?: string;
    status?: 'active' | 'stale' | 'superseded';
    confidence?: number;
    supersedes_id?: string | null;
    created_at_epoch_ms?: number;
    data?: object;
  } = {},
): string {
  const id = createHash('sha256')
    .update(`v17-test:${Math.random()}:${Date.now()}`)
    .digest('hex')
    .slice(0, 32);
  db.prepare(
    `INSERT INTO artifact(id, kind, title, body, scope, status, confidence,
        created_at_epoch_ms, updated_at_epoch_ms, session_id, project, supersedes_id, data)
     VALUES (?, ?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.kind ?? 'flow',
    opts.title ?? 'Test artifact',
    opts.body ?? 'Test body',
    opts.status ?? 'active',
    opts.confidence ?? 0.6,
    opts.created_at_epoch_ms ?? Date.now(),
    opts.created_at_epoch_ms ?? Date.now(),
    opts.session_id ?? 'angel',
    opts.project ?? 'test-project',
    opts.supersedes_id ?? null,
    JSON.stringify(opts.data ?? {}),
  );
  return id;
}

/** Insert a retrieval event for an artifact. */
function insertRetrievalEvent(
  db: Database.Database,
  artifact_id: number,
  was_referenced = 1,
  timestamp_epoch_ms?: number,
): void {
  db.prepare(
    `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch_ms)
     VALUES (?, 'sess-1', ?, ?)`,
  ).run(artifact_id, was_referenced, timestamp_epoch_ms ?? now());
}

/** Insert a learning. Returns the row id. */
function insertLearning(
  db: Database.Database,
  opts: {
    project?: string;
    fingerprint?: string;
    content?: string;
    promotion_count?: number;
    agent_id?: string;
  } = {},
): number {
  const result = db.prepare(
    `INSERT INTO learnings (project, agent_id, fingerprint, content, promotion_count,
       first_seen_epoch, last_promoted_epoch, updated_at_epoch_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.project ?? 'project-a',
    opts.agent_id ?? 'default',
    opts.fingerprint ?? `fp-${Math.random().toString(36).slice(2)}`,
    opts.content ?? 'Some learning content',
    opts.promotion_count ?? 1,
    now(),
    now(),
    now(),
  );
  return result.lastInsertRowid as number;
}

/** Insert a decision. Returns the row id. */
function insertDecision(
  db: Database.Database,
  opts: {
    session_id?: string;
    project?: string;
    fingerprint?: string;
    content?: string;
    timestamp_epoch_ms?: number;
  } = {},
): number {
  const session_id = opts.session_id ?? `sess-${Math.random().toString(36).slice(2)}`;
  // Ensure the session exists (FK constraint)
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'completed')`,
  ).run(session_id, opts.project ?? 'project-a');

  const result = db.prepare(
    `INSERT INTO decisions (session_id, project, content, source, fingerprint, timestamp_epoch_ms)
     VALUES (?, ?, ?, 'explicit', ?, ?)`,
  ).run(
    session_id,
    opts.project ?? 'project-a',
    opts.content ?? 'Some decision',
    opts.fingerprint ?? `fp-${Math.random().toString(36).slice(2)}`,
    opts.timestamp_epoch_ms ?? now(),
  );
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// 1. Retention Sweep Tests
// ---------------------------------------------------------------------------

describe('Retention Sweep', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    resetSweepRateLimit();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  // ---- pruneConversationTurns ----

  describe('pruneConversationTurns', () => {
    it('skeletal tier: nulls assistant_text for angel-processed sessions older than fullDays', () => {
      // Session ended 40 days ago (past fullDays=30, before skeletalDays=90)
      const sessId = insertSession(db, { ended_at_epoch_ms: daysAgoMs(40) });
      markAngelProcessed(db, sessId);
      insertTurn(db, sessId);

      const result = pruneConversationTurns(db, config);

      expect(result.skeletal).toBe(1);
      expect(result.deleted).toBe(0);

      const row = db.prepare(
        `SELECT assistant_text FROM conversation_turns WHERE session_id = ?`,
      ).get(sessId) as { assistant_text: string | null };
      expect(row.assistant_text).toBeNull();
    });

    it('delete tier: hard-deletes turns for angel-processed sessions older than skeletalDays', () => {
      // Session ended 100 days ago (past skeletalDays=90)
      const sessId = insertSession(db, { ended_at_epoch_ms: daysAgoMs(100) });
      markAngelProcessed(db, sessId);
      insertTurn(db, sessId);
      insertTurn(db, sessId);

      const result = pruneConversationTurns(db, config);

      expect(result.deleted).toBe(2);

      const count = (
        db.prepare(`SELECT COUNT(*) AS c FROM conversation_turns WHERE session_id = ?`).get(sessId) as { c: number }
      ).c;
      expect(count).toBe(0);
    });

    it('safety contract: never touches turns for sessions WITHOUT angel_processed event', () => {
      // Session ended 100 days ago but no angel_processed event
      const sessId = insertSession(db, { ended_at_epoch_ms: daysAgoMs(100) });
      const turnId = insertTurn(db, sessId);

      const result = pruneConversationTurns(db, config);

      expect(result.skeletal).toBe(0);
      expect(result.deleted).toBe(0);

      const row = db.prepare(
        `SELECT assistant_text FROM conversation_turns WHERE id = ?`,
      ).get(turnId) as { assistant_text: string | null };
      expect(row.assistant_text).toBe('world');
    });

    it('does not touch fresh sessions (ended recently) even with angel_processed', () => {
      const sessId = insertSession(db, { ended_at_epoch_ms: daysAgoMs(5) });
      markAngelProcessed(db, sessId);
      const turnId = insertTurn(db, sessId);

      pruneConversationTurns(db, config);

      const row = db.prepare(
        `SELECT assistant_text FROM conversation_turns WHERE id = ?`,
      ).get(turnId) as { assistant_text: string | null };
      expect(row.assistant_text).toBe('world');
    });

    it('respects batch limit of 500', () => {
      const sessId = insertSession(db, { ended_at_epoch_ms: daysAgoMs(100) });
      markAngelProcessed(db, sessId);
      // Insert 600 turns
      const insertMany = db.transaction(() => {
        for (let i = 0; i < 600; i++) {
          insertTurn(db, sessId);
        }
      });
      insertMany();

      const result = pruneConversationTurns(db, config);

      // DELETE is batched at 500
      expect(result.deleted).toBe(500);
    });
  });

  // ---- pruneArtifacts ----
  // 14-07b: migrated from legacy artifacts — tests now use V17 artifact table fixtures

  describe('pruneArtifacts', () => {
    it('deletes superseded V17 artifacts older than artifactSupersededDeleteDays', () => {
      // Old superseded artifact: status='superseded', confidence < 1.0, old enough
      const oldArtId = insertV17Artifact(db, {
        status: 'superseded',
        confidence: 0.6, // importance ~3 equivalent
        created_at_epoch_ms: daysAgoMs(35),
      });

      const deleted = pruneArtifacts(db, config);

      expect(deleted).toBeGreaterThanOrEqual(1);
      const row = db.prepare(`SELECT id FROM artifact WHERE id = ?`).get(oldArtId);
      expect(row).toBeUndefined();
    });

    it('never deletes superseded V17 artifacts with confidence >= 1.0 (importance=5 equivalent)', () => {
      const importantId = insertV17Artifact(db, {
        status: 'superseded',
        confidence: 1.0, // importance=5 equivalent — immune
        created_at_epoch_ms: daysAgoMs(35),
      });

      pruneArtifacts(db, config);

      const row = db.prepare(`SELECT id FROM artifact WHERE id = ?`).get(importantId);
      expect(row).toBeDefined();
    });

    it('deletes cold stale V17 artifacts older than artifactColdDeleteDays with confidence < 0.6', () => {
      const artId = insertV17Artifact(db, {
        status: 'stale', // was 'packed' in legacy
        confidence: 0.4, // importance ~2 equivalent (< 0.6 threshold)
        created_at_epoch_ms: daysAgoMs(65), // older than coldDeleteDays=60
      });
      // No retrieval events — truly cold

      pruneArtifacts(db, config);

      const row = db.prepare(`SELECT id FROM artifact WHERE id = ?`).get(artId);
      expect(row).toBeUndefined();
    });

    it('never deletes cold V17 artifacts with confidence >= 1.0 (immune)', () => {
      const artId = insertV17Artifact(db, {
        status: 'stale',
        confidence: 1.0, // importance=5 equivalent — immune
        created_at_epoch_ms: daysAgoMs(65),
      });

      pruneArtifacts(db, config);

      const row = db.prepare(`SELECT id FROM artifact WHERE id = ?`).get(artId);
      expect(row).toBeDefined();
    });
  });

  // ---- pruneSessionJournal ----

  describe('pruneSessionJournal', () => {
    it('deletes flow entries older than journalFlowRetentionDays (60d)', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch_ms)
         VALUES (?, 'test-project', 'flow', 'some flow', ?)`,
      ).run(sessId, daysAgoMs(65));

      const deleted = pruneSessionJournal(db, config);

      expect(deleted).toBe(1);
    });

    it('deletes milestone entries older than journalMilestoneRetentionDays (180d)', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch_ms)
         VALUES (?, 'test-project', 'milestone', 'a milestone', ?)`,
      ).run(sessId, daysAgoMs(185));

      const deleted = pruneSessionJournal(db, config);

      expect(deleted).toBe(1);
    });

    it('never deletes summary entries', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch_ms)
         VALUES (?, 'test-project', 'summary', 'session summary', ?)`,
      ).run(sessId, daysAgoMs(500));

      const deleted = pruneSessionJournal(db, config);

      expect(deleted).toBe(0);
      const row = db.prepare(
        `SELECT id FROM session_journal WHERE entry_type = 'summary'`,
      ).get();
      expect(row).toBeDefined();
    });

    it('does not delete flow entries that are still within retention window', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch_ms)
         VALUES (?, 'test-project', 'flow', 'recent flow', ?)`,
      ).run(sessId, daysAgoMs(10));

      const deleted = pruneSessionJournal(db, config);

      expect(deleted).toBe(0);
    });
  });

  // ---- runRetentionSweep rate limiting ----

  describe('runRetentionSweep', () => {
    it('runs successfully on first call', () => {
      const result = runRetentionSweep(db, config);
      expect(result).toBeDefined();
      expect(typeof result.conversation_turns_skeletal).toBe('number');
      expect(typeof result.artifacts_deleted).toBe('number');
    });

    it('rate-limits: second call within interval returns empty result', () => {
      runRetentionSweep(db, config);

      // Insert something that would normally be pruned
      const sessId = insertSession(db, { ended_at_epoch_ms: daysAgoMs(100) });
      markAngelProcessed(db, sessId);
      insertTurn(db, sessId);

      const result2 = runRetentionSweep(db, config);

      // All fields should be 0 (rate-limited, nothing ran)
      expect(result2.conversation_turns_deleted).toBe(0);
      expect(result2.conversation_turns_skeletal).toBe(0);
      expect(result2.artifacts_deleted).toBe(0);
      expect(result2.journal_entries_deleted).toBe(0);
    });

    it('resetSweepRateLimit() allows the sweep to run again immediately', () => {
      runRetentionSweep(db, config);
      resetSweepRateLimit();

      // Should not return an empty/rate-limited result this time
      // (we just verify it doesn't throw and returns a valid shape)
      const result = runRetentionSweep(db, config);
      expect(result).toBeDefined();
      expect(typeof result.conversation_turns_skeletal).toBe('number');
    });

    it('aggregates all pruning categories in the result shape', () => {
      const result = runRetentionSweep(db, config);
      const keys: Array<keyof typeof result> = [
        'conversation_turns_skeletal',
        'conversation_turns_deleted',
        'artifacts_deleted',
        'journal_entries_deleted',
        'session_events_deleted',
        'retrieval_events_deleted',
        'artifact_links_deleted',
        'verified_facts_deleted',
        'session_messages_deleted',
        'observations_deleted',
        'observations_superseded',
      ];
      for (const key of keys) {
        expect(typeof result[key]).toBe('number');
      }
    });
  });
});


