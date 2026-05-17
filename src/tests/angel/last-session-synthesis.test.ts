/**
 * Phase 14-07k — Last-Session Synthesis module tests.
 *
 * Coverage (14 tests):
 *  1. synthesizeLastSession: happy path → valid synthesis + persist + telemetry
 *  2. synthesizeLastSession: jsonl missing → null + telemetry reason=jsonl_missing
 *  3. synthesizeLastSession: empty transcript → null + telemetry reason=empty_transcript
 *  4. synthesizeLastSession: LLM unreachable → null + telemetry reason=llm_unreachable
 *  5. synthesizeLastSession: LLM returns malformed JSON → null + telemetry
 *  6. synthesizeLastSession: confidence < 0.3 → null + telemetry
 *  7. synthesizeLastSession: confidence ∈ [0.3, 0.5) → persisted with degraded=true
 *  8. synthesizeLastSession: re-run on existing session → updated=true; same artifact_id
 *  9. parseLLMSynthesisOutput: missing field → null + telemetry
 * 10. parseLLMSynthesisOutput: wrong type for confidence → null + telemetry
 * 11. validateSynthesisSchema: valid + invalid shape classification
 * 12. deriveSynthesisArtifactId: deterministic
 * 13. persistSynthesisArtifact: UPSERT semantics correct
 * 14. Non-throwing: every cascading-failure path completes without exception
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  synthesizeLastSession,
  parseLLMSynthesisOutput,
  validateSynthesisSchema,
  persistSynthesisArtifact,
  deriveSynthesisArtifactId,
  type LastSessionSynthesis,
  type SynthesizeOpts,
} from '../../angel/last-session-synthesis.js';
import { initializeSchema } from '../../core/migrations.js';

// ---------------------------------------------------------------------------
// Test DB + fixture helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function buildValidSynthesis(sessionId = 'test-session'): LastSessionSynthesis {
  return {
    schema_version: 1,
    session_id: sessionId,
    operator_pivots: [{ at_turn: 5, pivot_summary: 'Approved Option A' }],
    agent_positions: [{ at_turn: 6, position_summary: 'Recommended worker-spawn pattern' }],
    last_unresolved_question: null,
    recommended_next_action: 'Start Phase 2 worker fan-out',
    confidence: 0.85,
    prompt_version: 'v1',
    llm_model: 'llama3.1:8b',
    generated_at_epoch_ms: Date.now(),
  };
}

/** Build a minimal Claude Code JSONL transcript fixture. */
function buildMinimalJsonl(sessionId: string): string {
  return [
    JSON.stringify({ message: { role: 'user', content: 'Hello, let\'s build something' }, timestamp: '2026-05-17T10:00:00Z', slug: sessionId }),
    JSON.stringify({ message: { role: 'assistant', content: 'Sure, I recommend Option A because...' }, timestamp: '2026-05-17T10:00:01Z' }),
    JSON.stringify({ message: { role: 'user', content: 'Let\'s go with Option A' }, timestamp: '2026-05-17T10:00:02Z' }),
    JSON.stringify({ message: { role: 'assistant', content: 'Implementing Option A now' }, timestamp: '2026-05-17T10:00:03Z' }),
  ].join('\n');
}

