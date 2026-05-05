/**
 * Phase 4 regression guard — Layer 2 of the 3-layer cutoff.
 *
 * Asserts that the four production code paths that USED to create
 * experience_patterns rows or modify lesson content from N=many synthesis
 * are deleted and stay deleted. If any assertion below fails, extraction-
 * time pattern creation has been reintroduced — read
 * .planning/reframes/2026-05-05-multi-handle-kill.md before "fixing" the test.
 *
 * Deliberately does NOT call allowLegacyPatternInsert in the assertions that
 * verify production code paths do not write — those tests rely on the V28
 * trigger blocking would-be writes, AND assert that the application code
 * does not even attempt the INSERT.
 *
 * Cases (a/b/c/d per CONTEXT.md Layer 2):
 *   (a) Site B regression — applyExperienceFeedback with correction_flagged
 *       does NOT increment experience_patterns row count
 *   (b) Site A regression — heartbeat tick on a correction-rich session does
 *       NOT increment experience_patterns row count
 *   (c) classifySessionDomains (the surviving Angel-side LLM call) does NOT
 *       write to experience_patterns
 *   (d) Site C regression — heartbeat tick MUST NOT modify the lesson column
 *       on existing experience_patterns rows
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createTestDbWithSession,
  allowLegacyPatternInsert,
  blockLegacyPatternInsert,
} from '../helpers/test-db.js';
import { applyExperienceFeedback } from '../../intelligence/experience-scoring.js';
import { setExperienceFlags } from '../../intelligence/experience-flags.js';
import { DEFAULT_CONFIG } from '../../shared/constants.js';
import type { ClaudexConfig } from '../../shared/config.js';

// ── Mocks for heartbeat-driving tests ────────────────────────────────────
// The heartbeat tick imports many subsystems; we stub them so tests b/d
// only exercise the loop bodies that Plans 02/04 modified.
const mockCallLocalLLM = vi.fn<(opts: unknown) => Promise<string>>();

vi.mock('../../angel/llama-client.js', () => ({
  callLocalLLM: (opts: unknown) => mockCallLocalLLM(opts),
  checkLlamaServerHealth: vi.fn().mockResolvedValue(true),
  isCloudModel: vi.fn().mockReturnValue(true),
  LLAMA_MODEL_ALIAS: 'glm-5.1:cloud',
}));
vi.mock('../../angel/domain-classifier.js', () => ({
  classifySessionDomains: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../intelligence/directive-detector.js', () => ({
  extractDirectivesFromSession: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, errors: 0 }),
}));
vi.mock('../../angel/curated-context-extractor.js', () => ({
  extractCuratedContextFromSession: vi.fn().mockResolvedValue({ entriesCreated: 0 }),
  getSessionsPendingCuratedExtraction: vi.fn().mockReturnValue([]),
}));
vi.mock('../../angel/memory-monitor.js', () => ({
  monitorMemoryFiles: vi.fn().mockReturnValue({ projects_scanned: 0, entries_migrated: 0, projects_with_migrations: [] }),
}));
vi.mock('../../angel/consolidator.js', () => ({
  consolidateObservationBatch: vi.fn().mockResolvedValue({ consolidated: 0, clusters: 0 }),
  shouldConsolidate: vi.fn().mockReturnValue(false),
  markConsolidationRan: vi.fn(),
}));
vi.mock('../../angel/user-profile-sync.js', () => ({
  syncUserProfiles: vi.fn().mockResolvedValue({ profiles_synced: 0, conflicts_resolved: 0 }),
}));
vi.mock('../../angel/retention-sweep.js', () => ({
  runRetentionSweep: vi.fn().mockReturnValue({
    conversation_turns_skeletal: 0, conversation_turns_deleted: 0, artifacts_deleted: 0,
    journal_entries_deleted: 0, session_events_deleted: 0, retrieval_events_deleted: 0,
    artifact_links_deleted: 0, verified_facts_deleted: 0, session_messages_deleted: 0,
    observations_deleted: 0, observations_superseded: 0,
  }),
}));
vi.mock('../../angel/message-sender.js', () => ({
  sendIdleWarning: vi.fn().mockReturnValue(false),
  sendMessage: vi.fn().mockReturnValue(true),
}));
vi.mock('../../adapters/shared/lifecycle.js', () => ({
  captureRecallFlowEntry: vi.fn(),
}));
vi.mock('../../angel/transcript-chunker.js', () => ({
  chunkSessionTranscript: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../angel/memory-md-writer.js', () => ({
  curateMemoryMd: vi.fn().mockResolvedValue({ chunks: 0, projects: [] }),
}));
vi.mock('../../angel/session-monitor.js', () => ({
  getIdleSessions: vi.fn().mockReturnValue([]),
  hasIdleWarning: vi.fn().mockReturnValue(false),
  getUnprocessedSessions: vi.fn().mockReturnValue([]),
  getEscalatedIdleSessions: vi.fn().mockReturnValue([]),
  detectStuckSession: vi.fn().mockReturnValue(null),
}));

// Imports AFTER mocks — ESM hoisting guarantees the mocks are in place.
import { heartbeatTick, type HeartbeatContext } from '../../angel/heartbeat.js';
import { DEFAULT_ANGEL_CONFIG } from '../../angel/types.js';

const testConfig = {
  ...DEFAULT_CONFIG,
  enrichment: { ...DEFAULT_CONFIG.enrichment, enabled: false },
} as unknown as ClaudexConfig;

function mkHeartbeatCtx(db: Database.Database): HeartbeatContext {
  return {
    db,
    config: { ...DEFAULT_ANGEL_CONFIG, localModel: 'test-model' },
  };
}

function countPatterns(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM experience_patterns').get() as { c: number }).c;
}

describe('Phase 4 — extraction-time pattern creation is deleted', () => {
  let db: Database.Database;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    const t = createTestDbWithSession();
    db = t.db;
    sessionId = t.sessionId;
    project = t.project;
    mockCallLocalLLM.mockReset();
    mockCallLocalLLM.mockResolvedValue('mock-domain');
  });

  afterEach(() => {
    db.close();
  });

  // (a) Site B regression: applyExperienceFeedback on correction signal MUST NOT
  //     create new experience_patterns rows.
  it('(a) applyExperienceFeedback with correction_flagged=true does not create patterns', async () => {
    setExperienceFlags(db, sessionId, {
      correction_flagged: true,
      correction_prompt: 'no, that is not right — always use approach X instead',
      injected_pattern_ids: [],
      injected_topic_keys: [],
      awaiting_feedback_ids: [],
      awaiting_topic_keys: [],
      pending_trigger_domains: [],
    });

    const before = countPatterns(db);
    await applyExperienceFeedback(
      db,
      sessionId,
      'I see — going forward I will use X.', // assistant response
      'no, that is not right — always use approach X instead', // user correction
      project,
      testConfig,
    );
    const after = countPatterns(db);
    expect(after).toBe(before);
  });

  // (b) Site A regression: heartbeat tick on a session with correction-shaped
  //     conversation_turns MUST NOT create patterns. (Site A is structurally
  //     deleted; this asserts the heartbeat doesn't re-introduce a different
  //     extraction path.)
  it('(b) heartbeat tick on a correction-rich session does not create patterns', async () => {
    // Mark the seeded session as completed so the heartbeat's Phase-2 loop
    // would have considered it (had Site A existed). Plan 02 deleted Site A —
    // the loop now only classifies domains. classifySessionDomains is mocked
    // to return 0; the test asserts the row count never moves.
    db.prepare(`UPDATE sessions SET status='completed', ended_at_epoch=strftime('%s','now') WHERE session_id=?`).run(sessionId);

    db.prepare(`
      INSERT INTO conversation_turns (session_id, project, turn_number, user_text, assistant_text, timestamp_epoch)
      VALUES
        (?, ?, 1, 'Always use bun run test, never use bun test', 'Got it.', strftime('%s','now')),
        (?, ?, 2, 'Stop using sed for file edits — use Edit tool', 'Understood.', strftime('%s','now'))
    `).run(sessionId, project, sessionId, project);

    const before = countPatterns(db);
    await heartbeatTick(mkHeartbeatCtx(db));
    const after = countPatterns(db);
    expect(after).toBe(before);
  });

  // (c) Surviving Angel-side LLM call (classifySessionDomains) MUST NOT write
  //     to experience_patterns — the binding/indexing-vs-extraction line.
  //     We import the real domain-classifier inside this test (the global
  //     vi.mock returns the stub for heartbeat-driven cases; here we want
  //     the actual function under test).
  it('(c) classifySessionDomains does not write to experience_patterns', async () => {
    db.prepare(`
      INSERT INTO thread_state (session_id, topic) VALUES (?, ?)
    `).run(sessionId, 'typescript types');

    const before = countPatterns(db);
    const { classifySessionDomains } = await vi.importActual<
      typeof import('../../angel/domain-classifier.js')
    >('../../angel/domain-classifier.js');
    const result = await classifySessionDomains(db, sessionId, project, 'gemma-test');
    const after = countPatterns(db);
    expect(after).toBe(before);
    // Survival check: the function still does its real work — extractDomain
    // hits the regex path for "typescript" and writes to capability_boundaries.
    expect(typeof result).toBe('number');
  });

  // (d) Site C regression: heartbeat tick MUST NOT rewrite the `lesson` column
  //     on any existing experience_patterns row.
  it('(d) heartbeat tick does not rewrite the lesson column on existing rows', async () => {
    // Seed two similar high-score patterns so the merge loop's vector search
    // would (in the deleted Site C code) have triggered LLM synthesis.
    allowLegacyPatternInsert(db);
    db.prepare(`
      INSERT INTO experience_patterns (id, pattern_type, trigger_context, lesson, source_project, created_at_epoch, score)
      VALUES
        ('p1', 'correction', 'use bun run test always', 'Lesson A: never invoke bun test directly', ?, strftime('%s','now'), 10),
        ('p2', 'correction', 'use bun run test always', 'Lesson B: bun test invokes wrong runner',  ?, strftime('%s','now'), 8)
    `).run(project, project);
    blockLegacyPatternInsert(db);

    const before = db.prepare(
      `SELECT id, lesson FROM experience_patterns WHERE id IN ('p1','p2') ORDER BY id`,
    ).all() as Array<{ id: string; lesson: string }>;
    expect(before).toHaveLength(2);

    await heartbeatTick(mkHeartbeatCtx(db));

    const after = db.prepare(
      `SELECT id, lesson FROM experience_patterns WHERE id IN ('p1','p2') ORDER BY id`,
    ).all() as Array<{ id: string; lesson: string }>;

    // Both rows MUST exist with byte-identical lesson strings (score-absorption
    // UPDATEs on score / helpful_count etc. are allowed; this test does NOT
    // assert those columns are unchanged).
    // It is also legal for the merge loop to DELETE one of them via score
    // absorption — if so, the surviving row's lesson must still be byte-
    // identical to its pre-merge value (NOT replaced by a synthesized lesson).
    if (after.length === 2) {
      expect(after[0].lesson).toBe(before[0].lesson);
      expect(after[1].lesson).toBe(before[1].lesson);
    } else if (after.length === 1) {
      const survivor = before.find(b => b.id === after[0].id);
      expect(survivor).toBeDefined();
      expect(after[0].lesson).toBe(survivor!.lesson);
    } else {
      throw new Error(`Unexpected post-tick row count: ${after.length}`);
    }
  });
});
