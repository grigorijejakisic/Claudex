/**
 * Schema contract tests for `artifact(kind='directive_rule')` — Plan 03-01.
 *
 * This test is the P2 ↔ P8 schema contract. Changing it means coordinating
 * with Phase 10 (Rule lifecycle). P8 reads the annotations written here
 * (`possible_contradicts`, `related_to`, `reinforcements[]`, etc.) — if the
 * shape drifts, P8's supersession + decay + contradiction resolution breaks.
 *
 * Four inline snapshots cover the four write-paths:
 *   1. Fresh INSERT (no dedup hit)
 *   2. Restatement  UPDATE (bumps reinforcement_count, appends reinforcements[])
 *   3. Opposite-polarity INSERT + possible_contradicts annotation
 *   4. Related-but-distinct INSERT + related_to / related_cosine annotation
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDbWithSession, type TestDatabase } from '../helpers/test-db.js';
import { applyV17DDL } from '../../core/migration/v17-ddl.js';
import { encodeVector } from '../../core/sqlite-vec-loader.js';

// ── Mocks BEFORE module-under-test import ──
const mockCallLocalLLM = vi.fn<(opts: unknown) => Promise<string>>();
const mockEmbedText = vi.fn<(text: string) => Promise<number[] | null>>();

vi.mock('../../angel/llama-client.js', () => ({
  callLocalLLM: (opts: unknown) => mockCallLocalLLM(opts),
}));
vi.mock('../../embeddings/embed-pipeline.js', () => ({
  embedText: (text: string) => mockEmbedText(text),
}));

import { extractDirectivesFromSession } from '../../intelligence/directive-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupV17Db(): { db: TestDatabase; sessionId: string; project: string } {
  const ctx = createTestDbWithSession('ds-sess', 'ds-proj');
  applyV17DDL(ctx.db);
  return ctx;
}

function insertTurn(
  db: TestDatabase,
  sessionId: string,
  project: string,
  turnNumber: number,
  userText: string,
): void {
  db.prepare(
    `INSERT INTO conversation_turns(session_id, project, turn_number, user_text, timestamp_epoch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, project, turnNumber, userText, 1000 + turnNumber);
}

function unitVector(i: number): number[] {
  const v = new Array(1024).fill(0);
  v[i % 1024] = 1;
  return v;
}

function seedExistingRule(
  db: TestDatabase,
  id: string,
  project: string,
  scope: 'project' | 'universal' | 'session',
  title: string,
  body: string,
  embedding: number[],
): void {
  db.prepare(
    `INSERT INTO artifact(
       id, kind, title, body, scope, status, confidence,
       created_at_epoch, updated_at_epoch, session_id, project, data
     ) VALUES (?, 'directive_rule', ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, title, body, scope, 0.9, 500, 500, 'ds-sess', project,
    JSON.stringify({
      polarity: 'prescriptive',
      reasoning: 'seed',
      source_session_id: 'ds-sess',
      source_turn_idx: 0,
      regex_family: 'always_emphasis',
      reinforcement_count: 1,
      reinforcements: [
        { session_id: 'ds-sess', turn_idx: 0, seen_at_epoch: 500, regex_family: 'always_emphasis' },
      ],
    }),
  );
  const maxRow = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM artifact_embeddings`).get() as { m: number | bigint };
  const prev = typeof maxRow.m === 'bigint' ? maxRow.m : BigInt(maxRow.m);
  const rowid = prev + 1n;
  db.prepare(`INSERT INTO artifact_embeddings(rowid, embedding) VALUES (?, ?)`).run(rowid, encodeVector(embedding));
  db.prepare(`UPDATE artifact SET embedding_ref = ? WHERE id = ?`).run(Number(rowid), id);
}

function getDirectiveRows(db: TestDatabase): Array<{ id: string; data: Record<string, unknown>; title: string | null; body: string; scope: string }> {
  const rows = db
    .prepare(`SELECT id, title, body, scope, data FROM artifact WHERE kind='directive_rule' ORDER BY created_at_epoch ASC, id ASC`)
    .all() as Array<{ id: string; title: string | null; body: string; scope: string; data: string }>;
  return rows.map(r => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('directive_rule schema contract (P2 ↔ P8)', () => {
  let db: TestDatabase;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    const ctx = setupV17Db();
    db = ctx.db;
    sessionId = ctx.sessionId;
    project = ctx.project;

    mockCallLocalLLM.mockReset();
    mockEmbedText.mockReset();
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it('Fresh INSERT writes the expected data shape', async () => {
    insertTurn(db, sessionId, project, 1, 'always use Bun for tests in this project');

    mockEmbedText.mockResolvedValue(unitVector(5)); // not close to any existing row
    mockCallLocalLLM.mockResolvedValueOnce(JSON.stringify({
      is_directive: true, confidence: 0.9, polarity: 'prescriptive',
      scope: 'project', suggested_title: 'Use Bun',
      normalized_text: 'Use Bun for tests in this project', reasoning: 'explicit directive',
    }));

    const result = await extractDirectivesFromSession(db, sessionId, project);
    expect(result.inserted).toBe(1);

    const rows = getDirectiveRows(db);
    expect(rows.length).toBe(1);
    const row = rows[0];

    expect(row.title).toBe('Use Bun');
    expect(row.body).toBe('Use Bun for tests in this project');
    expect(row.scope).toBe('project');

    expect(row.data.polarity).toBe('prescriptive');
    expect(row.data.reasoning).toBe('explicit directive');
    expect(row.data.source_session_id).toBe(sessionId);
    expect(row.data.source_turn_idx).toBe(1);
    expect(typeof row.data.regex_family).toBe('string');
    expect(row.data.reinforcement_count).toBe(1);
    expect(Array.isArray(row.data.reinforcements)).toBe(true);
    expect((row.data.reinforcements as unknown[]).length).toBe(1);

    // Must NOT carry contradiction / relation annotations (fresh path)
    expect(row.data.possible_contradicts).toBeUndefined();
    expect(row.data.related_to).toBeUndefined();
  });

  it('Restatement UPDATE bumps reinforcement_count and appends reinforcements[] without creating a new row', async () => {
    const axis0 = unitVector(0);
    seedExistingRule(db, 'existing-restate', project, 'project', 'Use Bun', 'Use Bun for tests', axis0);
    insertTurn(db, sessionId, project, 3, 'always use Bun for tests');

    mockEmbedText.mockResolvedValue(axis0); // identical → cosine 1.0 → dedup fires
    mockCallLocalLLM
      .mockResolvedValueOnce(JSON.stringify({
        is_directive: true, confidence: 0.9, polarity: 'prescriptive',
        scope: 'project', suggested_title: 'Use Bun',
        normalized_text: 'Use Bun for tests', reasoning: 'same rule',
      }))
      .mockResolvedValueOnce(JSON.stringify({ relation: 'restatement', reasoning: 'same' }));

    const result = await extractDirectivesFromSession(db, sessionId, project);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);

    const rows = getDirectiveRows(db);
    expect(rows.length).toBe(1); // NO new row
    const row = rows[0];
    expect(row.id).toBe('existing-restate');

    expect(row.data.reinforcement_count).toBe(2);
    const reinforcements = row.data.reinforcements as Array<Record<string, unknown>>;
    expect(reinforcements.length).toBe(2);
    expect(reinforcements[1].session_id).toBe(sessionId);
    expect(reinforcements[1].turn_idx).toBe(3);
    expect(typeof reinforcements[1].seen_at_epoch).toBe('number');
    expect(typeof reinforcements[1].regex_family).toBe('string');
  });

  it('Opposite-polarity INSERT annotates data.possible_contradicts and data.contradict_reason', async () => {
    const axis0 = unitVector(0);
    seedExistingRule(db, 'existing-opp', project, 'project', 'Use Bun', 'Use Bun for tests', axis0);
    insertTurn(db, sessionId, project, 4, "never use Bun for tests in this project");

    mockEmbedText.mockResolvedValue(axis0);
    mockCallLocalLLM
      .mockResolvedValueOnce(JSON.stringify({
        is_directive: true, confidence: 0.9, polarity: 'prohibitive',
        scope: 'project', suggested_title: 'Do not use Bun',
        normalized_text: 'Do not use Bun for tests', reasoning: 'flipped polarity',
      }))
      .mockResolvedValueOnce(JSON.stringify({
        relation: 'opposite_polarity',
        reasoning: 'candidate prohibits what existing prescribes',
      }));

    const result = await extractDirectivesFromSession(db, sessionId, project);
    expect(result.inserted).toBe(1);

    const rows = getDirectiveRows(db);
    expect(rows.length).toBe(2); // existing + new
    const fresh = rows.find(r => r.id !== 'existing-opp')!;

    expect(fresh.data.polarity).toBe('prohibitive');
    expect(fresh.data.possible_contradicts).toBe('existing-opp');
    expect(typeof fresh.data.contradict_reason).toBe('string');
    expect((fresh.data.contradict_reason as string).length).toBeGreaterThan(0);

    // Must NOT carry related_to (different path)
    expect(fresh.data.related_to).toBeUndefined();
  });

  it('Related-but-distinct INSERT annotates data.related_to, data.related_cosine, data.related_relation', async () => {
    const axis0 = unitVector(0);
    seedExistingRule(db, 'existing-rel', project, 'project', 'Seed rule', 'seed body', axis0);
    insertTurn(db, sessionId, project, 5, 'always double-check migrations before running');

    mockEmbedText.mockResolvedValue(axis0);
    mockCallLocalLLM
      .mockResolvedValueOnce(JSON.stringify({
        is_directive: true, confidence: 0.9, polarity: 'prescriptive',
        scope: 'project', suggested_title: 'Check migrations',
        normalized_text: 'Always double-check migrations before running',
        reasoning: 'different rule, overlapping domain',
      }))
      .mockResolvedValueOnce(JSON.stringify({
        relation: 'related_but_distinct',
        reasoning: 'same area different rule',
      }));

    const result = await extractDirectivesFromSession(db, sessionId, project);
    expect(result.inserted).toBe(1);

    const rows = getDirectiveRows(db);
    expect(rows.length).toBe(2);
    const fresh = rows.find(r => r.id !== 'existing-rel')!;

    expect(fresh.data.related_to).toBe('existing-rel');
    expect(typeof fresh.data.related_cosine).toBe('number');
    expect(fresh.data.related_cosine).toBeGreaterThan(0.7);
    expect(fresh.data.related_relation).toBe('related_but_distinct');

    // Must NOT carry possible_contradicts
    expect(fresh.data.possible_contradicts).toBeUndefined();
  });
});
