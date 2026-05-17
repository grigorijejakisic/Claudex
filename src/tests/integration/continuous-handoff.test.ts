/**
 * Phase 14-07l — Integration tests for Continuous Handoff Refresh (CHR).
 *
 * Tests: full flow from watcher orchestration through handoff update and
 * soft-link emission. LLM is mocked; filesystem is real tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { initializeSchema } from '../../core/migrations.js';
import { writeHandoff } from '../../angel/handoff-writer.js';
import {
  classifyTurnAsDecisionBoundary,
  type WatcherContext,
} from '../../angel/handoff-decision-watcher.js';
import { parseHandoffHeader } from '../../angel/handoff-writer.js';

// ---------------------------------------------------------------------------
// Mock LLM classifier + project path resolution
// ---------------------------------------------------------------------------

vi.mock('../../intelligence/directive-detector.js', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    classifyDecisionBoundary: vi.fn(),
  };
});

vi.mock('../../shared/scope-detector.js', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    resolveProjectPath: vi.fn(),
  };
});

import { classifyDecisionBoundary } from '../../intelligence/directive-detector.js';
import { resolveProjectPath } from '../../shared/scope-detector.js';

const mockClassify = vi.mocked(classifyDecisionBoundary);
const mockResolveProjectPath = vi.mocked(resolveProjectPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Database.Database;
const PROJECT = 'integration-project';

function handoffsDir(): string {
  return path.join(tmpDir, 'context', 'handoffs');
}

function activePath(): string {
  return path.join(handoffsDir(), 'ACTIVE.md');
}

function readActive(): string {
  return fs.readFileSync(activePath(), 'utf8');
}

function seedHandoff(): void {
  fs.mkdirSync(handoffsDir(), { recursive: true });
  writeHandoff(activePath(), {
    status: 'active',
    phase: '14-07l',
    summary: 'CHR integration test',
    created_at_epoch_ms: 1779900000000,
    whatWeFound: 'Integration test setup complete.',
    whatWeDecided: 'No decisions yet.',
    whatsNext: 'Run integration tests.',
    whereToLook: 'src/tests/integration/continuous-handoff.test.ts',
  });
}

function makeCtx(overrides: Partial<WatcherContext> = {}): WatcherContext {
  return {
    db,
    project: PROJECT,
    session_id: 'integration-session-' + Date.now(),
    user_text: 'Operator message',
    assistant_text: 'Agent response',
    source_turn_uuid: 'integ-turn-' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-integ-'));
  db = new Database(':memory:');
  initializeSchema(db);
  mockResolveProjectPath.mockReturnValue(tmpDir);
  seedHandoff();
  vi.clearAllMocks();
  mockResolveProjectPath.mockReturnValue(tmpDir);
  delete process.env['CLAUDEX_CHR_DISABLED'];
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('continuous handoff refresh — full flow', () => {

  it('AC-1: stop hook flow: boundary detected → ACTIVE.md updated', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_pivot',
      summary: 'Operator pivoted to /team dispatch',
      confidence: 0.91,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });

    const ctx = makeCtx({
      user_text: 'actually let\'s go with /team',
      assistant_text: 'Switching to /team. Deployment plan: ...',
    });

    const result = await classifyTurnAsDecisionBoundary(ctx);
    expect(result.refreshed).toBe(true);
    expect(result.boundary_type).toBe('operator_pivot');

    const content = readActive();
    expect(content).toContain('[operator_pivot]');
    expect(content).toContain('Operator pivoted to /team dispatch');
    expect(content).toContain("**What's next:**");
  });

  it('AC-2: crash-resilience: no .tmp file left after successful refresh', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_confirm',
      summary: 'Deploy confirmed',
      confidence: 0.88,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });

    await classifyTurnAsDecisionBoundary(makeCtx());

    // No .tmp file should exist after atomic rename.
    expect(fs.existsSync(activePath() + '.tmp')).toBe(false);
  });

  it('AC-3: multi-turn: only boundary turns trigger refresh; non-boundaries don\'t', async () => {
    const nonBoundary = {
      is_decision_boundary: false,
      boundary_type: null,
      summary: null,
      confidence: 0.95,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    };
    const boundary = {
      is_decision_boundary: true,
      boundary_type: 'agent_position' as const,
      summary: 'Agent position: use Option A',
      confidence: 0.82,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    };

    // Turn 1: non-boundary.
    mockClassify.mockResolvedValueOnce(nonBoundary);
    const r1 = await classifyTurnAsDecisionBoundary(makeCtx({ source_turn_uuid: 'turn-1' }));
    expect(r1.refreshed).toBe(false);

    // Turn 2: non-boundary.
    mockClassify.mockResolvedValueOnce(nonBoundary);
    const r2 = await classifyTurnAsDecisionBoundary(makeCtx({ source_turn_uuid: 'turn-2' }));
    expect(r2.refreshed).toBe(false);

    // Turn 3: boundary.
    mockClassify.mockResolvedValueOnce(boundary);
    const r3 = await classifyTurnAsDecisionBoundary(makeCtx({ source_turn_uuid: 'turn-3' }));
    expect(r3.refreshed).toBe(true);

    const content = readActive();
    expect(content).toContain('[agent_position]');
    // Non-boundary entries should not appear.
    expect((content.match(/\[agent_position\]/g) ?? []).length).toBe(1);
  });

  it('AC-4: refresh chain: two refreshes both update the handoff (throttle reset between)', async () => {
    // First refresh.
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_confirm',
      summary: 'First boundary',
      confidence: 0.80,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });
    const sessionId = 'chain-session-' + Date.now();
    const ctx1 = makeCtx({ session_id: sessionId, source_turn_uuid: 'turn-chain-1' });
    const r1 = await classifyTurnAsDecisionBoundary(ctx1);
    expect(r1.refreshed).toBe(true);

    // Manually clear throttle to allow second refresh.
    db.prepare(`DELETE FROM handoff_refresh_state WHERE session_id = ?`).run(sessionId);

    // Second refresh.
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'spec_change',
      summary: 'Spec updated on second turn',
      confidence: 0.78,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });
    const ctx2 = makeCtx({ session_id: sessionId, source_turn_uuid: 'turn-chain-2' });
    const r2 = await classifyTurnAsDecisionBoundary(ctx2);
    expect(r2.refreshed).toBe(true);

    const content = readActive();
    expect(content).toContain('[operator_confirm]');
    expect(content).toContain('[spec_change]');
    expect(content).toContain('First boundary');
    expect(content).toContain('Spec updated on second turn');
  });

  it('AC-5: cross-project: projectB handoff not updated by projectA ctx', async () => {
    // Seed a second project handoff in a separate dir.
    const projectBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-project-b-'));
    try {
      const projectBHandoffsDir = path.join(projectBDir, 'context', 'handoffs');
      fs.mkdirSync(projectBHandoffsDir, { recursive: true });
      writeHandoff(path.join(projectBHandoffsDir, 'ACTIVE.md'), {
        status: 'active',
        phase: '14',
        summary: 'Project B handoff',
        created_at_epoch_ms: 1779900001000,
        whatWeFound: 'Project B state.',
        whatWeDecided: 'Project B decision.',
        whatsNext: 'Project B next step.',
        whereToLook: 'Project B location',
      });

      const projectBOriginal = fs.readFileSync(path.join(projectBHandoffsDir, 'ACTIVE.md'), 'utf8');

      // resolveProjectPath for projectA returns tmpDir (already mocked).
      // Simulate: a boundary for projectA should only update projectA's ACTIVE.md.
      mockClassify.mockResolvedValueOnce({
        is_decision_boundary: true,
        boundary_type: 'operator_confirm',
        summary: 'Project A boundary',
        confidence: 0.85,
        prompt_version: 'v1',
        llm_model: 'llama3.1:8b',
      });

      const ctx = makeCtx({ project: PROJECT }); // projectA
      await classifyTurnAsDecisionBoundary(ctx);

      // Project A's ACTIVE.md should be updated.
      expect(readActive()).toContain('[operator_confirm]');

      // Project B's ACTIVE.md should be unchanged.
      const projectBAfter = fs.readFileSync(path.join(projectBHandoffsDir, 'ACTIVE.md'), 'utf8');
      expect(projectBAfter).toBe(projectBOriginal);
    } finally {
      fs.rmSync(projectBDir, { recursive: true, force: true });
    }
  });

  it('AC-6: CLAUDEX_CHR_DISABLED: CHR completely off for entire session', async () => {
    process.env['CLAUDEX_CHR_DISABLED'] = '1';

    const originalContent = readActive();
    const ctx = makeCtx();
    const result = await classifyTurnAsDecisionBoundary(ctx);

    expect(result.refreshed).toBe(false);
    expect(result.throttled).toBe(false);
    expect(mockClassify).not.toHaveBeenCalled();

    // ACTIVE.md must be unchanged.
    expect(readActive()).toBe(originalContent);
  });

  it('header last_refresh_epoch_ms is updated after refresh', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_confirm',
      summary: 'Confirmed ship plan',
      confidence: 0.90,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });

    const before = Date.now();
    await classifyTurnAsDecisionBoundary(makeCtx());
    const after = Date.now();

    const header = parseHandoffHeader(readActive());
    expect(header).not.toBeNull();
    expect(header!.last_refresh_epoch_ms).toBeDefined();
    expect(header!.last_refresh_epoch_ms!).toBeGreaterThanOrEqual(before);
    expect(header!.last_refresh_epoch_ms!).toBeLessThanOrEqual(after);
  });

  it('created_at_epoch_ms is preserved across CHR refresh', async () => {
    mockClassify.mockResolvedValueOnce({
      is_decision_boundary: true,
      boundary_type: 'operator_pivot',
      summary: 'Pivoted to Option B',
      confidence: 0.85,
      prompt_version: 'v1',
      llm_model: 'llama3.1:8b',
    });

    await classifyTurnAsDecisionBoundary(makeCtx());
    const header = parseHandoffHeader(readActive());
    // The seeded handoff has created_at_epoch_ms = 1779900000000.
    expect(header!.created_at_epoch_ms).toBe(1779900000000);
  });
});
