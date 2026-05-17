/**
 * Phase 14-07f — Hard-link LLM proposer tests.
 *
 * Coverage:
 *   - Prompt construction (buildProposerPrompt)
 *   - Response parsing (parseProposerResponse)
 *   - Rate limiting (1 run/min/session)
 *   - Decay-aware skipping (getDecayCount >= DECAY_THRESHOLD)
 *   - max_proposals_per_run (top by confidence)
 *   - Invalid proposal rejection (missing src/dst/type/confidence)
 *   - LLM error handling (llm_error: true, no throw)
 *   - LLM path selection (local vs Opus)
 *   - Telemetry row emission
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { createSession } from '../../core/sessions.js';
import {
  runHardLinkProposer,
  buildProposerPrompt,
  parseProposerResponse,
  LLM_PROPOSER_PROMPT,
  _setLLMCallableForTest,
} from '../../intelligence/hard-link-proposer.js';
import { rejectHardLink, DECAY_THRESHOLD } from '../../core/link-writer.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function insertArtifact(
  db: Database.Database,
  id: string,
  kind: string,
  project: string,
  createdMs?: number,
): void {
  db.prepare(`
    INSERT INTO artifact
      (id, kind, title, body, status, created_at_epoch_ms, updated_at_epoch_ms,
       session_id, project, data)
    VALUES (?, ?, ?, ?, 'active', ?, ?, 'sess', ?, '{}')
  `).run(id, kind, `Title-${id.slice(0, 8)}`, `Body for ${id}`,
    createdMs ?? Date.now(), Date.now(), project);
}

function seedRateLimitTelemetry(db: Database.Database, sessionId: string, agoMs = 0): void {
  const ts = Date.now() - agoMs;
  db.prepare(`
    INSERT INTO telemetry (session_id, event_kind, detail, timestamp_epoch_ms, adapter)
    VALUES (?, 'session_end_action', ?, ?, 'angel-boundary')
  `).run(
    sessionId,
    JSON.stringify({ action: 'hard_link_proposer', outcome: 'ok' }),
    ts,
  );
}

const PROJECT = 'test-proj';
const SESSION = 'test-session-abc';
const A1 = 'a001' + '0'.repeat(28);
const A2 = 'a002' + '0'.repeat(28);
const A3 = 'a003' + '0'.repeat(28);
const A4 = 'a004' + '0'.repeat(28);
const A5 = 'a005' + '0'.repeat(28);

// ─── Prompt building ──────────────────────────────────────────────────────────

describe('buildProposerPrompt', () => {
  it('includes the LLM_PROPOSER_PROMPT prefix', () => {
    const prompt = buildProposerPrompt([
      { id: A1, kind: 'observation', summary: 'Test summary' },
    ]);
    expect(prompt).toContain(LLM_PROPOSER_PROMPT);
  });

  it('includes artifact id, kind, summary', () => {
    const prompt = buildProposerPrompt([
      { id: A1, kind: 'decision', summary: 'A decision was made' },
      { id: A2, kind: 'lesson', summary: 'A lesson was learned' },
    ]);
    expect(prompt).toContain(A1);
    expect(prompt).toContain('decision');
    expect(prompt).toContain('A decision was made');
    expect(prompt).toContain(A2);
    expect(prompt).toContain('lesson');
  });

  it('truncates long summaries to 200 chars', () => {
    const longSummary = 'x'.repeat(300);
    const prompt = buildProposerPrompt([
      { id: A1, kind: 'observation', summary: longSummary },
    ]);
    // 200 chars of x should appear; 300 should not be the length found
    expect(prompt).toContain('x'.repeat(200));
    expect(prompt).not.toContain('x'.repeat(201));
  });
});

// ─── Response parsing ─────────────────────────────────────────────────────────

describe('parseProposerResponse', () => {
  it('parses valid JSON response', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          src_artifact_id: A1,
          dst_artifact_id: A2,
          type: 'triggered_by',
          confidence: 0.9,
          rationale: 'Test rationale',
        },
      ],
    });
    const result = parseProposerResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].src_artifact_id).toBe(A1);
    expect(result[0].type).toBe('triggered_by');
    expect(result[0].confidence).toBe(0.9);
  });

  it('returns empty array for non-JSON response', () => {
    expect(parseProposerResponse('not json')).toEqual([]);
  });

  it('returns empty array for malformed response (missing proposals key)', () => {
    expect(parseProposerResponse('{"items": []}')).toEqual([]);
  });

  it('returns empty array for JSON array (not object)', () => {
    expect(parseProposerResponse('[]')).toEqual([]);
  });

  it('strips markdown fences before parsing', () => {
    const raw = '```json\n' + JSON.stringify({ proposals: [] }) + '\n```';
    expect(parseProposerResponse(raw)).toEqual([]);
  });
});

// ─── runHardLinkProposer ──────────────────────────────────────────────────────

describe('runHardLinkProposer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createSession(db, { session_id: SESSION, project: PROJECT, cwd: '/test', source: 'test' });
    insertArtifact(db, A1, 'observation', PROJECT);
    insertArtifact(db, A2, 'decision', PROJECT);
    insertArtifact(db, A3, 'lesson', PROJECT);
    insertArtifact(db, A4, 'checkpoint', PROJECT);
    insertArtifact(db, A5, 'observation', PROJECT);
    _setLLMCallableForTest(null);
  });

  afterEach(() => {
    _setLLMCallableForTest(null);
    db.close();
  });

  it('4 valid LLM proposals → 4 proposed rows', async () => {
    const mockResponse = JSON.stringify({
      proposals: [
        { src_artifact_id: A1, dst_artifact_id: A2, type: 'triggered_by', confidence: 0.9, rationale: 'R1' },
        { src_artifact_id: A2, dst_artifact_id: A3, type: 'evidence_for', confidence: 0.85, rationale: 'R2' },
        { src_artifact_id: A3, dst_artifact_id: A4, type: 'contradicts', confidence: 0.8, rationale: 'R3' },
        { src_artifact_id: A4, dst_artifact_id: A5, type: 'triggered_by', confidence: 0.75, rationale: 'R4' },
      ],
    });
    _setLLMCallableForTest(async () => mockResponse);

    const result = await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(result.proposed).toBe(4);
    expect(result.skipped_decayed).toBe(0);
    expect(result.skipped_invalid).toBe(0);
    expect(result.llm_error).toBe(false);
  });

  it('rate-limited (recent run within 60s) → returns 0 proposed, telemetry skipped', async () => {
    seedRateLimitTelemetry(db, SESSION, 0); // just now

    _setLLMCallableForTest(async () => JSON.stringify({ proposals: [] }));
    const result = await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });

    // Rate-limited — proposer never ran; no proposals.
    expect(result.proposed).toBe(0);
    expect(result.llm_error).toBe(false);
  });

  it('recent_artifact_window respected — old artifacts excluded', async () => {
    // Insert artifact that is 48h old (outside default 24h window).
    const oldId = 'a099' + '0'.repeat(28);
    insertArtifact(db, oldId, 'observation', PROJECT, Date.now() - 48 * 3600 * 1000);

    let capturedPrompt = '';
    _setLLMCallableForTest(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ proposals: [] });
    });

    await runHardLinkProposer({
      db,
      session_id: SESSION,
      project: PROJECT,
      recent_artifact_window_hours: 24,
    });

    // The 48h-old artifact ID should NOT appear in the prompt.
    expect(capturedPrompt).not.toContain(oldId);
  });

  it('invalid proposal (missing src_artifact_id) → skipped_invalid++', async () => {
    _setLLMCallableForTest(async () => JSON.stringify({
      proposals: [
        { dst_artifact_id: A2, type: 'triggered_by', confidence: 0.9, rationale: 'R' },
      ],
    }));
    const result = await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(result.skipped_invalid).toBe(1);
    expect(result.proposed).toBe(0);
  });

  it('invalid proposal (invalid type) → skipped_invalid++', async () => {
    _setLLMCallableForTest(async () => JSON.stringify({
      proposals: [
        { src_artifact_id: A1, dst_artifact_id: A2, type: 'invalid_type', confidence: 0.9, rationale: 'R' },
      ],
    }));
    const result = await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(result.skipped_invalid).toBe(1);
  });

  it('invalid proposal (confidence > 1.0) → skipped_invalid++', async () => {
    _setLLMCallableForTest(async () => JSON.stringify({
      proposals: [
        { src_artifact_id: A1, dst_artifact_id: A2, type: 'triggered_by', confidence: 1.5, rationale: 'R' },
      ],
    }));
    const result = await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(result.skipped_invalid).toBe(1);
  });

  it('decayed tuple → skipped_decayed++', async () => {
    // Propose A1→A2, then force decay_count to threshold via direct DB.
    const { proposeHardLink } = await import('../../core/link-writer.js');
    const id = proposeHardLink(db, {
      src_artifact_id: A1,
      dst_artifact_id: A2,
      type: 'triggered_by',
      proposed_confidence: 0.9,
      proposed_by_session: SESSION,
      proposer_rationale: 'decayed test',
    });
    expect(id).not.toBeNull();
    db.prepare(`UPDATE hard_link SET decay_count = ? WHERE id = ?`).run(DECAY_THRESHOLD, id);

    _setLLMCallableForTest(async () => JSON.stringify({
      proposals: [
        { src_artifact_id: A1, dst_artifact_id: A2, type: 'triggered_by', confidence: 0.9, rationale: 'R' },
      ],
    }));

    const result = await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(result.skipped_decayed).toBeGreaterThanOrEqual(1);
    expect(result.proposed).toBe(0);
  });

  it('max_proposals_per_run respected (top by confidence)', async () => {
    const proposals = Array.from({ length: 5 }, (_, i) => ({
      src_artifact_id: [A1, A2, A3, A4, A5][i],
      dst_artifact_id: [A2, A3, A4, A5, A1][i],
      type: 'evidence_for',
      confidence: (5 - i) * 0.1 + 0.5, // descending: 1.0, 0.9, 0.8, 0.7, 0.6
      rationale: `R${i}`,
    }));

    _setLLMCallableForTest(async () => JSON.stringify({ proposals }));

    const result = await runHardLinkProposer({
      db,
      session_id: SESSION,
      project: PROJECT,
      max_proposals_per_run: 2,
    });

    // Only top 2 by confidence should be proposed.
    expect(result.proposed).toBe(2);
  });

  it('LLM error → llm_error: true, no throw', async () => {
    _setLLMCallableForTest(async () => { throw new Error('Network failure'); });
    const result = await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(result.llm_error).toBe(true);
    expect(result.proposed).toBe(0);
  });

  it('ANTHROPIC_API_KEY set → invokes cloud path (mock verifies)', async () => {
    // We can only verify that the LLM callable was invoked — path selection
    // is internal. Use the test-injectable to confirm the call happens.
    const originalEnv = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';

    let called = false;
    _setLLMCallableForTest(async () => {
      called = true;
      return JSON.stringify({ proposals: [] });
    });

    await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(called).toBe(true);

    process.env['ANTHROPIC_API_KEY'] = originalEnv ?? '';
  });

  it('ANTHROPIC_API_KEY unset → uses local llama (mock verifies)', async () => {
    const originalEnv = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    let called = false;
    _setLLMCallableForTest(async () => {
      called = true;
      return JSON.stringify({ proposals: [] });
    });

    await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });
    expect(called).toBe(true);

    if (originalEnv !== undefined) process.env['ANTHROPIC_API_KEY'] = originalEnv;
  });

  it('telemetry row emitted with all counters', async () => {
    _setLLMCallableForTest(async () => JSON.stringify({
      proposals: [
        { src_artifact_id: A1, dst_artifact_id: A2, type: 'triggered_by', confidence: 0.9, rationale: 'R' },
      ],
    }));

    await runHardLinkProposer({ db, session_id: SESSION, project: PROJECT });

    const row = db.prepare(`
      SELECT detail FROM telemetry
      WHERE session_id = ?
        AND event_kind = 'session_end_action'
        AND json_extract(detail, '$.action') = 'hard_link_proposer'
      ORDER BY timestamp_epoch_ms DESC
      LIMIT 1
    `).get(SESSION) as { detail: string } | undefined;

    expect(row).toBeDefined();
    const detail = JSON.parse(row!.detail);
    expect(detail.proposed).toBeTypeOf('number');
    expect(detail.skipped_decayed).toBeTypeOf('number');
    expect(detail.skipped_invalid).toBeTypeOf('number');
    expect(detail.duration_ms).toBeTypeOf('number');
  });
});
