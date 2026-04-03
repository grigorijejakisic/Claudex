/**
 * Guardian of All Memory — comprehensive tests for the four Guardian modules:
 *   1. retention-sweep.ts
 *   2. data-quality.ts
 *   3. cross-project-consolidator.ts
 *   4. proactive-curator.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
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

// Data quality
import {
  fixZeroObservationSessions,
  cleanOrphanedRecords,
  validateSchemaIntegrity,
  runDataQualityChecks,
  resetQualityCheckRateLimit,
} from '../../angel/data-quality.js';

// Cross-project consolidator
import {
  deduplicateLearnings,
  deduplicateDecisions,
  propagateLearnings,
  resetConsolidationRateLimit,
} from '../../angel/cross-project-consolidator.js';

// Proactive curator
import {
  promoteFrequentlyRetrieved,
  accelerateNeverAccessed,
  archiveAbandonedProjects,
  prepareAwayDigests,
  resetCurationRateLimit,
} from '../../angel/proactive-curator.js';

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

/** Epoch `days` days ago. */
const daysAgo = (days: number) => now() - days * 86_400;

/** Insert a minimal session row. Returns the session_id. */
function insertSession(
  db: Database.Database,
  opts: {
    session_id?: string;
    project?: string;
    status?: string;
    ended_at_epoch?: number | null;
    observation_count?: number;
    created_at_epoch?: number;
  } = {},
): string {
  const session_id = opts.session_id ?? `sess-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO sessions (session_id, project, status, ended_at_epoch, observation_count, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    session_id,
    opts.project ?? 'test-project',
    opts.status ?? 'completed',
    opts.ended_at_epoch ?? now(),
    opts.observation_count ?? 0,
    opts.created_at_epoch ?? now(),
  );
  return session_id;
}

/** Insert an angel_processed event for a session. */
function markAngelProcessed(db: Database.Database, session_id: string, detail = 'ok'): void {
  db.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail, timestamp_epoch)
     VALUES (?, 'test-project', 'angel_processed', 'session', 'processed', ?, ?)`,
  ).run(session_id, detail, now());
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
    `INSERT INTO conversation_turns (session_id, project, user_text, assistant_text, timestamp_epoch)
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
    timestamp_epoch?: number;
    superseded_by?: number | null;
    activation_score?: number;
    artifact_ref?: string | null;
  } = {},
): number {
  const result = db.prepare(
    `INSERT INTO artifacts
       (session_id, project, artifact_type, summary, state, importance, timestamp_epoch,
        superseded_by, activation_score, artifact_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.session_id ?? 'angel',
    opts.project ?? 'test-project',
    opts.artifact_type ?? 'flow',
    opts.summary ?? 'Test artifact',
    opts.state ?? 'fresh',
    opts.importance ?? 3,
    opts.timestamp_epoch ?? now(),
    opts.superseded_by ?? null,
    opts.activation_score ?? 1.0,
    opts.artifact_ref ?? null,
  );
  return result.lastInsertRowid as number;
}

