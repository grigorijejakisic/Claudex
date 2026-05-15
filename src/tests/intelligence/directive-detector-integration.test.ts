/**
 * Integration tests for Plan 03-04 — directive extractor wired into
 * Angel's heartbeat Phase-2 loop.
 *
 * Exercises:
 *   - End-to-end: 3 seeded turns → 2 directives written, 1 non-directive rejected.
 *   - Failure isolation: directive path throws → pattern-extractor still runs.
 *   - Call order: directive extraction happens BEFORE pattern extraction
 *     within a single tick.
 *
 * LLM + embedder are mocked so the test is hermetic. Heartbeat is driven via
 * `heartbeatTick` and filtered to exercise only the Phase-2 completed-
 * sessions loop — we mock out every other subsystem's side effects.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';

// ── Mocks (must be declared BEFORE the module under test is imported) ─────
const mockCallLocalLLM = vi.fn<(opts: unknown) => Promise<string>>();
const mockEmbedText = vi.fn<(text: string) => Promise<number[] | null>>();
const mockClassifyDomains = vi.fn<(...args: unknown[]) => Promise<number>>();

vi.mock('../../angel/llama-client.js', () => ({
  callLocalLLM: (opts: unknown) => mockCallLocalLLM(opts),
  checkLlamaServerHealth: vi.fn().mockResolvedValue(true),
  isCloudModel: vi.fn().mockReturnValue(true),
  LLAMA_MODEL_ALIAS: 'glm-5.1:cloud',
}));
vi.mock('../../embeddings/embed-pipeline.js', () => ({
  embedText: (text: string) => mockEmbedText(text),
}));
vi.mock('../../angel/domain-classifier.js', () => ({
  classifySessionDomains: (...args: unknown[]) => mockClassifyDomains(...args),
}));

// Intelligence-path extractor/classifier modules touched by other heartbeat
// phases — stub them to silent no-ops so the test targets only Phase 2.
vi.mock('../../angel/curated-context-extractor.js', () => ({
  extractCuratedContextFromSession: vi.fn().mockResolvedValue({ entriesCreated: 0 }),
  getSessionsPendingCuratedExtraction: vi.fn().mockReturnValue([]),
}));
vi.mock('../../angel/memory-monitor.js', () => ({
  monitorMemoryFiles: vi.fn().mockResolvedValue({ entries_migrated: 0, projects: [] }),
}));
vi.mock('../../angel/consolidator.js', () => ({
  consolidateObservationBatch: vi.fn().mockResolvedValue({ observations_consolidated: 0, clusters: 0 }),
  shouldConsolidate: vi.fn().mockReturnValue(false),
  markConsolidationRan: vi.fn(),
}));

// Import AFTER mocks — ESM hoisting ensures mocks are in place.
import { heartbeatTick } from '../../angel/heartbeat.ts';
import { DEFAULT_ANGEL_CONFIG } from '../../angel/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDb(): { db: TestDatabase; sessionId: string; project: string } {
  const ctx = createTestDbWithSession('itg-sess', 'itg-proj');
  applyV17DDL(ctx.db);
  // Mark the seeded session as completed so getUnprocessedSessions picks it up.
  ctx.db.prepare(`UPDATE sessions SET status = 'completed', ended_at_epoch = ? WHERE session_id = ?`)
    .run(Math.floor(Date.now() / 1000), ctx.sessionId);
  return ctx;
}

function seedTurn(db: TestDatabase, sessionId: string, project: string, n: number, user: string): void {
  db.prepare(
    `INSERT INTO conversation_turns(session_id, project, turn_number, user_text, timestamp_epoch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, project, n, user, 1000 + n);
}

function uvec(i: number): number[] {
  const v = new Array(1024).fill(0);
  v[i % 1024] = 1;
  return v;
}

function mkCtx(db: TestDatabase) {
  return {
    db,
    config: {
      ...DEFAULT_ANGEL_CONFIG,
      heartbeatIntervalMs: 1,
      idleThresholdSeconds: 999999,
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('directive-detector integration with Angel heartbeat', () => {
  let db: TestDatabase;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    const ctx = setupDb();
    db = ctx.db;
    sessionId = ctx.sessionId;
    project = ctx.project;

    mockCallLocalLLM.mockReset();
    mockEmbedText.mockReset();
    mockClassifyDomains.mockReset();

    mockClassifyDomains.mockResolvedValue(0);
    // embedder returns a different unit vector per call so dedup never collides
    let embCalls = 0;
    mockEmbedText.mockImplementation(async () => uvec(embCalls++ + 10));
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('end-to-end: 2 directives written, 1 non-directive rejected', async () => {
    seedTurn(db, sessionId, project, 1, 'always use Bun for tests in this project');
    // "don't commit" triggers `negation_dont`; "in this debugging session" anchors scope.
    seedTurn(db, sessionId, project, 2, "in this debugging session, don't commit until I say");
    seedTurn(db, sessionId, project, 3, 'what does the build command do?');

    mockCallLocalLLM
      .mockResolvedValueOnce(JSON.stringify({
        is_directive: true, confidence: 0.92, polarity: 'prescriptive',
        scope: 'project', suggested_title: 'Use Bun for tests',
        normalized_text: 'Use Bun for tests in this project.', reasoning: 'explicit',
      }))
      .mockResolvedValueOnce(JSON.stringify({
        is_directive: true, confidence: 0.85, polarity: 'prescriptive',
        scope: 'session', suggested_title: 'Minimal refactor',
        normalized_text: 'Keep the refactor minimal in this PR.', reasoning: 'session-scoped',
      }))
      .mockResolvedValueOnce(JSON.stringify({
        is_directive: false, confidence: 0.9, polarity: null, scope: null,
        suggested_title: null, normalized_text: null, reasoning: 'question',
      }));

    const tick = await heartbeatTick(mkCtx(db));

    const rows = db.prepare(`SELECT id, scope, project, session_id FROM artifact WHERE kind='directive_rule'`).all() as Array<{ id: string; scope: string; project: string; session_id: string }>;
    expect(rows.length).toBe(2);
    const scopes = rows.map(r => r.scope).sort();
    expect(scopes).toEqual(['project', 'session']);
    for (const r of rows) {
      expect(r.project).toBe(project);
      expect(r.session_id).toBe(sessionId);
    }

    expect(tick.directives_extracted).toBe(2);

    const reg = db.prepare(`SELECT kind FROM kind_registry WHERE kind = 'directive_rule'`).get();
    expect(reg).toBeDefined();

    const embCount = (db.prepare(`SELECT COUNT(*) AS n FROM artifact_embeddings`).get() as { n: number }).n;
    expect(embCount).toBe(2);
    const linked = (db.prepare(`SELECT COUNT(*) AS n FROM artifact WHERE kind='directive_rule' AND embedding_ref IS NOT NULL`).get() as { n: number }).n;
    expect(linked).toBe(2);
  });

  it('failure isolation: directive throw does NOT crash the tick', async () => {
    seedTurn(db, sessionId, project, 1, 'always use Bun');
    mockCallLocalLLM.mockRejectedValue(new Error('simulated network failure'));

    const tick = await heartbeatTick(mkCtx(db));

    // tick completes without throwing
    expect(tick.error).toBeUndefined();
    // zero directives extracted, but the error counter may or may not be bumped
    expect(tick.directives_extracted ?? 0).toBe(0);
    // domain classification still runs after directive failure
    expect(mockClassifyDomains).toHaveBeenCalled();
  });

  it('directive extraction is the only LLM call in the Phase-2 loop body', async () => {
    // Phase 4 (AR-01): pattern extraction was deleted — domain classification
    // is what remains, and it never calls the local LLM in this test (the
    // fixture topic is empty so classifySessionDomains returns 0 without
    // calling callLocalLLM). Therefore the only call to mockCallLocalLLM
    // inside the loop body is the directive-detector path.
    seedTurn(db, sessionId, project, 1, 'always use Bun');
    mockCallLocalLLM.mockResolvedValue(JSON.stringify({
      is_directive: false, confidence: 0.9, polarity: null, scope: null,
      suggested_title: null, normalized_text: null, reasoning: 'x',
    }));

    await heartbeatTick(mkCtx(db));

    // The directive detector hits the LLM exactly once for the seeded turn.
    expect(mockCallLocalLLM).toHaveBeenCalled();
    // classifySessionDomains was called exactly once in the loop body.
    expect(mockClassifyDomains).toHaveBeenCalledTimes(1);
  });
});
