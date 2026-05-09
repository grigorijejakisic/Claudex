/**
 * Phase 10 Plan 10-02 — vitest coverage of the v6 assembly layer.
 *
 * Truths 1, 2, 3, 5, 6 hit the pure formatter (no DB / no network).
 * Truths 4, 7 hit `formatDeliberationSurfaceSection` against an in-memory
 * V32 DB seeded via the production write surface (upsertChunk); only the
 * network seams are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initializeSchema } from '../../core/migrations.js';
import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import {
  formatDeliberationSurface,
  type DeliberationSurfaceOptions,
} from '../../assembly/deliberation-surface.js';
import { formatDeliberationSurfaceSection } from '../../assembly/sections.js';
import type { RoutingResult, RoutingSpan } from '../../retrieval/transcript-routing.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-asm-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSpan(
  chunkId: number,
  sessionId: string,
  turnIndex: number,
  body: string,
): RoutingSpan {
  return {
    chunk_id: chunkId,
    session_id: sessionId,
    turn_index: turnIndex,
    sub_index: 0,
    role: 'assistant',
    body,
    created_at_epoch_ms: BASE_TIME + turnIndex * 60_000,
    rank_score: 1 - turnIndex * 0.1,
    ranker: 'cross_encoder',
  };
}

function freshV32Db(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function seedChunks(db: Database.Database, sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    upsertChunk(db, {
      session_id: sessionId,
      project_id: 'test-project',
      turn_index: i,
      sub_index: 0,
      role: i % 2 === 0 ? 'user' : 'assistant',
      provenance: 'organic',
      body: `Synthetic chunk #${i} body for ${sessionId}.`,
      created_at_epoch_ms: BASE_TIME + i * 60_000,
      wrapper_redacted: false,
    });
  }
}

// ---------------------------------------------------------------------------
// 1. Labeled citations format per CONTEXT § specifics
// ---------------------------------------------------------------------------

describe('formatDeliberationSurface — labeled citations format per CONTEXT § specifics', () => {
  it('renders "From session X turn N, where {label}: {body}" for each span', () => {
    const spans = [
      makeSpan(11, 'sess-1', 47, 'Phase 2.1 KILL outcome rationale ...'),
      makeSpan(22, 'sess-2', 12, 'sqlite-vec single-store decision ...'),
    ];
    const routing: RoutingResult = { spans, bi_encoder_only: false, candidate_count: 2 };
    const labels: Record<number, string> = {
      11: 'Phase 2.1 KILL was decided',
      22: 'sqlite-vec migration completed',
    };

    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000,
      artifactLabels: labels,
    });

    expect(result.text).not.toBeNull();
    expect(result.text).toContain('From session sess-1 turn 47, where Phase 2.1 KILL was decided: Phase 2.1 KILL outcome rationale ...');
    expect(result.text).toContain('From session sess-2 turn 12, where sqlite-vec migration completed: sqlite-vec single-store decision ...');
  });
});

// ---------------------------------------------------------------------------
// 2. Advisory narration line shape
// ---------------------------------------------------------------------------

describe('formatDeliberationSurface — advisory narration line shape', () => {
  it('emits "## Deliberation Surfaced — {N} spans from {M} sessions" header', () => {
    const spans = [
      makeSpan(1, 'sess-A', 0, 'span 1'),
      makeSpan(2, 'sess-A', 1, 'span 2'),
      makeSpan(3, 'sess-B', 0, 'span 3'),
    ];
    const routing: RoutingResult = { spans, bi_encoder_only: false, candidate_count: 3 };
    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000,
    });
    expect(result.text).not.toBeNull();
    expect(result.text!.startsWith('## Deliberation Surfaced — 3 spans from 2 sessions')).toBe(true);
  });

  it('uses singular "span" / "session" when N=1 / M=1', () => {
    const spans = [makeSpan(1, 'sess-only', 0, 'one span')];
    const routing: RoutingResult = { spans, bi_encoder_only: false, candidate_count: 1 };
    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000,
    });
    expect(result.text!.startsWith('## Deliberation Surfaced — 1 span from 1 session')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Token-budget asymmetry between cross-encoder and bi-encoder paths
// ---------------------------------------------------------------------------

describe('formatDeliberationSurface — token budget asymmetry', () => {
  it('packs more spans on cross-encoder path than on bi-encoder-only path', () => {
    // Build spans of equal byte-length so token cost is uniform.
    const spanBody = 'x'.repeat(800); // ~200 tokens via chars/4 estimate
    const spans = Array.from({ length: 5 }, (_, i) => makeSpan(i, 'sess-budget', i, spanBody));

    const ceRouting: RoutingResult = { spans, bi_encoder_only: false, candidate_count: 5 };
    const biRouting: RoutingResult = { spans, bi_encoder_only: true, candidate_count: 5 };
    const opts: DeliberationSurfaceOptions = {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000, // 15% = 1500 tokens; bi: 7.5% = 750
    };

    const ce = formatDeliberationSurface(ceRouting, opts);
    const bi = formatDeliberationSurface(biRouting, opts);

    expect(ce.bi_encoder_budget_applied).toBe(false);
    expect(bi.bi_encoder_budget_applied).toBe(true);
    // Cross-encoder path packs strictly more spans than bi-encoder-only path.
    expect(ce.packed.length).toBeGreaterThan(bi.packed.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Opt-in via enabled flag (formatDeliberationSurfaceSection wrapper)
// ---------------------------------------------------------------------------

describe('formatDeliberationSurfaceSection — opt-in via enabled flag', () => {
  it('returns null and makes no routing call when enabled=false', async () => {
    const db = freshV32Db();
    seedChunks(db, 'sess-optin', 3);
    let fetchCalls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      fetchCalls++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch);

    const result = await formatDeliberationSurfaceSection(
      db,
      [{ session_id: 'sess-optin', created_at_epoch_ms: BASE_TIME, query_text: 'q' }],
      { enabled: false, totalAssemblyBudgetTokens: 10_000 },
    );

    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
    db.close();
  });

  it('returns a section when enabled=true with seeded chunks', async () => {
    const db = freshV32Db();
    seedChunks(db, 'sess-optin', 3);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('11434/api/embed')) {
        const body = init?.body ? JSON.parse(String(init.body)) : { input: [] };
        const texts: string[] = body.input ?? [];
        return new Response(
          JSON.stringify({ embeddings: texts.map(() => Array(1024).fill(0.001)) }),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch);

    const result = await formatDeliberationSurfaceSection(
      db,
      [{ session_id: 'sess-optin', created_at_epoch_ms: BASE_TIME + 60_000, query_text: 'q' }],
      { enabled: true, totalAssemblyBudgetTokens: 10_000 },
    );

    expect(result).not.toBeNull();
    expect(result!.startsWith('## Deliberation Surfaced —')).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Empty spans returns null (no empty header)
// ---------------------------------------------------------------------------

describe('formatDeliberationSurface — empty spans returns null', () => {
  it('returns null with no header when routing produced zero spans', () => {
    const routing: RoutingResult = { spans: [], bi_encoder_only: true, candidate_count: 0 };
    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000,
    });
    expect(result.text).toBeNull();
    expect(result.packed.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Greedy packing drops overflow spans silently
// ---------------------------------------------------------------------------

describe('formatDeliberationSurface — greedy packing drops overflow silently', () => {
  it('skips a span that would overflow the budget but continues scanning', () => {
    const small = 'x'.repeat(80); // ~20 tokens via chars/4
    const huge = 'y'.repeat(20_000); // ~5000 tokens
    const spans = [
      makeSpan(1, 'sess-greed', 0, small),
      makeSpan(2, 'sess-greed', 1, small),
      makeSpan(3, 'sess-greed', 2, huge),
      makeSpan(4, 'sess-greed', 3, small),
      makeSpan(5, 'sess-greed', 4, small),
    ];
    const routing: RoutingResult = { spans, bi_encoder_only: false, candidate_count: 5 };
    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000, // 15% = 1500 tokens
    });
    expect(result.packed.length).toBe(4);
    // Huge span (chunk_id=3) was dropped silently
    expect(result.packed.map((s) => s.chunk_id)).not.toContain(3);
  });
});

// ---------------------------------------------------------------------------
// 7. Integration site landed at the L2.5 cascade position
// ---------------------------------------------------------------------------

describe('formatDeliberationSurfaceSection — integration at L2.5 cascade position', () => {
  it('assembler.ts wires formatDeliberationSurfaceSection into the cascade', () => {
    const assemblerPath = path.resolve(__dirname, '../../assembly/assembler.ts');
    const assemblerSrc = fs.readFileSync(assemblerPath, 'utf8');
    expect(assemblerSrc).toContain('formatDeliberationSurfaceSection');
    expect(assemblerSrc).toContain('appendDeliberationSurfaceToPayload');
  });

  it('.claude/rules/assembly-budget.md documents the L2.5 cascade slot', () => {
    const rulePath = path.resolve(__dirname, '../../../.claude/rules/assembly-budget.md');
    const ruleSrc = fs.readFileSync(rulePath, 'utf8');
    expect(ruleSrc).toContain('L2.5 | Deliberation Surface');
  });
});
