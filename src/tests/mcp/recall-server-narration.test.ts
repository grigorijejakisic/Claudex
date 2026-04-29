/**
 * Phase 8.5 — MCP server narration directive integration tests.
 *
 * Verifies:
 *   - The static CLAUDEX_INSTRUCTIONS string contains the narration directive
 *     (asserted via __getInstructionsForTesting seam).
 *   - setNarrationSilent / isNarrationSilent round-trip via the seam helpers.
 *
 * Test seam pattern follows recall-server-pointer-log.test.ts (Phase 5.5):
 * exercise the helpers directly rather than booting the MCP server process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../core/migrations.js';
import {
  isNarrationSilent,
  setNarrationSilent,
} from '../../intelligence/narration-directive.js';
import { __getInstructionsForTesting } from '../../mcp/recall-server.js';

describe('MCP server narration directive integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('CLAUDEX_INSTRUCTIONS contains the narration directive header', () => {
    const instructions = __getInstructionsForTesting();
    expect(instructions).toContain('When You Recall');
  });

  it('CLAUDEX_INSTRUCTIONS contains all 3 advisory-voice templates', () => {
    const instructions = __getInstructionsForTesting();
    expect(instructions).toContain('no prior experience');
    expect(instructions).toContain('going in cold');
    expect(instructions).toContain('checking');
    expect(instructions).toContain('applying');
    expect(instructions).toContain('some prior context');
  });

  it('setNarrationSilent + isNarrationSilent round-trip via the registered helpers', () => {
    expect(isNarrationSilent(db, 'sess-mcp-1')).toBe(false);
    setNarrationSilent(db, 'sess-mcp-1', true);
    expect(isNarrationSilent(db, 'sess-mcp-1')).toBe(true);
    setNarrationSilent(db, 'sess-mcp-1', false);
    expect(isNarrationSilent(db, 'sess-mcp-1')).toBe(false);
  });

  it('toggle is per-session — setting one does not affect another', () => {
    setNarrationSilent(db, 'sess-A', true);
    expect(isNarrationSilent(db, 'sess-A')).toBe(true);
    expect(isNarrationSilent(db, 'sess-B')).toBe(false);
  });

  it('CLAUDEX_INSTRUCTIONS still contains the existing Claudex sections (no regression)', () => {
    const instructions = __getInstructionsForTesting();
    expect(instructions).toContain('## When to Use Claudex Tools');
    expect(instructions).toContain('## Navigation Rule');
    expect(instructions).toContain('## Safety');
  });
});
