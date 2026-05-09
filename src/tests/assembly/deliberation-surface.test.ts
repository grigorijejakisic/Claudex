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
    // POLISH-02 — bi-encoder-only path emits the locked low-confidence header.
    // This fixture mocks Ollama only (no cross-encoder), so routing.bi_encoder_only=true.
    expect(result!.startsWith('## Deliberation Surfaced')).toBe(true);
    expect(result!).toContain('low-confidence retrieval');
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

// ---------------------------------------------------------------------------
// 8. POLISH-02 — appendDeliberationSurfaceToPayload preserves commitEffects
// ---------------------------------------------------------------------------

describe('appendDeliberationSurfaceToPayload — preserves commitEffects via spread (Gemini Assembly Finding #1)', () => {
  it('returns a payload whose commitEffects is the same function reference as the input', async () => {
    const { appendDeliberationSurfaceToPayload } = await import('../../assembly/assembler.js');
    const { loadConfig } = await import('../../shared/config.js');
    const db = freshV32Db();
    seedChunks(db, 'sess-spread', 3);

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (input: string | URL | Request, init?: RequestInit) => {
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
      }) as typeof fetch,
    );

    const flushSpy = vi.fn();
    const inputPayload = {
      content: 'existing context content',
      tokenEstimate: 100,
      sources: ['l1_identity'],
      commitEffects: flushSpy, // load-bearing — must survive the surface mutation
    };

    const result = await appendDeliberationSurfaceToPayload(inputPayload, {
      db,
      project: 'test-project',
      projectDir: '/test',
      config: loadConfig(),
      sessionId: 'caller-session',
      contextWindowTokens: 200_000,
      deliberationSurfacing: true,
      deliberationArtifacts: [
        { session_id: 'sess-spread', created_at_epoch_ms: BASE_TIME + 60_000, query_text: 'q' },
      ],
    });

    // Spread preserved commitEffects as the SAME reference.
    expect(result.commitEffects).toBe(flushSpy);
    expect(result.content).toContain('existing context content');
    expect(result.content).toContain('## Deliberation Surfaced');
    expect(result.sources).toContain('deliberation_surface');
    expect(result.sources).toContain('l1_identity'); // existing source preserved
    db.close();
  });

  it('opt-out fast-path returns the original payload reference (no spread mutation)', async () => {
    const { appendDeliberationSurfaceToPayload } = await import('../../assembly/assembler.js');
    const { loadConfig } = await import('../../shared/config.js');
    const db = freshV32Db();

    const flushSpy = vi.fn();
    const inputPayload = {
      content: 'unchanged',
      tokenEstimate: 50,
      sources: ['l1_identity'],
      commitEffects: flushSpy,
    };

    const result = await appendDeliberationSurfaceToPayload(inputPayload, {
      db,
      project: 'test-project',
      projectDir: '/test',
      config: loadConfig(),
      sessionId: 'caller-session',
      contextWindowTokens: 200_000,
      // deliberationSurfacing left undefined — opt-out path
    });

    // Opt-out: same payload back, commitEffects intact.
    expect(result.commitEffects).toBe(flushSpy);
    expect(result.content).toBe('unchanged');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 9. POLISH-02 — async contract guard (Gemini Assembly Finding #2)
// ---------------------------------------------------------------------------

describe('appendDeliberationSurfaceToPayload — async contract guard (Gemini Assembly Finding #2)', () => {
  it('returns a Promise (not a raw payload) so sync callers cannot accidentally inject [object Promise]', async () => {
    const { appendDeliberationSurfaceToPayload } = await import('../../assembly/assembler.js');
    const { loadConfig } = await import('../../shared/config.js');
    const db = freshV32Db();

    const inputPayload = {
      content: 'foo',
      tokenEstimate: 10,
      sources: [],
    };

    const ret = appendDeliberationSurfaceToPayload(inputPayload, {
      db,
      project: 'test-project',
      projectDir: '/test',
      config: loadConfig(),
      sessionId: 'caller-session',
      contextWindowTokens: 200_000,
    });

    // Must be a Promise — TypeScript signature already enforces this; the runtime
    // assertion documents the contract Gemini flagged: a sync caller invoking
    // this function without `await` MUST receive a Promise so the `[object Promise]`
    // injection bug is impossible (the consumer dereferencing `.content` on a
    // Promise raises a clear TypeError, not a silent string concatenation).
    expect(ret).toBeInstanceOf(Promise);
    const result = await ret;
    expect(result.content).toBe('foo'); // opt-out preserved the input
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 10. POLISH-02 — bi-encoder-only emits low-confidence header (Gemini Assembly Finding #3)
// ---------------------------------------------------------------------------

describe('formatDeliberationSurface — bi-encoder-only emits low-confidence-retrieval header (Gemini Assembly Finding #3)', () => {
  it('renders the locked low-confidence-retrieval header when bi_encoder_only=true', () => {
    const spans: RoutingSpan[] = [
      makeSpan(1, 's1', 0, 'b1'),
      makeSpan(2, 's2', 1, 'b2'),
    ];
    spans.forEach((s) => (s.ranker = 'bi_encoder'));
    const routing: RoutingResult = { spans, bi_encoder_only: true, candidate_count: 2 };
    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000,
    });
    expect(result.text).not.toBeNull();
    expect(result.text).toContain('## Deliberation Surfaced (low-confidence retrieval)');
    expect(result.text).not.toContain(' spans from ');
    expect(result.bi_encoder_budget_applied).toBe(true);
  });

  it('renders the N-spans-from-M-sessions header when bi_encoder_only=false', () => {
    const spans: RoutingSpan[] = [
      makeSpan(1, 's1', 0, 'b1'),
      makeSpan(2, 's2', 1, 'b2'),
    ];
    const routing: RoutingResult = { spans, bi_encoder_only: false, candidate_count: 2 };
    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens: 10_000,
    });
    expect(result.text).not.toBeNull();
    expect(result.text).toContain('## Deliberation Surfaced — 2 spans from 2 sessions');
    expect(result.text).not.toContain('low-confidence');
    expect(result.bi_encoder_budget_applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. POLISH-02 — token budget pre-deducts header + separator overhead (Gemini Assembly Finding #4)
// ---------------------------------------------------------------------------

describe('formatDeliberationSurface — token budget pre-deducts header + separator overhead (Gemini Assembly Finding #4)', () => {
  it('total surface tokens stay under cap even when greedy-pack would over-pack the gross budget', async () => {
    const { estimateTokens } = await import('../../shared/text-utils.js');
    // 15% of 2000 = 300 tokens cap (cross-encoder confirmed path)
    const totalAssemblyBudgetTokens = 2000;
    // Build many small spans whose sum exceeds the gross cap once header+separators are added.
    // 30-token bodies × 12 spans = 360 tokens; without pre-deduct, all 12 fit (300 cap → 360 over).
    // Header (~10) + 12 separators (~6 each = 72) = 82 overhead → actual rendered would be ~442 > 300.
    // With pre-deduct: packBudget = 300 - 82 = 218; loop fits ~7 spans (210 body) → rendered ≤ 300.
    const longBody = 'word '.repeat(30).trim();
    const spans: RoutingSpan[] = [];
    for (let i = 0; i < 12; i++) {
      spans.push({
        chunk_id: i,
        session_id: 's1',
        turn_index: i,
        sub_index: 0,
        role: 'assistant',
        body: longBody,
        created_at_epoch_ms: BASE_TIME + i * 60_000,
        rank_score: 1 - i * 0.05,
        ranker: 'cross_encoder',
      });
    }
    const routing: RoutingResult = { spans, bi_encoder_only: false, candidate_count: 12 };

    const result = formatDeliberationSurface(routing, {
      enabled: true,
      totalAssemblyBudgetTokens,
    });

    expect(result.text).not.toBeNull();
    const renderedTokens = estimateTokens(result.text!);
    const cap = Math.floor(totalAssemblyBudgetTokens * 15 / 100);
    expect(renderedTokens).toBeLessThanOrEqual(cap);
  });
});
