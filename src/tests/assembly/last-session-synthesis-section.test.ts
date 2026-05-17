/**
 * Phase 14-07k — Last-Session Synthesis section formatter tests.
 *
 * Coverage (7 tests):
 *  1. Empty when no synthesis row exists
 *  2. Renders correctly when synthesis present
 *  3. Empty + telemetry when body is malformed JSON
 *  4. Degraded annotation shown when synthesis.degraded === true
 *  5. Project scoping: project A synthesis does not appear in project B render
 *  6. Token cap: long synthesis truncated to ~400 tokens
 *  7. Truncation favors most-recent pivots/positions (by at_turn desc)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import { formatLastSessionSynthesisSection } from '../../assembly/sections/last-session-synthesis.js';
import { deriveSynthesisArtifactId } from '../../angel/last-session-synthesis.js';
import type { LastSessionSynthesis } from '../../angel/last-session-synthesis.js';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function insertSynthesisArtifact(
  db: Database.Database,
  sessionId: string,
  project: string,
  synthesis: LastSessionSynthesis,
  createdMs = Date.now(),
): void {
  const id = deriveSynthesisArtifactId(sessionId);
  const title = (synthesis.operator_pivots[0]?.pivot_summary ?? 'Session synthesis').slice(0, 80);
  db.prepare(`
    INSERT OR REPLACE INTO artifact
      (id, kind, project, title, body, status, created_at_epoch_ms, updated_at_epoch_ms, session_id)
    VALUES (?, 'session_synthesis', ?, ?, ?, 'active', ?, ?, ?)
  `).run(id, project, title, JSON.stringify(synthesis), createdMs, Date.now(), sessionId);
}

function buildSynthesis(overrides: Partial<LastSessionSynthesis> = {}): LastSessionSynthesis {
  return {
    schema_version: 1,
    session_id: 'sess-001',
    operator_pivots: [{ at_turn: 3, pivot_summary: 'Chose the worker-spawn pattern' }],
    agent_positions: [{ at_turn: 4, position_summary: 'Recommended worker-spawn over sequential' }],
    last_unresolved_question: null,
    recommended_next_action: 'Spawn Wave 1 workers',
    confidence: 0.88,
    prompt_version: 'v1',
    llm_model: 'llama3.1:8b',
    generated_at_epoch_ms: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatLastSessionSynthesisSection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // Test 1: empty when no synthesis row exists
  it('returns empty string when no synthesis row exists', () => {
    const result = formatLastSessionSynthesisSection({ db, project: 'project-a' });
    expect(result).toBe('');
  });

  // Test 2: renders correctly when synthesis present
  it('renders correctly when synthesis exists with valid body', () => {
    const synthesis = buildSynthesis();
    insertSynthesisArtifact(db, 'sess-001', 'project-a', synthesis);

    const result = formatLastSessionSynthesisSection({ db, project: 'project-a' });

    expect(result).toContain('## Last Session — Synthesis');
    expect(result).toContain('Operator\'s pivots:');
    expect(result).toContain('Chose the worker-spawn pattern');
    expect(result).toContain('Agent\'s positions:');
    expect(result).toContain('Recommended worker-spawn over sequential');
    expect(result).toContain('**Unresolved:** —');
    expect(result).toContain('**Next action:** Spawn Wave 1 workers');
  });

  // Test 3: empty + telemetry when body is malformed JSON
  it('returns empty string when body is malformed JSON', () => {
    const id = deriveSynthesisArtifactId('malformed-sess');
    db.prepare(`
      INSERT INTO artifact
        (id, kind, project, title, body, status, created_at_epoch_ms, updated_at_epoch_ms, session_id)
      VALUES (?, 'session_synthesis', 'project-a', 'Bad', 'this is not json!!!', 'active', ?, ?, ?)
    `).run(id, Date.now(), Date.now(), 'malformed-sess');

    const result = formatLastSessionSynthesisSection({ db, project: 'project-a' });
    expect(result).toBe('');

    // Telemetry row emitted
    const rows = db.prepare(
      `SELECT COUNT(*) as cnt FROM session_events WHERE event_type = 'lss_render_failed'`
    ).get() as { cnt: number };
    expect(rows.cnt).toBeGreaterThan(0);
  });

  // Test 4: degraded annotation shown
  it('shows low-confidence annotation when synthesis.degraded === true', () => {
    const synthesis = buildSynthesis({ confidence: 0.4, degraded: true });
    insertSynthesisArtifact(db, 'sess-deg', 'project-a', synthesis);

    const result = formatLastSessionSynthesisSection({ db, project: 'project-a' });

    expect(result).toContain('[low-confidence synthesis');
  });

  // Test 5: project scoping — project A synthesis doesn't appear in project B
  it('project scoping: project A synthesis does not appear in project B', () => {
    const synthesis = buildSynthesis();
    insertSynthesisArtifact(db, 'sess-001', 'project-a', synthesis);

    const resultA = formatLastSessionSynthesisSection({ db, project: 'project-a' });
    const resultB = formatLastSessionSynthesisSection({ db, project: 'project-b' });

    expect(resultA).toContain('## Last Session — Synthesis');
    expect(resultB).toBe('');
  });

  // Test 6: token cap — long synthesis doesn't exceed ~400 tokens
  it('token cap: long synthesis stays within ~400-token budget', () => {
    // Build synthesis with many long pivots and positions
    const pivots = Array.from({ length: 20 }, (_, i) => ({
      at_turn: i,
      pivot_summary: `This is a very long pivot summary about what happened at turn ${i}. The operator made a decision about the architecture of the system.`,
    }));
    const positions = Array.from({ length: 20 }, (_, i) => ({
      at_turn: i,
      position_summary: `This is a very long agent position about what was recommended at turn ${i}. The agent provided detailed reasoning.`,
    }));

    const synthesis = buildSynthesis({ operator_pivots: pivots, agent_positions: positions });
    insertSynthesisArtifact(db, 'sess-long', 'project-a', synthesis);

    const result = formatLastSessionSynthesisSection({ db, project: 'project-a' });

    // Rough token estimate: 4 chars per token
    const roughTokens = result.length / 4;
    expect(roughTokens).toBeLessThanOrEqual(450); // Allow some buffer over 400
  });

  // Test 7: truncation favors most-recent pivots/positions (by at_turn desc)
  it('truncation favors most-recent pivots/positions by at_turn desc', () => {
    const pivots = [
      { at_turn: 1, pivot_summary: 'Early pivot at turn 1' },
      { at_turn: 5, pivot_summary: 'Middle pivot at turn 5' },
      { at_turn: 10, pivot_summary: 'Latest pivot at turn 10' },
    ];
    const positions = [
      { at_turn: 2, position_summary: 'Early position at turn 2' },
      { at_turn: 8, position_summary: 'Recent position at turn 8' },
    ];

    const synthesis = buildSynthesis({ operator_pivots: pivots, agent_positions: positions });
    insertSynthesisArtifact(db, 'sess-order', 'project-a', synthesis);

    const result = formatLastSessionSynthesisSection({ db, project: 'project-a' });

    // Most recent should appear
    expect(result).toContain('Latest pivot at turn 10');
    expect(result).toContain('Recent position at turn 8');
  });
});
