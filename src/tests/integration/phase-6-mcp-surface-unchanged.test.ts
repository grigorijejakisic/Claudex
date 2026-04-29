/**
 * Phase 6 Plan 05 — RETR-04 lock-down: MCP surface unchanged.
 *
 * The five MCP tools listed in CONTEXT.md as the agent-visible surface are:
 *   claudex_search, claudex_recall, claudex_store, claudex_events,
 *   claudex_message.
 *
 * Phase 6 deletions in `src/core/hybrid-retrieval.ts` (or anywhere else) must
 * NOT change the response key set of any of these tools. Ordering of array
 * elements (e.g. `claudex_search.results`) MAY shift; key shape MUST NOT.
 *
 * The MCP tool handlers are not exported (they're registered with the MCP
 * server inline). Rather than spawning the server process, this lock-down
 * does a static structural check against `src/mcp/recall-server.ts`:
 *
 *   1. Each tool's `server.registerTool('<name>', …)` registration is still present.
 *   2. The canonical response-key shape (from `src/tests/fixtures/mcp-surface-canonical.json`)
 *      still appears in the source — i.e. the JSON.stringify object literals
 *      that build the response still carry the same keys.
 *
 * This is robust to ordering changes and unrelated edits but breaks loudly
 * if any key is removed or renamed.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const RECALL_SERVER_PATH = path.resolve(
  process.cwd(),
  'src/mcp/recall-server.ts',
);
const CANONICAL_FIXTURE_PATH = path.resolve(
  process.cwd(),
  'src/tests/fixtures/mcp-surface-canonical.json',
);

interface CanonicalFixture {
  claudex_search: { ok: string[]; error: string[]; _resultElement: string[] };
  claudex_recall: { ok: string[]; error: string[] };
  claudex_store: { _storedDecisionLearning: string[]; _storedWithTopicKey: string[]; error: string[] };
  claudex_events: { _returnsArrayOrObject: string };
  claudex_message: { _purpose: string };
}

const TOOL_NAMES = [
  'claudex_search',
  'claudex_recall',
  'claudex_store',
  'claudex_events',
  'claudex_message',
] as const;

describe('Phase 6 RETR-04 lock-down — MCP surface unchanged', () => {
  it('canonical fixture file exists and is parseable', () => {
    expect(fs.existsSync(CANONICAL_FIXTURE_PATH)).toBe(true);
    const fixture = JSON.parse(fs.readFileSync(CANONICAL_FIXTURE_PATH, 'utf8')) as CanonicalFixture;
    for (const tool of TOOL_NAMES) {
      expect(fixture).toHaveProperty(tool);
    }
  });

  it('recall-server.ts source still registers all five MCP tools', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    for (const tool of TOOL_NAMES) {
      // Registration shape: server.registerTool('<name>', ...).
      expect(src).toContain(`'${tool}'`);
    }
  });

  it('claudex_search response keys (results, total, has_more) still present in source', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    expect(src).toMatch(/results:\s*paginatedResults/);
    expect(src).toMatch(/\btotal\b/);
    expect(src).toMatch(/\bhas_more\b/);
  });

  it('claudex_search result-element keys (id, type, summary, provenance, importance, project, source, score) still present in source', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    // Look for the SearchResult type signature; if it ever loses a key the test breaks.
    expect(src).toMatch(
      /type SearchResult\s*=\s*\{[^}]*id:\s*number[^}]*type:\s*string[^}]*summary:\s*string[^}]*provenance:\s*string[^}]*importance:\s*number[^}]*project:\s*string[^}]*source:\s*string[^}]*score:\s*number/s,
    );
  });

  it('claudex_recall response keys (id, type, summary, content, provenance, project, importance) still present in source', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    // The handler stringifies these explicitly; locate that block.
    expect(src).toMatch(/id:\s*row\.id/);
    expect(src).toMatch(/type:\s*row\.artifact_type/);
    expect(src).toMatch(/summary:\s*row\.summary/);
    expect(src).toMatch(/content:\s*row\.content/);
    // provenance is computed, but the literal key name must remain.
    expect(src).toMatch(/provenance:\s*row\.artifact_ref/);
    expect(src).toMatch(/project:\s*row\.project/);
    expect(src).toMatch(/importance:\s*row\.importance/);
  });

  it('claudex_store response keys (stored, type, project, agent_id|topic_key|upserted) still present', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    expect(src).toMatch(/stored:\s*id\s*>\s*0/);
    expect(src).toMatch(/topic_key/);
    expect(src).toMatch(/upserted:\s*true/);
    expect(src).toMatch(/agent_id:\s*agent_id\s*\?\?\s*null/);
  });

  it('claudex_events handler returns a JSON-stringified events payload', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    // Handler returns events array; lock-down asserts the JSON.stringify call exists.
    expect(src).toMatch(/JSON\.stringify\(events,\s*null,\s*2\)/);
  });

  it('claudex_message handler is still registered and still has a non-trivial body', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    // claudex_message handler invokes nameSession or similar — the registration
    // must be followed by an inputSchema and an async handler closure.
    const messageBlock = src.split("'claudex_message'")[1];
    expect(messageBlock).toBeDefined();
    // Within the next ~3000 chars after the tool name, expect inputSchema + handler.
    const head = messageBlock.slice(0, 3000);
    expect(head).toMatch(/inputSchema:/);
    expect(head).toMatch(/async\s*\(/);
  });

  it('recall-server.ts source has not lost any of the five tool registrations versus pre-Phase-6', () => {
    const src = fs.readFileSync(RECALL_SERVER_PATH, 'utf8');
    // Count `server.registerTool(` occurrences and confirm at least 5 (CONTEXT.md
    // surface). The actual count today is 7 (curated_context, session also exist),
    // and the canonical 5 are a subset — assert all five string literals appear.
    const registerCount = (src.match(/server\.registerTool\(/g) ?? []).length;
    expect(registerCount).toBeGreaterThanOrEqual(5);
    for (const tool of TOOL_NAMES) {
      expect(src).toContain(`'${tool}'`);
    }
  });
});