/** Insert a retrieval event for an artifact. */
function insertRetrievalEvent(
  db: Database.Database,
  artifact_id: number,
  was_referenced = 1,
  timestamp_epoch?: number,
): void {
  db.prepare(
    `INSERT INTO retrieval_events (artifact_id, session_id, was_referenced, timestamp_epoch)
     VALUES (?, 'sess-1', ?, ?)`,
  ).run(artifact_id, was_referenced, timestamp_epoch ?? now());
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
       first_seen_epoch, last_promoted_epoch, updated_at_epoch)
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
    timestamp_epoch?: number;
  } = {},
): number {
  const session_id = opts.session_id ?? `sess-${Math.random().toString(36).slice(2)}`;
  // Ensure the session exists (FK constraint)
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'completed')`,
  ).run(session_id, opts.project ?? 'project-a');

  const result = db.prepare(
    `INSERT INTO decisions (session_id, project, content, source, fingerprint, timestamp_epoch)
     VALUES (?, ?, ?, 'explicit', ?, ?)`,
  ).run(
    session_id,
    opts.project ?? 'project-a',
    opts.content ?? 'Some decision',
    opts.fingerprint ?? `fp-${Math.random().toString(36).slice(2)}`,
    opts.timestamp_epoch ?? now(),
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
      const sessId = insertSession(db, { ended_at_epoch: daysAgo(40) });
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
      const sessId = insertSession(db, { ended_at_epoch: daysAgo(100) });
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
      const sessId = insertSession(db, { ended_at_epoch: daysAgo(100) });
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
      const sessId = insertSession(db, { ended_at_epoch: daysAgo(5) });
      markAngelProcessed(db, sessId);
      const turnId = insertTurn(db, sessId);

      pruneConversationTurns(db, config);

      const row = db.prepare(
        `SELECT assistant_text FROM conversation_turns WHERE id = ?`,
      ).get(turnId) as { assistant_text: string | null };
      expect(row.assistant_text).toBe('world');
    });

    it('respects batch limit of 500', () => {
      const sessId = insertSession(db, { ended_at_epoch: daysAgo(100) });
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

  describe('pruneArtifacts', () => {
    it('deletes superseded artifacts older than artifactSupersededDeleteDays', () => {
      // First artifact (the "superseder")
      const newArtId = insertArtifact(db, { importance: 3 });
      // Old superseded artifact
      const oldArtId = insertArtifact(db, {
        importance: 3,
        timestamp_epoch: daysAgo(35),
        superseded_by: newArtId,
      });

      const deleted = pruneArtifacts(db, config);

      expect(deleted).toBeGreaterThanOrEqual(1);
      const row = db.prepare(`SELECT id FROM artifacts WHERE id = ?`).get(oldArtId);
      expect(row).toBeUndefined();
    });

    it('never deletes superseded artifacts with importance >= 5', () => {
      const newArtId = insertArtifact(db, { importance: 5 });
      const importantId = insertArtifact(db, {
        importance: 5,
        timestamp_epoch: daysAgo(35),
        superseded_by: newArtId,
      });

      pruneArtifacts(db, config);

      const row = db.prepare(`SELECT id FROM artifacts WHERE id = ?`).get(importantId);
      expect(row).toBeDefined();
    });

    it('deletes cold packed artifacts older than artifactColdDeleteDays with importance < 3', () => {
      const artId = insertArtifact(db, {
        state: 'packed',
        importance: 2,
        timestamp_epoch: daysAgo(65), // older than coldDeleteDays=60
      });
      // No retrieval events — truly cold

      pruneArtifacts(db, config);

      const row = db.prepare(`SELECT id FROM artifacts WHERE id = ?`).get(artId);
      expect(row).toBeUndefined();
    });

    it('never deletes cold artifacts with importance >= 5 (immune)', () => {
      const artId = insertArtifact(db, {
        state: 'packed',
        importance: 5,
        timestamp_epoch: daysAgo(65),
      });

      pruneArtifacts(db, config);

      const row = db.prepare(`SELECT id FROM artifacts WHERE id = ?`).get(artId);
      expect(row).toBeDefined();
    });
  });

  // ---- pruneSessionJournal ----

  describe('pruneSessionJournal', () => {
    it('deletes flow entries older than journalFlowRetentionDays (60d)', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
         VALUES (?, 'test-project', 'flow', 'some flow', ?)`,
      ).run(sessId, daysAgo(65));

      const deleted = pruneSessionJournal(db, config);

      expect(deleted).toBe(1);
    });

    it('deletes milestone entries older than journalMilestoneRetentionDays (180d)', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
         VALUES (?, 'test-project', 'milestone', 'a milestone', ?)`,
      ).run(sessId, daysAgo(185));

      const deleted = pruneSessionJournal(db, config);

      expect(deleted).toBe(1);
    });

    it('never deletes summary entries', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
         VALUES (?, 'test-project', 'summary', 'session summary', ?)`,
      ).run(sessId, daysAgo(500));

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
        `INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch)
         VALUES (?, 'test-project', 'flow', 'recent flow', ?)`,
      ).run(sessId, daysAgo(10));

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
      const sessId = insertSession(db, { ended_at_epoch: daysAgo(100) });
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

// ---------------------------------------------------------------------------
// 2. Data Quality Tests
// ---------------------------------------------------------------------------

