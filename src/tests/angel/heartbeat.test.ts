/**
 * Integration tests for Plan 04-04 — Phase 5b session-completion artifact
 * curation. Drives `heartbeatTick` end-to-end with two seeded sessions and
 * asserts that the chunker + MEMORY.md curator each fire once per project,
 * dedup per-tick, skip already-processed rows, and isolate chunker failures
 * from curator success.
 *
 * Mocks:
 *   - `callLocalLLM` returns a deterministic single-segment response so the
 *     chunker produces one chunk per session without hitting a real LLM.
 *   - Heavy downstream heartbeat phases (pattern extractor, curated-context
 *     extractor, classifier, memory-monitor, embeddings, etc.) are stubbed.
 *     We exercise Phase 5b only.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../../core/migrations.js';
import { createSession } from '../../core/sessions.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { pathToCcSlug } from '../../shared/cc-slug.js';

// ── Mocks (must be declared BEFORE the module under test is imported) ─────
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

vi.mock('../../angel/session-monitor.js', () => ({
  getIdleSessions: vi.fn().mockReturnValue([]),
  hasIdleWarning: vi.fn().mockReturnValue(false),
  getUnprocessedSessions: vi.fn().mockReturnValue([]),
  getEscalatedIdleSessions: vi.fn().mockReturnValue([]),
  detectStuckSession: vi.fn().mockReturnValue(null),
}));

vi.mock('../../angel/message-sender.js', () => ({
  sendIdleWarning: vi.fn().mockReturnValue(false),
  sendMessage: vi.fn().mockReturnValue(true),
}));

vi.mock('../../adapters/shared/lifecycle.js', () => ({
  captureRecallFlowEntry: vi.fn(),
}));

vi.mock('../../core/session-events.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/session-events.js')>('../../core/session-events.js');
  return {
    ...actual,
    synthesizeSessionSummary: vi.fn().mockReturnValue(null),
    saveSessionSummary: vi.fn(),
  };
});

// Chunker is wrapped so per-test behavior (throw on specific session) can be
// installed via `mockChunker.mockImplementation`; by default, it forwards
// to the real `chunkSessionTranscript` so realistic LLM-mocked segmentation
// runs end-to-end.
type ChunkFn = typeof import('../../angel/transcript-chunker.js')['chunkSessionTranscript'];
const mockChunker = vi.fn<Parameters<ChunkFn>, ReturnType<ChunkFn>>();

vi.mock('../../angel/transcript-chunker.js', async () => {
  const actual = await vi.importActual<typeof import('../../angel/transcript-chunker.js')>(
    '../../angel/transcript-chunker.js',
  );
  return {
    ...actual,
    chunkSessionTranscript: (...args: Parameters<ChunkFn>) => mockChunker(...args),
  };
});

// Curator is wrapped so per-test behavior (throw on specific project) can be
// installed via `mockCurator.mockImplementation`. Plan 04-06-02 needs this to
// prove curator-throw isolation separately from chunker-throw isolation.
type CurateFn = typeof import('../../angel/memory-md-writer.js')['curateMemoryMd'];
const mockCurator = vi.fn<Parameters<CurateFn>, ReturnType<CurateFn>>();

vi.mock('../../angel/memory-md-writer.js', async () => {
  const actual = await vi.importActual<typeof import('../../angel/memory-md-writer.js')>(
    '../../angel/memory-md-writer.js',
  );
  return {
    ...actual,
    curateMemoryMd: (...args: Parameters<CurateFn>) => mockCurator(...args),
  };
});

// Import AFTER mocks — ESM hoisting ensures mocks are in place.
import { heartbeatTick } from '../../angel/heartbeat.js';
import { DEFAULT_ANGEL_CONFIG } from '../../angel/types.js';

// Real chunker + curator via importActual so we can forward in the default case.
let realChunker: ChunkFn;
let realCurator: CurateFn;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let db: Database.Database;

const PROJECT_1 = 'p1';
const PROJECT_2 = 'p2';
const SESSION_A = 's-a';
const SESSION_B = 's-b';

function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  initializeSchema(d);
  applyV17DDL(d);
  return d;
}

function memoryDirFor(project: string): string {
  return path.join(tmpHome, '.claude', 'projects', pathToCcSlug(project), 'memory');
}

function memoryMdPathFor(project: string): string {
  return path.join(memoryDirFor(project), 'MEMORY.md');
}

function ensureProjectDirs(): void {
  fs.mkdirSync(memoryDirFor(PROJECT_1), { recursive: true });
  fs.mkdirSync(memoryDirFor(PROJECT_2), { recursive: true });
}

function seedSession(d: Database.Database, sessionId: string, project: string): void {
  createSession(d, { session_id: sessionId, project, cwd: '/tmp', source: 'test' });
  // Mark the session completed so auto-close detection won't touch it.
  d.prepare(`UPDATE sessions SET status='completed', ended_at_epoch=? WHERE session_id=?`)
    .run(Math.floor(Date.now() / 1000), sessionId);
}

function seedTurns(d: Database.Database, sessionId: string, project: string, count: number): void {
  const stmt = d.prepare(
    `INSERT INTO conversation_turns(session_id, project, turn_number, user_text, assistant_text, timestamp_epoch)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= count; i++) {
    stmt.run(sessionId, project, i, `u ${i}`, `a ${i}`, 1000 + i);
  }
}

function seedEntities(
  d: Database.Database,
  project: string,
  entries: Array<{ ref: string; summary: string; importance?: number }>,
): void {
  const stmt = d.prepare(
    `INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, state, importance, timestamp_epoch)
     VALUES ('angel', ?, 'entity_summary', ?, ?, 'fresh', ?, ?)`,
  );
  const now = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    stmt.run(project, e.ref, e.summary, e.importance ?? 3, now);
  }
}

function enqueueCuration(d: Database.Database, sessionId: string, project: string): void {
  d.prepare(
    `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
     VALUES (?, ?, 'memory_curation_pending', 'angel', 'enqueue', ?)`,
  ).run(sessionId, project, JSON.stringify({ project, session_id: sessionId }));
}

function countDoneEvents(d: Database.Database): number {
  return (d
    .prepare(`SELECT COUNT(*) AS c FROM session_events WHERE event_type='memory_curation_done'`)
    .get() as { c: number }).c;
}

function mkCtx(database: Database.Database) {
  return {
    db: database,
    config: {
      ...DEFAULT_ANGEL_CONFIG,
      heartbeatIntervalMs: 1,
      idleThresholdSeconds: 999999,
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-heartbeat-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  db = makeDb();
  ensureProjectDirs();

  if (!realChunker) {
    const real = await vi.importActual<typeof import('../../angel/transcript-chunker.js')>(
      '../../angel/transcript-chunker.js',
    );
    realChunker = real.chunkSessionTranscript;
  }
  if (!realCurator) {
    const real = await vi.importActual<typeof import('../../angel/memory-md-writer.js')>(
      '../../angel/memory-md-writer.js',
    );
    realCurator = real.curateMemoryMd;
  }

  mockCallLocalLLM.mockReset();
  // Default: single-segment response covering the whole session. The chunker
  // reads turn numbers dynamically, so we produce a wrapper that inspects the
  // prompt to infer the turn range.
  mockCallLocalLLM.mockImplementation(async (opts: unknown) => {
    const prompt = String((opts as { prompt?: string }).prompt ?? '');
    const m = prompt.match(/"n":\s*(\d+)/g);
    if (!m) return JSON.stringify({ segments: [{ start: 1, end: 1, topic_label: 'test' }] });
    const nums = m.map(x => Number(x.match(/\d+/)![0]));
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    return JSON.stringify({ segments: [{ start: lo, end: hi, topic_label: 'test' }] });
  });

  mockChunker.mockReset();
  mockChunker.mockImplementation((...args: Parameters<ChunkFn>) => realChunker(...args));

  mockCurator.mockReset();
  mockCurator.mockImplementation((...args: Parameters<CurateFn>) => realCurator(...args));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Angel heartbeat — Phase 5b Session-completion artifact curation', () => {
  it('drains memory_curation_pending: chunks once per session, curates once per project', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedSession(db, SESSION_B, PROJECT_2);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedTurns(db, SESSION_B, PROJECT_2, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 'entity one' }]);
    seedEntities(db, PROJECT_2, [{ ref: 'e2', summary: 'entity two' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);
    enqueueCuration(db, SESSION_B, PROJECT_2);

    const tick = await heartbeatTick(mkCtx(db));

    expect(tick.chunks_created).toBe(2);
    expect(tick.memory_md_written).toBe(2);
    expect(tick.memory_curation_errors ?? 0).toBe(0);

    // Per-session chunks landed
    const chunksA = db.prepare(`SELECT COUNT(*) AS c FROM artifact WHERE kind='transcript_chunk' AND session_id=?`).get(SESSION_A) as { c: number };
    const chunksB = db.prepare(`SELECT COUNT(*) AS c FROM artifact WHERE kind='transcript_chunk' AND session_id=?`).get(SESSION_B) as { c: number };
    expect(chunksA.c).toBeGreaterThanOrEqual(1);
    expect(chunksB.c).toBeGreaterThanOrEqual(1);

    // Both MEMORY.md files exist with sentinel + section headers
    // Phase 4.1 CUR-09: ## Entities and ## Recent Threads dropped; ## Lessons added.
    for (const proj of [PROJECT_1, PROJECT_2]) {
      expect(fs.existsSync(memoryMdPathFor(proj))).toBe(true);
      const body = fs.readFileSync(memoryMdPathFor(proj), 'utf8');
      expect(body.startsWith('<!-- CLAUDEX-MANAGED:')).toBe(true);
      expect(body).not.toContain('## Entities');
      expect(body).not.toContain('## Recent Threads');
      expect(body).toContain('## Active Projects');
      expect(body).toContain('## Lessons');
      expect(body).toContain('## Handoff');
      expect(body).toContain('## How to Query');
    }

    // Each consumed pending row produced one memory_curation_done row.
    expect(countDoneEvents(db)).toBe(2);
  });

  it('second tick with no new pending rows is a no-op', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 's' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);

    await heartbeatTick(mkCtx(db));
    const doneAfter1 = countDoneEvents(db);

    const tick2 = await heartbeatTick(mkCtx(db));
    expect(tick2.chunks_created ?? 0).toBe(0);
    expect(tick2.memory_md_written ?? 0).toBe(0);
    expect(countDoneEvents(db)).toBe(doneAfter1);
  });

  it('third tick re-curates p1 only after new pending event + input change', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedSession(db, SESSION_B, PROJECT_2);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedTurns(db, SESSION_B, PROJECT_2, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 's1' }]);
    seedEntities(db, PROJECT_2, [{ ref: 'e2', summary: 's2' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);
    enqueueCuration(db, SESSION_B, PROJECT_2);

    await heartbeatTick(mkCtx(db));
    const p1Before = fs.readFileSync(memoryMdPathFor(PROJECT_1));
    const p2Before = fs.readFileSync(memoryMdPathFor(PROJECT_2));

    // Phase 4.1: Entities are no longer rendered, so changing entity rows
    // doesn't drive a managed-section diff. Insert an artifact row that the
    // Active Projects section counts (kind='test_seed', project_id=PROJECT_1)
    // so the body actually changes between runs.
    const SESSION_A2 = 's-a2';
    seedSession(db, SESSION_A2, PROJECT_1);
    seedTurns(db, SESSION_A2, PROJECT_1, 3);
    db.prepare(
      `INSERT INTO artifact (id, kind, title, body, status, created_at_epoch, updated_at_epoch, project_id, data)
       VALUES (?, 'test_seed', 'tick3', 'body', 'active', ?, ?, ?, '{}')`,
    ).run(`active-${Date.now()}`, Date.now(), Date.now(), PROJECT_1);
    enqueueCuration(db, SESSION_A2, PROJECT_1);

    const tick = await heartbeatTick(mkCtx(db));
    expect(tick.memory_md_written).toBe(1);

    const p1After = fs.readFileSync(memoryMdPathFor(PROJECT_1));
    const p2After = fs.readFileSync(memoryMdPathFor(PROJECT_2));
    expect(p1After.equals(p1Before)).toBe(false); // p1 rewritten
    expect(p2After.equals(p2Before)).toBe(true);  // p2 untouched
  });

  it('failure isolation: chunker throw for one session does not block curator or other sessions', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedSession(db, SESSION_B, PROJECT_2);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedTurns(db, SESSION_B, PROJECT_2, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 's' }]);
    seedEntities(db, PROJECT_2, [{ ref: 'e2', summary: 's' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);
    enqueueCuration(db, SESSION_B, PROJECT_2);

    // Selectively throw for s-a only — pass-through otherwise.
    mockChunker.mockImplementation(async (database, sessionId, project) => {
      if (sessionId === SESSION_A) throw new Error('chunker simulated failure');
      return realChunker(database, sessionId, project);
    });

    const tick = await heartbeatTick(mkCtx(db));

    expect(tick.memory_curation_errors ?? 0).toBeGreaterThanOrEqual(1);

    // s-b was still chunked.
    const chunksB = db.prepare(`SELECT COUNT(*) AS c FROM artifact WHERE kind='transcript_chunk' AND session_id=?`).get(SESSION_B) as { c: number };
    expect(chunksB.c).toBeGreaterThanOrEqual(1);

    // Both MEMORY.md files were written — curator is independent of chunker.
    expect(fs.existsSync(memoryMdPathFor(PROJECT_1))).toBe(true);
    expect(fs.existsSync(memoryMdPathFor(PROJECT_2))).toBe(true);
    expect(tick.memory_md_written).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Plan 04-06-02 — per-operation try/catch hardening in the queue drain.
  // --------------------------------------------------------------------------

  it('04-06-02: chunker throw emits memory_curation_failed and still marks done', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 's' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);

    mockChunker.mockImplementation(async () => {
      const err = new Error('simulated Ollama VRAM contention timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    await heartbeatTick(mkCtx(db));

    // A `memory_curation_failed` row was inserted with detail for `chunker`.
    const failures = db.prepare(
      `SELECT action, detail FROM session_events
       WHERE event_type = 'memory_curation_failed' AND session_id = ? AND project = ?`,
    ).all(SESSION_A, PROJECT_1) as Array<{ action: string; detail: string | null }>;
    expect(failures.length).toBe(1);
    expect(failures[0].action).toBe('chunker');
    const parsed = JSON.parse(failures[0].detail!);
    expect(parsed.stage).toBe('chunker');
    expect(parsed.error_name).toBe('TimeoutError');
    expect(parsed.error_message).toContain('VRAM contention');

    // Curator still ran — MEMORY.md exists because the curator reads what it
    // can find (may be empty Recent Threads for this session, but the file
    // shape is still produced).
    expect(fs.existsSync(memoryMdPathFor(PROJECT_1))).toBe(true);

    // Pending row marked done so the next tick does not re-attempt the
    // doomed session forever.
    expect(countDoneEvents(db)).toBe(1);
  });

  it('04-06-02: curator throw emits memory_curation_failed and still marks done', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 's' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);

    mockCurator.mockImplementation(() => {
      const err = new Error('disk full during atomic rename');
      err.name = 'FilesystemError';
      throw err;
    });

    const tick = await heartbeatTick(mkCtx(db));

    const failures = db.prepare(
      `SELECT action, detail FROM session_events
       WHERE event_type = 'memory_curation_failed' AND project = ?`,
    ).all(PROJECT_1) as Array<{ action: string; detail: string | null }>;
    expect(failures.length).toBe(1);
    expect(failures[0].action).toBe('curator');
    const parsed = JSON.parse(failures[0].detail!);
    expect(parsed.stage).toBe('curator');
    expect(parsed.error_name).toBe('FilesystemError');
    expect(parsed.error_message).toContain('disk full');

    // memory_md_written should NOT increment; memory_curation_errors should.
    expect(tick.memory_md_written ?? 0).toBe(0);
    expect((tick.memory_curation_errors ?? 0)).toBeGreaterThanOrEqual(1);

    // Pending still marked done so we do not retry forever.
    expect(countDoneEvents(db)).toBe(1);
  });

  it('04-06-02: DB error caught at iteration level — next tick still runs', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 's' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);

    // Force a DB-shaped error from INSIDE the drain by making the chunker
    // import throw. The outer try/catch around the whole drain block is
    // the iteration-level guard — plan 04-06-02 item #4.
    mockChunker.mockImplementation(() => {
      throw new Error('db connection dropped');
    });
    mockCurator.mockImplementation(() => {
      throw new Error('db connection dropped');
    });

    // First tick — both stages throw, but Angel must still complete the
    // heartbeat tick (no exception bubbles out).
    const tick1 = await heartbeatTick(mkCtx(db));
    expect(tick1.error).toBeUndefined();
    expect((tick1.memory_curation_errors ?? 0)).toBeGreaterThanOrEqual(1);

    // Restore happy path and confirm the next tick still runs cleanly with
    // a fresh pending row — proves the loop survived the prior failure.
    mockChunker.mockImplementation((...args) => realChunker(...args));
    mockCurator.mockImplementation((...args) => realCurator(...args));

    const SESSION_C = 's-c';
    seedSession(db, SESSION_C, PROJECT_1);
    seedTurns(db, SESSION_C, PROJECT_1, 4);
    enqueueCuration(db, SESSION_C, PROJECT_1);

    const tick2 = await heartbeatTick(mkCtx(db));
    expect(tick2.error).toBeUndefined();
    expect((tick2.chunks_created ?? 0)).toBeGreaterThanOrEqual(1);
    expect(tick2.memory_md_written).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Plan 04-08-03 — memory_curation_no_project_dir telemetry counter
  // --------------------------------------------------------------------------

  it('04-08-03: no_project_dir increments memory_curation_no_project_dir, not errors', async () => {
    seedSession(db, SESSION_A, PROJECT_1);
    seedTurns(db, SESSION_A, PROJECT_1, 4);
    seedEntities(db, PROJECT_1, [{ ref: 'e1', summary: 's' }]);
    enqueueCuration(db, SESSION_A, PROJECT_1);

    // Make the curator return no_project_dir by making the mock return that reason.
    mockCurator.mockImplementation(() => ({
      path: '/tmp/no-such-dir/MEMORY.md',
      written: false,
      reason: 'no_project_dir' as const,
    }));

    const tick = await heartbeatTick(mkCtx(db));

    // no_project_dir must increment its own counter, NOT memory_curation_errors.
    expect(tick.memory_curation_no_project_dir).toBe(1);
    expect(tick.memory_curation_errors ?? 0).toBe(0);
    expect(tick.memory_md_written ?? 0).toBe(0);

    // Pending row still marked done (no_project_dir is whitelisted by design).
    expect(countDoneEvents(db)).toBe(1);
  });
});