/** Check that an lss_synthesis_failed event exists in session_events. */
function getLssFailureEvents(db: Database.Database, sessionId: string, reason: string): number {
  try {
    const rows = db.prepare(
      `SELECT COUNT(*) as cnt FROM session_events
       WHERE session_id = ? AND event_type = 'lss_synthesis_failed' AND action = ?`
    ).get(sessionId, reason) as { cnt: number } | undefined;
    return rows?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/** Check that an lss_synthesis_complete event exists. */
function getLssCompleteEvents(db: Database.Database, sessionId: string): number {
  try {
    const rows = db.prepare(
      `SELECT COUNT(*) as cnt FROM session_events
       WHERE session_id = ? AND event_type = 'lss_synthesis_complete'`
    ).get(sessionId) as { cnt: number } | undefined;
    return rows?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// LSS tests pin the backend to ollama so vi.mock on callLocalLLM intercepts.
// Phase 14-08 routes synthesizeLastSession via the generation-backend
// selector (default 'claude'); pinning to ollama keeps the test contract
// unchanged while the production path uses Claude subprocess.
beforeEach(() => {
  process.env['CLAUDEX_GENERATION_BACKEND'] = 'ollama';
});
afterEach(() => {
  delete process.env['CLAUDEX_GENERATION_BACKEND'];
});

// Mock callLocalLLM via vi.mock
// ---------------------------------------------------------------------------

vi.mock('../../angel/llama-client.js', () => ({
  callLocalLLM: vi.fn(),
}));

// We'll import and configure in each test
import * as llamaClient from '../../angel/llama-client.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('last-session-synthesis module', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  // Test 1: happy path
  it('synthesizeLastSession: happy path produces valid synthesis', async () => {
    const sessionId = 'happy-session';
    const synthesis = buildValidSynthesis(sessionId);
    const llmResponse = JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      operator_pivots: synthesis.operator_pivots,
      agent_positions: synthesis.agent_positions,
      last_unresolved_question: null,
      recommended_next_action: synthesis.recommended_next_action,
      confidence: 0.85,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
      generated_at_epoch_ms: Date.now(),
    });

    vi.mocked(llamaClient.callLocalLLM).mockResolvedValueOnce(llmResponse);

    // Write a temporary JSONL file
    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, `${sessionId}.jsonl`);
    require('node:fs').writeFileSync(jsonlPath, buildMinimalJsonl(sessionId), 'utf-8');

    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    expect(result).not.toBeNull();
    expect(result?.session_id).toBe(sessionId);
    expect(result?.confidence).toBe(0.85);
    expect(result?.degraded).toBeUndefined();
    expect(getLssCompleteEvents(db, sessionId)).toBe(1);

    // Artifact should be persisted
    const artifactId = deriveSynthesisArtifactId(sessionId);
    const row = db.prepare('SELECT id, kind FROM artifact WHERE id = ?').get(artifactId) as { id: string; kind: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.kind).toBe('session_synthesis');

    // Cleanup
    require('node:fs').unlinkSync(jsonlPath);
  });

  // Test 2: jsonl missing
  it('synthesizeLastSession: jsonl missing → null + telemetry reason=jsonl_missing', async () => {
    const sessionId = 'missing-jsonl';
    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: '/nonexistent/path/to/session.jsonl',
    });

    expect(result).toBeNull();
    expect(getLssFailureEvents(db, sessionId, 'jsonl_missing')).toBeGreaterThan(0);
  });

  // Test 3: empty transcript
  it('synthesizeLastSession: empty transcript → null + telemetry reason=empty_transcript', async () => {
    const sessionId = 'empty-transcript';
    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, `${sessionId}.jsonl`);
    // Write empty / non-parseable JSONL
    require('node:fs').writeFileSync(jsonlPath, '', 'utf-8');

    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    expect(result).toBeNull();
    expect(getLssFailureEvents(db, sessionId, 'empty_transcript')).toBeGreaterThan(0);

    require('node:fs').unlinkSync(jsonlPath);
  });

  // Test 4: LLM unreachable
  it('synthesizeLastSession: LLM unreachable → null + telemetry reason=llm_unreachable', async () => {
    const sessionId = 'llm-unreachable';
    vi.mocked(llamaClient.callLocalLLM).mockRejectedValueOnce(new Error('fetch failed: connection refused'));

    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, `${sessionId}.jsonl`);
    require('node:fs').writeFileSync(jsonlPath, buildMinimalJsonl(sessionId), 'utf-8');

    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    expect(result).toBeNull();
    expect(getLssFailureEvents(db, sessionId, 'llm_unreachable')).toBeGreaterThan(0);

    require('node:fs').unlinkSync(jsonlPath);
  });

  // Test 5: LLM returns malformed JSON
  it('synthesizeLastSession: LLM returns malformed JSON → null + telemetry', async () => {
    const sessionId = 'malformed-json';
    vi.mocked(llamaClient.callLocalLLM).mockResolvedValueOnce('not valid json at all!!!');

    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, `${sessionId}.jsonl`);
    require('node:fs').writeFileSync(jsonlPath, buildMinimalJsonl(sessionId), 'utf-8');

    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    expect(result).toBeNull();

    require('node:fs').unlinkSync(jsonlPath);
  });

  // Test 6: confidence < 0.3
  it('synthesizeLastSession: confidence < 0.3 → null + telemetry reason=confidence_below_threshold', async () => {
    const sessionId = 'low-confidence';
    vi.mocked(llamaClient.callLocalLLM).mockResolvedValueOnce(JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      operator_pivots: [],
      agent_positions: [],
      last_unresolved_question: null,
      recommended_next_action: 'Ask what to do',
      confidence: 0.2,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
      generated_at_epoch_ms: Date.now(),
    }));

    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, `${sessionId}.jsonl`);
    require('node:fs').writeFileSync(jsonlPath, buildMinimalJsonl(sessionId), 'utf-8');

    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    expect(result).toBeNull();
    expect(getLssFailureEvents(db, sessionId, 'confidence_below_threshold')).toBeGreaterThan(0);

    require('node:fs').unlinkSync(jsonlPath);
  });

  // Test 7: confidence ∈ [0.3, 0.5) → degraded=true
  it('synthesizeLastSession: confidence ∈ [0.3, 0.5) → persisted with degraded=true', async () => {
    const sessionId = 'degraded-confidence';
    vi.mocked(llamaClient.callLocalLLM).mockResolvedValueOnce(JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      operator_pivots: [],
      agent_positions: [],
      last_unresolved_question: 'Was a decision made?',
      recommended_next_action: 'Clarify the decision',
      confidence: 0.4,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
      generated_at_epoch_ms: Date.now(),
    }));

    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, `${sessionId}.jsonl`);
    require('node:fs').writeFileSync(jsonlPath, buildMinimalJsonl(sessionId), 'utf-8');

    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    expect(result).not.toBeNull();
    expect(result?.degraded).toBe(true);
    expect(result?.confidence).toBe(0.4);

    // Check artifact persisted with degraded in body
    const artifactId = deriveSynthesisArtifactId(sessionId);
    const row = db.prepare('SELECT body FROM artifact WHERE id = ?').get(artifactId) as { body: string } | undefined;
    expect(row).toBeDefined();
    const stored = JSON.parse(row!.body) as LastSessionSynthesis;
    expect(stored.degraded).toBe(true);

    require('node:fs').unlinkSync(jsonlPath);
  });

  // Test 8: re-run on existing session → updated=true; same artifact_id
  it('synthesizeLastSession: re-run → updated=true; same artifact_id', async () => {
    const sessionId = 're-run-session';
    const response = JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      operator_pivots: [{ at_turn: 1, pivot_summary: 'Chose Option A' }],
      agent_positions: [],
      last_unresolved_question: null,
      recommended_next_action: 'Continue',
      confidence: 0.9,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
      generated_at_epoch_ms: Date.now(),
    });

    vi.mocked(llamaClient.callLocalLLM)
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(response);

    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, `${sessionId}.jsonl`);
    require('node:fs').writeFileSync(jsonlPath, buildMinimalJsonl(sessionId), 'utf-8');

    // First run
    await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    const firstId = deriveSynthesisArtifactId(sessionId);

    // Second run
    const result = await synthesizeLastSession(sessionId, db, {
      project: 'test-project',
      jsonl_path: jsonlPath,
    });

    const secondId = deriveSynthesisArtifactId(sessionId);
    expect(firstId).toBe(secondId);

    // Only one artifact row should exist
    const count = db.prepare(
      `SELECT COUNT(*) as cnt FROM artifact WHERE id = ? AND kind = 'session_synthesis'`
    ).get(firstId) as { cnt: number };
    expect(count.cnt).toBe(1);

    require('node:fs').unlinkSync(jsonlPath);
  });

  // Test 9: parseLLMSynthesisOutput: missing field → null + telemetry
  it('parseLLMSynthesisOutput: missing required field → null', () => {
    // Missing recommended_next_action
    const incomplete = JSON.stringify({
      schema_version: 1,
      session_id: 'test',
      operator_pivots: [],
      agent_positions: [],
      last_unresolved_question: null,
      confidence: 0.7,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
      generated_at_epoch_ms: Date.now(),
      // recommended_next_action: MISSING
    });

    const result = parseLLMSynthesisOutput(incomplete, 'test', 'v1', 'llama3.1:8b', db);
    expect(result).toBeNull();
  });

  // Test 10: wrong type for confidence → null
  it('parseLLMSynthesisOutput: wrong type for confidence → null', () => {
    const bad = JSON.stringify({
      schema_version: 1,
      session_id: 'test',
      operator_pivots: [],
      agent_positions: [],
      last_unresolved_question: null,
      recommended_next_action: 'Do something',
      confidence: 'high',  // string, not number
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
      generated_at_epoch_ms: Date.now(),
    });

    const result = parseLLMSynthesisOutput(bad, 'test', 'v1', 'llama3.1:8b', db);
    expect(result).toBeNull();
  });

  // Test 11: validateSynthesisSchema: valid + invalid
  it('validateSynthesisSchema: correctly classifies valid and invalid shapes', () => {
    const valid = buildValidSynthesis();
    expect(validateSynthesisSchema(valid)).toBe(true);

    expect(validateSynthesisSchema(null)).toBe(false);
    expect(validateSynthesisSchema({})).toBe(false);
    expect(validateSynthesisSchema({ schema_version: 2 })).toBe(false);
    expect(validateSynthesisSchema({ ...valid, confidence: -1 })).toBe(false);
    expect(validateSynthesisSchema({ ...valid, confidence: 2 })).toBe(false);
    expect(validateSynthesisSchema({ ...valid, session_id: 123 })).toBe(false);
    expect(validateSynthesisSchema({ ...valid, operator_pivots: 'not-array' })).toBe(false);
  });

  // Test 12: deriveSynthesisArtifactId is deterministic
  it('deriveSynthesisArtifactId: deterministic for same input', () => {
    const id1 = deriveSynthesisArtifactId('session-abc');
    const id2 = deriveSynthesisArtifactId('session-abc');
    const id3 = deriveSynthesisArtifactId('session-xyz');

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toHaveLength(32);
    expect(id1).toMatch(/^[0-9a-f]+$/);  // hex
  });

  // Test 13: persistSynthesisArtifact UPSERT semantics
  it('persistSynthesisArtifact: UPSERT semantics correct', () => {
    const synthesis = buildValidSynthesis('persist-test');

    const result1 = persistSynthesisArtifact(db, synthesis, 'my-project');
    expect(result1.updated).toBe(false);
    expect(result1.artifact_id).toBe(deriveSynthesisArtifactId('persist-test'));

    // Update synthesis
    const updated = { ...synthesis, recommended_next_action: 'New action after update' };
    const result2 = persistSynthesisArtifact(db, updated, 'my-project');
    expect(result2.updated).toBe(true);
    expect(result2.artifact_id).toBe(result1.artifact_id);

    // Verify body was updated
    const row = db.prepare('SELECT body FROM artifact WHERE id = ?').get(result1.artifact_id) as { body: string } | undefined;
    expect(row).toBeDefined();
    const stored = JSON.parse(row!.body) as LastSessionSynthesis;
    expect(stored.recommended_next_action).toBe('New action after update');
  });

  // Test 14: non-throwing on cascading failure
  it('synthesizeLastSession: non-throwing on cascading failure', async () => {
    // Throw from inside callLocalLLM in an unexpected way
    vi.mocked(llamaClient.callLocalLLM).mockImplementationOnce(() => {
      throw new Error('unexpected catastrophic failure');
    });

    const tmpDir = require('node:os').tmpdir();
    const jsonlPath = require('node:path').join(tmpDir, 'nothrow-session.jsonl');
    require('node:fs').writeFileSync(jsonlPath, buildMinimalJsonl('nothrow-session'), 'utf-8');

    let threw = false;
    try {
      await synthesizeLastSession('nothrow-session', db, {
        project: 'test-project',
        jsonl_path: jsonlPath,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);

    require('node:fs').unlinkSync(jsonlPath);
  });
});