describe('Data Quality', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    resetQualityCheckRateLimit();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  // ---- fixZeroObservationSessions ----

  describe('fixZeroObservationSessions', () => {
    it('deletes stale angel_processed markers so Angel re-processes them', () => {
      const sessId = insertSession(db, {
        status: 'completed',
        observation_count: 0,
      });
      // Insert a conversation turn so the session has "real content"
      insertTurn(db, sessId);
      // Insert the stale angel_processed event with 'too few turns' detail
      db.prepare(
        `INSERT INTO session_events
           (session_id, project, event_type, entity, action, detail, timestamp_epoch)
         VALUES (?, 'test-project', 'angel_processed', 'session', 'processed', 'too few turns', ?)`,
      ).run(sessId, daysAgo(5));

      const queued = fixZeroObservationSessions(db);

      expect(queued).toBe(1);

      // The stale marker should be gone
      const marker = db.prepare(
        `SELECT id FROM session_events
         WHERE session_id = ? AND event_type = 'angel_processed'
           AND detail LIKE '%too few turns%'`,
      ).get(sessId);
      expect(marker).toBeUndefined();
    });

    it('also handles insufficient content detail variant', () => {
      const sessId = insertSession(db, { status: 'completed', observation_count: 0 });
      insertTurn(db, sessId);
      db.prepare(
        `INSERT INTO session_events
           (session_id, project, event_type, entity, action, detail, timestamp_epoch)
         VALUES (?, 'test-project', 'angel_processed', 'session', 'processed', 'insufficient content', ?)`,
      ).run(sessId, now());

      const queued = fixZeroObservationSessions(db);

      expect(queued).toBe(1);
    });

    it('does not touch sessions without a stale marker', () => {
      const sessId = insertSession(db, { status: 'completed', observation_count: 0 });
      insertTurn(db, sessId);
      // No angel_processed event at all

      const queued = fixZeroObservationSessions(db);

      expect(queued).toBe(0);
    });

    it('does not touch sessions that have non-zero observation_count', () => {
      const sessId = insertSession(db, { status: 'completed', observation_count: 5 });
      insertTurn(db, sessId);
      db.prepare(
        `INSERT INTO session_events
           (session_id, project, event_type, entity, action, detail, timestamp_epoch)
         VALUES (?, 'test-project', 'angel_processed', 'session', 'processed', 'too few turns', ?)`,
      ).run(sessId, now());

      const queued = fixZeroObservationSessions(db);

      expect(queued).toBe(0);
    });
  });

  // ---- cleanOrphanedRecords ----

  describe('cleanOrphanedRecords', () => {
    it('deletes session_events referencing non-existent sessions', () => {
      // Insert directly with a dangling session_id (no FK enforcement needed — sessions table is referenced but not FK-constrained in schema)
      db.prepare(
        `INSERT INTO session_events
           (session_id, project, event_type, entity, action, timestamp_epoch)
         VALUES ('ghost-session-999', 'test', 'some_event', 'e', 'a', ?)`,
      ).run(now());

      const deleted = cleanOrphanedRecords(db);

      expect(deleted).toBeGreaterThanOrEqual(1);

      const row = db.prepare(
        `SELECT id FROM session_events WHERE session_id = 'ghost-session-999'`,
      ).get();
      expect(row).toBeUndefined();
    });

    it('deletes conversation_turns referencing non-existent sessions', () => {
      // Insert a turn with no corresponding session (FK is OFF by default for :memory: tests
      // but our helper enforces no FK on conversation_turns directly)
      db.pragma('foreign_keys = OFF');
      db.prepare(
        `INSERT INTO conversation_turns
           (session_id, project, user_text, assistant_text, timestamp_epoch)
         VALUES ('orphan-session', 'test-project', 'hi', 'bye', ?)`,
      ).run(now());
      db.pragma('foreign_keys = ON');

      const deleted = cleanOrphanedRecords(db);

      expect(deleted).toBeGreaterThanOrEqual(1);

      const row = db.prepare(
        `SELECT id FROM conversation_turns WHERE session_id = 'orphan-session'`,
      ).get();
      expect(row).toBeUndefined();
    });

    it('does NOT delete session_events with session_id starting with "angel"', () => {
      // angel* session_ids are synthetic and should be preserved
      db.prepare(
        `INSERT INTO session_events
           (session_id, project, event_type, entity, action, timestamp_epoch)
         VALUES ('angel-guardian', '__global__', 'health_report', 'angel', 'sent', ?)`,
      ).run(now());

      cleanOrphanedRecords(db);

      const row = db.prepare(
        `SELECT id FROM session_events WHERE session_id = 'angel-guardian'`,
      ).get();
      expect(row).toBeDefined();
    });

    it('preserves records for valid sessions', () => {
      const sessId = insertSession(db);
      db.prepare(
        `INSERT INTO session_events
           (session_id, project, event_type, entity, action, timestamp_epoch)
         VALUES (?, 'test-project', 'some_event', 'e', 'a', ?)`,
      ).run(sessId, now());

      const deleted = cleanOrphanedRecords(db);

      const row = db.prepare(
        `SELECT id FROM session_events WHERE session_id = ?`,
      ).get(sessId);
      expect(row).toBeDefined();
    });
  });

  // ---- validateSchemaIntegrity ----

  describe('validateSchemaIntegrity', () => {
    it('returns 0 when table counts are within threshold (no discrepancies)', () => {
      // Empty DB — counts match by definition
      const rebuilt = validateSchemaIntegrity(db);
      expect(rebuilt).toBe(0);
    });

    it('is non-throwing even on an empty database', () => {
      expect(() => validateSchemaIntegrity(db)).not.toThrow();
    });
  });

  // ---- runDataQualityChecks ----

  describe('runDataQualityChecks', () => {
    it('respects rate limiting — second call returns empty result immediately', () => {
      const config1 = { ...config, dataQualityChecks: true, qualityCheckIntervalMinutes: 60 };

      // First run — should actually execute
      const r1 = runDataQualityChecks(db, config1);
      expect(r1).toBeDefined();

      // Seed something that should get cleaned if checks ran again
      db.pragma('foreign_keys = OFF');
      db.prepare(
        `INSERT INTO session_events
           (session_id, project, event_type, entity, action, timestamp_epoch)
         VALUES ('another-ghost', 'test', 'evt', 'e', 'a', ?)`,
      ).run(now());
      db.pragma('foreign_keys = ON');

      // Second call within the interval — should be rate-limited
      const r2 = runDataQualityChecks(db, config1);
      expect(r2.orphaned_records_deleted).toBe(0);
      expect(r2.zero_obs_sessions_queued).toBe(0);
    });

    it('returns empty result when dataQualityChecks is disabled', () => {
      const disabledConfig = { ...config, dataQualityChecks: false };
      const result = runDataQualityChecks(db, disabledConfig);
      expect(result.orphaned_records_deleted).toBe(0);
      expect(result.zero_obs_sessions_queued).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-Project Consolidator Tests
// ---------------------------------------------------------------------------

describe('Cross-Project Consolidator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    resetConsolidationRateLimit();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  // ---- deduplicateLearnings ----

  describe('deduplicateLearnings', () => {
    it('merges identical-fingerprint learnings from 2 projects into __global__', () => {
      const fp = 'shared-fp-abc123';

      insertLearning(db, { project: 'project-a', fingerprint: fp, promotion_count: 2 });
      insertLearning(db, { project: 'project-b', fingerprint: fp, promotion_count: 3 });

      const consolidated = deduplicateLearnings(db);

      expect(consolidated).toBe(1);

      // __global__ record must exist
      const global = db.prepare(
        `SELECT promotion_count FROM learnings WHERE project = '__global__' AND fingerprint = ?`,
      ).get(fp) as { promotion_count: number } | undefined;
      expect(global).toBeDefined();
      // promotion_count should be summed (2 + 3 = 5)
      expect(global!.promotion_count).toBe(5);
    });

    it('deletes per-project copies after merging into __global__', () => {
      const fp = 'dedup-fp-xyz';

      insertLearning(db, { project: 'project-a', fingerprint: fp });
      insertLearning(db, { project: 'project-b', fingerprint: fp });

      deduplicateLearnings(db);

      const perProject = db.prepare(
        `SELECT COUNT(*) AS c FROM learnings WHERE fingerprint = ? AND project != '__global__'`,
      ).get(fp) as { c: number };
      expect(perProject.c).toBe(0);
    });

    it('does not create a duplicate __global__ entry if one already exists', () => {
      const fp = 'already-global-fp';

      // Pre-existing __global__ entry
      insertLearning(db, { project: '__global__', fingerprint: fp, promotion_count: 10 });
      // Two per-project copies
      insertLearning(db, { project: 'project-a', fingerprint: fp, promotion_count: 1 });
      insertLearning(db, { project: 'project-b', fingerprint: fp, promotion_count: 2 });

      deduplicateLearnings(db);

      const count = (
        db.prepare(
          `SELECT COUNT(*) AS c FROM learnings WHERE project = '__global__' AND fingerprint = ?`,
        ).get(fp) as { c: number }
      ).c;
      expect(count).toBe(1); // Still only one __global__ row
    });
  });

  // ---- deduplicateDecisions ----

  describe('deduplicateDecisions', () => {
    it('keeps only the newest decision when fingerprint appears multiple times', () => {
      const fp = 'decision-fp-dup';

      const olderTime = daysAgo(10);
      const newerTime = daysAgo(2);

      const oldId = insertDecision(db, {
        project: 'project-a',
        fingerprint: fp,
        timestamp_epoch: olderTime,
      });
      const newId = insertDecision(db, {
        project: 'project-a',
        fingerprint: fp,
        timestamp_epoch: newerTime,
      });

      const removed = deduplicateDecisions(db);

      expect(removed).toBe(1);

      // Older one should be gone
      const oldRow = db.prepare(`SELECT id FROM decisions WHERE id = ?`).get(oldId);
      expect(oldRow).toBeUndefined();

      // Newer one must survive
      const newRow = db.prepare(`SELECT id FROM decisions WHERE id = ?`).get(newId);
      expect(newRow).toBeDefined();
    });

    it('returns 0 when no duplicates exist', () => {
      insertDecision(db, { fingerprint: 'unique-fp-1' });
      insertDecision(db, { fingerprint: 'unique-fp-2' });

      const removed = deduplicateDecisions(db);
      expect(removed).toBe(0);
    });
  });

  // ---- propagateLearnings ----

  describe('propagateLearnings', () => {
    it('copies learnings with promotion_count >= 5 to __global__', () => {
      const fp = 'high-promo-fp';

      insertLearning(db, { project: 'project-a', fingerprint: fp, promotion_count: 5 });

      const promoted = propagateLearnings(db);

      expect(promoted).toBe(1);

      const global = db.prepare(
        `SELECT id FROM learnings WHERE project = '__global__' AND fingerprint = ?`,
      ).get(fp);
      expect(global).toBeDefined();
    });

    it('does not duplicate if __global__ version already exists', () => {
      const fp = 'already-in-global';

      // Already in __global__
      insertLearning(db, { project: '__global__', fingerprint: fp, promotion_count: 8 });
      // High-promo per-project copy
      insertLearning(db, { project: 'project-a', fingerprint: fp, promotion_count: 6 });

      const promoted = propagateLearnings(db);

      expect(promoted).toBe(0); // Should not re-insert

      const count = (
        db.prepare(
          `SELECT COUNT(*) AS c FROM learnings WHERE project = '__global__' AND fingerprint = ?`,
        ).get(fp) as { c: number }
      ).c;
      expect(count).toBe(1); // Still just one
    });

    it('ignores learnings with promotion_count < 5', () => {
      insertLearning(db, { project: 'project-a', fingerprint: 'low-promo', promotion_count: 4 });

      const promoted = propagateLearnings(db);
      expect(promoted).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Proactive Curator Tests
// ---------------------------------------------------------------------------

describe('Proactive Curator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    resetCurationRateLimit();
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  // ---- promoteFrequentlyRetrieved ----

  describe('promoteFrequentlyRetrieved', () => {
    it('promotes artifact importance to 4 when it has 10+ was_referenced events in last 30 days', () => {
      const artId = insertArtifact(db, { importance: 2 });

      // Insert 10 retrieval events with was_referenced=1 within last 30 days
      for (let i = 0; i < 10; i++) {
        insertRetrievalEvent(db, artId, 1, daysAgo(1));
      }

      const promoted = promoteFrequentlyRetrieved(db);

      expect(promoted).toBe(1);

      const row = db.prepare(`SELECT importance FROM artifacts WHERE id = ?`).get(artId) as {
        importance: number;
      };
      expect(row.importance).toBe(4);
    });

    it('does not promote when fewer than 10 retrieval events', () => {
      const artId = insertArtifact(db, { importance: 2 });

      for (let i = 0; i < 5; i++) {
        insertRetrievalEvent(db, artId, 1, daysAgo(1));
      }

      const promoted = promoteFrequentlyRetrieved(db);
      expect(promoted).toBe(0);
    });

    it('never promotes importance to 5 (reserved tier)', () => {
      const artId = insertArtifact(db, { importance: 3 });

      for (let i = 0; i < 15; i++) {
        insertRetrievalEvent(db, artId, 1, daysAgo(1));
      }

      promoteFrequentlyRetrieved(db);

      const row = db.prepare(`SELECT importance FROM artifacts WHERE id = ?`).get(artId) as {
        importance: number;
      };
      // Should be 4, never 5
      expect(row.importance).toBeLessThanOrEqual(4);
    });

    it('does not promote already-at-4 artifacts', () => {
      const artId = insertArtifact(db, { importance: 4 });

      for (let i = 0; i < 15; i++) {
        insertRetrievalEvent(db, artId, 1, daysAgo(1));
      }

      const promoted = promoteFrequentlyRetrieved(db);
      expect(promoted).toBe(0);
    });
  });

  // ---- accelerateNeverAccessed ----

  describe('accelerateNeverAccessed', () => {
    it('halves activation_score for packed artifacts older than 30d with no retrieval events', () => {
      const artId = insertArtifact(db, {
        state: 'packed',
        importance: 2,
        activation_score: 0.8,
        timestamp_epoch: daysAgo(35),
      });

      const decayed = accelerateNeverAccessed(db);

      expect(decayed).toBe(1);

      const row = db.prepare(
        `SELECT activation_score FROM artifacts WHERE id = ?`,
      ).get(artId) as { activation_score: number };
      expect(row.activation_score).toBeCloseTo(0.4, 5);
    });

    it('does not decay artifacts that have retrieval events', () => {
      const artId = insertArtifact(db, {
        state: 'packed',
        importance: 2,
        activation_score: 0.8,
        timestamp_epoch: daysAgo(35),
      });
      insertRetrievalEvent(db, artId, 1, daysAgo(5));

      const decayed = accelerateNeverAccessed(db);

      expect(decayed).toBe(0);

      const row = db.prepare(
        `SELECT activation_score FROM artifacts WHERE id = ?`,
      ).get(artId) as { activation_score: number };
      expect(row.activation_score).toBeCloseTo(0.8, 5);
    });

    it('skips fresh artifacts (packed but recently created)', () => {
      const artId = insertArtifact(db, {
        state: 'packed',
        importance: 2,
        activation_score: 0.8,
        timestamp_epoch: daysAgo(10), // under 30 days
      });

      const decayed = accelerateNeverAccessed(db);
      expect(decayed).toBe(0);

      const row = db.prepare(
        `SELECT activation_score FROM artifacts WHERE id = ?`,
      ).get(artId) as { activation_score: number };
      expect(row.activation_score).toBeCloseTo(0.8, 5);
    });

    it('skips importance >= 4 artifacts (user/angel-pinned)', () => {
      const artId = insertArtifact(db, {
        state: 'packed',
        importance: 4,
        activation_score: 0.8,
        timestamp_epoch: daysAgo(35),
      });

      const decayed = accelerateNeverAccessed(db);
      expect(decayed).toBe(0);
    });
  });

  // ---- archiveAbandonedProjects ----

  describe('archiveAbandonedProjects', () => {
    it('packs artifacts for projects with no sessions in last abandonedProjectDays days', () => {
      const project = 'abandoned-proj';
      // Session that ended long ago
      insertSession(db, {
        project,
        status: 'completed',
        created_at_epoch: daysAgo(35),
      });
      const artId = insertArtifact(db, {
        project,
        state: 'fresh',
        importance: 3,
      });

      const archived = archiveAbandonedProjects(db, config);

      expect(archived).toBe(1);

      const row = db.prepare(
        `SELECT state FROM artifacts WHERE id = ?`,
      ).get(artId) as { state: string };
      expect(row.state).toBe('packed');
    });

    it('never packs importance >= 5 artifacts even in abandoned project', () => {
      const project = 'abandoned-important';
      insertSession(db, {
        project,
        status: 'completed',
        created_at_epoch: daysAgo(35),
      });
      const importantId = insertArtifact(db, {
        project,
        state: 'fresh',
        importance: 5,
      });

      archiveAbandonedProjects(db, config);

      const row = db.prepare(
        `SELECT state FROM artifacts WHERE id = ?`,
      ).get(importantId) as { state: string };
      expect(row.state).toBe('fresh'); // untouched
    });

    it('does not archive active projects (with recent sessions)', () => {
      const project = 'active-proj';
      insertSession(db, {
        project,
        status: 'active',
        created_at_epoch: daysAgo(1),
      });
      const artId = insertArtifact(db, {
        project,
        state: 'fresh',
        importance: 3,
      });

      const archived = archiveAbandonedProjects(db, config);

      // active-proj is not abandoned
      const row = db.prepare(
        `SELECT state FROM artifacts WHERE id = ?`,
      ).get(artId) as { state: string };
      expect(row.state).toBe('fresh');
    });
  });

  // ---- prepareAwayDigests ----

  describe('prepareAwayDigests', () => {
    it('creates a digest artifact for a project away 4+ days but active in last 30 days', () => {
      const awayProject = 'away-project';

      // Old session — project "went away" 5 days ago
      insertSession(db, {
        project: awayProject,
        created_at_epoch: daysAgo(5),
        status: 'completed',
      });

      // Another project with recent decisions
      const otherProject = 'other-project';
      const otherSessId = insertSession(db, {
        project: otherProject,
        created_at_epoch: daysAgo(1),
        status: 'completed',
      });
      db.prepare(
        `INSERT INTO decisions (session_id, project, content, source, fingerprint, timestamp_epoch)
         VALUES (?, ?, 'Do X instead of Y', 'explicit', 'fp-decision-digest', ?)`,
      ).run(otherSessId, otherProject, daysAgo(1));

      const prepared = prepareAwayDigests(db);

      expect(prepared).toBeGreaterThanOrEqual(1);

      const digest = db.prepare(
        `SELECT id FROM artifacts
         WHERE project = ? AND session_id = 'angel' AND summary LIKE 'Away-digest%'`,
      ).get(awayProject);
      expect(digest).toBeDefined();
    });

    it('does not create a duplicate digest if one already exists within 3 days', () => {
      const awayProject = 'no-dup-project';

      insertSession(db, {
        project: awayProject,
        created_at_epoch: daysAgo(5),
        status: 'completed',
      });

      // Insert cross-project data to ensure digest would be created
      const otherSessId = insertSession(db, {
        project: 'other-source',
        created_at_epoch: daysAgo(1),
        status: 'completed',
      });
      db.prepare(
        `INSERT INTO decisions (session_id, project, content, source, fingerprint, timestamp_epoch)
         VALUES (?, 'other-source', 'Decision content', 'explicit', 'fp-nodedup', ?)`,
      ).run(otherSessId, daysAgo(1));

      const first = prepareAwayDigests(db);
      expect(first).toBeGreaterThanOrEqual(1);

      // Second call — should be deduplicated (digest already exists within 3d)
      const second = prepareAwayDigests(db);
      expect(second).toBe(0);
    });

    it('does nothing for projects with no cross-project content to report', () => {
      const awayProject = 'away-empty';

      insertSession(db, {
        project: awayProject,
        created_at_epoch: daysAgo(5),
        status: 'completed',
      });

      // No decisions or learnings in other projects within 3 days
      const prepared = prepareAwayDigests(db);
      expect(prepared).toBe(0);
    });
  });
});
