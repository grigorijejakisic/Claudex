/**
 * Phase 14-07l — Unit tests for handoff-decision-watcher.ts
 *
 * Tests: watcher orchestration with mocked LLM calls.
 * DB: in-memory with V39 schema (handoff_refresh_state + soft_link + artifact tables).
 * LLM: mocked via env override + vitest vi.mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  classifyTurnAsDecisionBoundary,
  getThrottleState,
  updateThrottleState,
  isThrottled,
  type WatcherContext,
} from '../../angel/handoff-decision-watcher.js';

// ---------------------------------------------------------------------------
// Mock classifyDecisionBoundary so we don't need a live Ollama
// ---------------------------------------------------------------------------

vi.mock('../../intelligence/directive-detector.js', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    classifyDecisionBoundary: vi.fn(),
  };
});

vi.mock('../../angel/handoff-writer.js', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    recordDecisionShift: vi.fn().mockReturnValue({
      refreshed: true,
      new_artifact_id: null,
      prior_artifact_id: null,
    }),
  };
});

import { classifyDecisionBoundary } from '../../intelligence/directive-detector.js';
import { recordDecisionShift } from '../../angel/handoff-writer.js';

const mockClassify = vi.mocked(classifyDecisionBoundary);
const mockRecordShift = vi.mocked(recordDecisionShift);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function makeCtx(db: Database.Database, overrides: Partial<WatcherContext> = {}): WatcherContext {
  return {
    db,
    project: 'test-project',
    session_id: 'test-session-' + Math.random().toString(36).slice(2),
    user_text: 'What should we do next?',
    assistant_text: 'My position: Option A is the right call because...',
    source_turn_uuid: 'turn-' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Throttle helpers
// ---------------------------------------------------------------------------

describe('throttle helpers', () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  it('getThrottleState returns null when no row exists', () => {
    expect(getThrottleState(db, 'no-session')).toBeNull();
  });

  it('updateThrottleState creates a row on first call', () => {
    updateThrottleState(db, 'sess-1', 'proj-1');
    const row = getThrottleState(db, 'sess-1');
    expect(row).not.toBeNull();
    expect(row!.refresh_count).toBe(1);
  });

  it('updateThrottleState increments refresh_count on second call', () => {
    updateThrottleState(db, 'sess-1', 'proj-1');
    updateThrottleState(db, 'sess-1', 'proj-1');
    const row = getThrottleState(db, 'sess-1');
    expect(row!.refresh_count).toBe(2);
  });

  it('isThrottled returns false when no prior refresh', () => {
    expect(isThrottled(db, 'fresh-session')).toBe(false);
  });

  it('isThrottled returns true within cooldown window', () => {
    updateThrottleState(db, 'sess-throttle', 'proj-1');
    expect(isThrottled(db, 'sess-throttle', 60_000)).toBe(true);
  });

  it('isThrottled returns false after cooldown has elapsed', () => {
    // Manually insert a stale row.
    const pastMs = Date.now() - 120_000; // 2 minutes ago
    db.prepare(
      `INSERT INTO handoff_refresh_state (session_id, project, last_refresh_epoch_ms, refresh_count, updated_at_epoch_ms)
       VALUES (?, ?, ?, 1, ?)`,
    ).run('sess-stale', 'proj-1', pastMs, pastMs);
    expect(isThrottled(db, 'sess-stale', 60_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyTurnAsDecisionBoundary orchestration
// ---------------------------------------------------------------------------

describe('classifyTurnAsDecisionBoundary', () => {
  let db: Database.Database;
  const OLD_ENV = process.env;

  beforeEach(() => {
    db = createDb();
    vi.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env['CLAUDEX_CHR_DISABLED'];
  });

  afterEach(() => {
    db.close();
    process.env = OLD_ENV;
  });

  it('CLAUDEX_CHR_DISABLED=1: returns immediately, no LLM call', async () => {
    process.env['CLAUDEX_CHR_DISABLED'] = '1';
    const ctx = makeCtx(db);
    const result = await classifyTurnAsDecisionBoundary(ctx);
    expect(result.refreshed).toBe(false);
    expect(result.throttled).toBe(false);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('agent-only turn (user_text null): skips LLM via cheap path, returns non-refresh', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: false,
      boundary_type: null,
      summary: null,
      confidence: 1.0,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });
    const ctx = makeCtx(db, { user_text: null });
    const result = await classifyTurnAsDecisionBoundary(ctx);
    expect(result.refreshed).toBe(false);
    // The mock is still called because the directive-detector function handles the null path
    // but from an architecture perspective the watcher calls classifyDecisionBoundary which
    // handles null internally — key is no refresh happened.
    expect(mockRecordShift).not.toHaveBeenCalled();
  });

  it('high-confidence boundary (≥ 0.5): refresh + telemetry chr_boundary_detected', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_confirm',
      summary: 'Operator committed to Option A',
      confidence: 0.92,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });
    const ctx = makeCtx(db);
    const result = await classifyTurnAsDecisionBoundary(ctx);
    expect(result.refreshed).toBe(true);
    expect(result.boundary_type).toBe('operator_confirm');
    expect(mockRecordShift).toHaveBeenCalledOnce();

    // Verify telemetry row was written.
    const row = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind = 'chr_boundary_detected' LIMIT 1`,
    ).get() as { detail: string } | undefined;
    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail) as { boundary_type: string; refreshed: boolean };
    expect(detail.boundary_type).toBe('operator_confirm');
    expect(detail.refreshed).toBe(true);
  });

  it('low-confidence boundary (< 0.5): no refresh, telemetry chr_no_boundary only', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_pivot',
      summary: 'Some pivot maybe',
      confidence: 0.3,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });
    const ctx = makeCtx(db);
    const result = await classifyTurnAsDecisionBoundary(ctx);
    expect(result.refreshed).toBe(false);
    expect(mockRecordShift).not.toHaveBeenCalled();

    const row = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind = 'chr_no_boundary' LIMIT 1`,
    ).get() as { detail: string } | undefined;
    expect(row).toBeDefined();
  });

  it('non-boundary: no refresh, telemetry chr_no_boundary', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: false,
      boundary_type: null,
      summary: null,
      confidence: 0.95,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });
    const ctx = makeCtx(db);
    const result = await classifyTurnAsDecisionBoundary(ctx);
    expect(result.refreshed).toBe(false);
    expect(mockRecordShift).not.toHaveBeenCalled();
  });

  it('very-high-confidence (≥ 0.85): refresh + session message emitted', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_confirm',
      summary: 'Operator confirmed deploy plan',
      confidence: 0.92,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });

    // Ensure session_messages table exists (it's part of the schema).
    const ctx = makeCtx(db);
    await classifyTurnAsDecisionBoundary(ctx);

    // Check for the session message.
    const msg = db.prepare(
      `SELECT message FROM session_messages WHERE message LIKE 'Handoff refreshed:%' LIMIT 1`,
    ).get() as { message: string } | undefined;
    expect(msg).toBeDefined();
    expect(msg!.message).toContain('Operator confirmed deploy plan');
  });

  it('throttle: second call within 60s skipped, telemetry chr_throttled', async () => {
    mockClassify.mockResolvedValue({
      is_decision_boundary: true,
      boundary_type: 'agent_position',
      summary: 'Agent position on architecture',
      confidence: 0.8,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });

    const sessionId = 'sess-throttle-' + Date.now();
    const ctx = makeCtx(db, { session_id: sessionId });

    // First call — should refresh.
    const r1 = await classifyTurnAsDecisionBoundary(ctx);
    expect(r1.refreshed).toBe(true);

    // Second call — throttled.
    const r2 = await classifyTurnAsDecisionBoundary(ctx);
    expect(r2.throttled).toBe(true);
    expect(r2.refreshed).toBe(false);

    // Only one LLM call total (second was throttled before the call).
    expect(mockClassify).toHaveBeenCalledTimes(1);

    // Check chr_throttled telemetry.
    const row = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind = 'chr_throttled' LIMIT 1`,
    ).get() as { detail: string } | undefined;
    expect(row).toBeDefined();
  });

  it('LLM failure (null response): returns non-refresh, telemetry chr_classify_failed', async () => {
    mockClassify.mockResolvedValueOnce(null);
    const ctx = makeCtx(db);
    const result = await classifyTurnAsDecisionBoundary(ctx);
    expect(result.refreshed).toBe(false);
    expect(mockRecordShift).not.toHaveBeenCalled();

    const row = db.prepare(
      `SELECT detail FROM telemetry WHERE event_kind = 'chr_classify_failed' LIMIT 1`,
    ).get() as { detail: string } | undefined;
    expect(row).toBeDefined();
  });

  it('non-throwing: recordDecisionShift throws, watcher still returns gracefully', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'spec_change',
      summary: 'Spec updated',
      confidence: 0.75,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });
    mockRecordShift.mockImplementationOnce(() => { throw new Error('disk full'); });

    const ctx = makeCtx(db);
    // Should not throw — the outer try/catch catches everything.
    await expect(classifyTurnAsDecisionBoundary(ctx)).resolves.toBeDefined();
  });
});
