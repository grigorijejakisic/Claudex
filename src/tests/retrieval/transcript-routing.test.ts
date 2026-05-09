/**
 * Phase 10 Plan 10-01 — vitest coverage of the v6 routing surface.
 *
 * Covers the five must-have truths against an in-memory V32 DB seeded with
 * synthetic transcript_chunk_v6 rows via the production write surface
 * (upsertChunk). Only the network seams (Ollama embed + reranker /rerank)
 * are mocked. The routing module under test is NEVER mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initializeSchema } from '../../core/migrations.js';
import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import {
  routeFromArtifact,
  routeFromArtifacts,
  type RoutingArtifact,
} from '../../retrieval/transcript-routing.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function setHome(): void {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-routing-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
}

function restoreHome(): void {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

beforeEach(() => {
  setHome();
});

afterEach(() => {
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
  restoreHome();
});

function freshV32Db(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function seedChunks(
  db: Database.Database,
  sessionId: string,
  count: number,
  startMs: number = BASE_TIME,
): void {
  for (let i = 0; i < count; i++) {
    upsertChunk(db, {
      session_id: sessionId,
      project_id: 'test-project',
      turn_index: i,
      sub_index: 0,
      role: i % 2 === 0 ? 'user' : 'assistant',
      provenance: 'organic',
      body: `Synthetic chunk #${i} for ${sessionId} discussing the deliberation context.`,
      created_at_epoch_ms: startMs + i * 60_000,
      wrapper_redacted: false,
    });
  }
}

interface BiEncoderMockOptions {
  /** Per-text fixed cosine multipliers (length must match texts array). */
  embeddings?: number[][];
}

/**
 * Returns a fetch mock that responds to Ollama /api/embed with the given
 * embeddings array, and (optionally) handles reranker calls per option.
 */
function mockOllamaEmbed(
  perTextEmbeddings?: (textIdx: number) => number[],
  rerankerHandler?: (body: { query: string; documents: string[] }) => Response,
): ReturnType<typeof vi.spyOn> {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.includes('11434/api/embed')) {
        const texts: string[] = Array.isArray(body.input) ? body.input : [];
        const embeddings = perTextEmbeddings
          ? texts.map((_t, i) => perTextEmbeddings(i))
          : texts.map(() => Array(1024).fill(0.001));
        return new Response(JSON.stringify({ embeddings }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('7439/rerank') && rerankerHandler) {
        return rerankerHandler(body as { query: string; documents: string[] });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch,
  );
  return fetchSpy;
}

// ---------------------------------------------------------------------------
// 1. bi-encoder primary returns ranked chunks
// ---------------------------------------------------------------------------

describe('routeFromArtifact — bi-encoder primary returns ranked chunks', () => {
  it('returns top_k spans ranked by bi-encoder cosine for one artifact reference', async () => {
    const db = freshV32Db();
    const sessionId = 'sess-route-1';
    seedChunks(db, sessionId, 5);

    // Embedding 0 is the query; embeddings 1..N are candidates.
    // Stronger cosine for early candidates.
    mockOllamaEmbed((idx) => {
      const v = Array(1024).fill(0);
      // Query and first candidate align perfectly; later candidates diverge.
      if (idx === 0) v[0] = 1;
      else v[0] = 1 / idx; // 1, 0.5, 0.33, 0.25, 0.2 cosines
      return v;
    });

    const artifact: RoutingArtifact = {
      session_id: sessionId,
      created_at_epoch_ms: BASE_TIME + 2 * 60_000,
      query_text: 'why was X decided',
    };
    const result = await routeFromArtifact(db, artifact);

    expect(result.candidate_count).toBe(5);
    expect(result.spans.length).toBe(3); // default top_k_per_artifact
    expect(result.bi_encoder_only).toBe(true);
    for (const s of result.spans) {
      expect(s.ranker).toBe('bi_encoder');
      expect(s.session_id).toBe(sessionId);
    }
    // Sorted descending
    for (let i = 1; i < result.spans.length; i++) {
      expect(result.spans[i - 1].rank_score).toBeGreaterThanOrEqual(result.spans[i].rank_score);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. cross-encoder mode flag flips ranker source
// ---------------------------------------------------------------------------

describe('routeFromArtifact — cross-encoder mode flag flips ranker source', () => {
  it('routes via cross-encoder when reranker_mode=cross_encoder_primary', async () => {
    const db = freshV32Db();
    const sessionId = 'sess-route-ce';
    seedChunks(db, sessionId, 5);

    // Write user-config to flip reranker_mode.
    const cfgDir = path.join(tmpHome, '.claudex');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ v6: { routing: { reranker_mode: 'cross_encoder_primary' } } }),
    );

    let ollamaCalled = false;
    mockOllamaEmbed(
      (_idx) => {
        ollamaCalled = true;
        return Array(1024).fill(0.001);
      },
      // reranker handler — return descending scores
      () =>
        new Response(
          JSON.stringify({
            scores: [0.9, 0.7, 0.5, 0.3, 0.1],
            indices: [0, 1, 2, 3, 4],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );

    const artifact: RoutingArtifact = {
      session_id: sessionId,
      created_at_epoch_ms: BASE_TIME + 2 * 60_000,
      query_text: 'cross-encoder test',
    };
    const result = await routeFromArtifact(db, artifact);

    expect(result.bi_encoder_only).toBe(false);
    expect(result.spans.length).toBe(3);
    for (const s of result.spans) expect(s.ranker).toBe('cross_encoder');
    // Normalized to 0..1, descending
    expect(result.spans[0].rank_score).toBeCloseTo(1.0, 5); // 0.9 / 0.9
    for (let i = 1; i < result.spans.length; i++) {
      expect(result.spans[i - 1].rank_score).toBeGreaterThanOrEqual(result.spans[i].rank_score);
    }
    expect(ollamaCalled).toBe(false); // no fall-through
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. routeFromArtifacts respects max_k_per_query
// ---------------------------------------------------------------------------

describe('routeFromArtifacts — fan-out across N artifacts respects max_k_per_query', () => {
  it('caps the union of per-artifact spans at 12 and dedupes by chunk_id', async () => {
    const db = freshV32Db();
    const sessions = ['sess-A', 'sess-B', 'sess-C', 'sess-D', 'sess-E'];
    for (const s of sessions) seedChunks(db, s, 5);

    mockOllamaEmbed((idx) => {
      const v = Array(1024).fill(0);
      if (idx === 0) v[0] = 1;
      else v[0] = 1 / idx;
      return v;
    });

    const artifacts: RoutingArtifact[] = sessions.map((s, i) => ({
      session_id: s,
      created_at_epoch_ms: BASE_TIME + 2 * 60_000,
      query_text: `query for ${s}`,
    }));

    const result = await routeFromArtifacts(db, artifacts);

    // 5 sessions × 3 spans = 15 pre-cap → capped at 12
    expect(result.spans.length).toBe(12);
    // Sorted descending
    for (let i = 1; i < result.spans.length; i++) {
      expect(result.spans[i - 1].rank_score).toBeGreaterThanOrEqual(result.spans[i].rank_score);
    }
    // No duplicate chunk_ids
    const ids = result.spans.map((s) => s.chunk_id);
    expect(new Set(ids).size).toBe(ids.length);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. fallback path increments telemetry counter
// ---------------------------------------------------------------------------

describe('routeFromArtifact — fallback path increments telemetry counter', () => {
  function setupCePrimary(db: Database.Database, sessionId: string): RoutingArtifact {
    seedChunks(db, sessionId, 3);
    const cfgDir = path.join(tmpHome, '.claudex');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ v6: { routing: { reranker_mode: 'cross_encoder_primary' } } }),
    );
    return {
      session_id: sessionId,
      created_at_epoch_ms: BASE_TIME + 60_000,
      query_text: 'fallback test',
    };
  }

  function readFallbackRows(db: Database.Database, sessionId: string): Array<{ detail: string }> {
    return db
      .prepare(
        `SELECT detail FROM telemetry
           WHERE event_kind = 'reranker_fallback' AND session_id = ?`,
      )
      .all(sessionId) as Array<{ detail: string }>;
  }

  it('records non_2xx when reranker returns 503', async () => {
    const db = freshV32Db();
    const artifact = setupCePrimary(db, 'sess-fb-503');

    mockOllamaEmbed(
      undefined,
      () => new Response('Service Unavailable', { status: 503 }),
    );

    const result = await routeFromArtifact(db, artifact, {
      caller_session_id: 'caller-503',
    });

    expect(result.bi_encoder_only).toBe(true);
    const rows = readFallbackRows(db, 'caller-503');
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].detail).reason).toBe('non_2xx');
    db.close();
  });

  it('records timeout when reranker fetch raises TimeoutError', async () => {
    const db = freshV32Db();
    const artifact = setupCePrimary(db, 'sess-fb-to');

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes('7439/rerank')) {
          const err = new Error('aborted');
          (err as { name: string }).name = 'TimeoutError';
          throw err;
        }
        if (url.includes('11434/api/embed')) {
          // Successful embed for the bi-encoder fallback
          return new Response(
            JSON.stringify({ embeddings: [Array(1024).fill(0.001), Array(1024).fill(0.002), Array(1024).fill(0.003), Array(1024).fill(0.004)] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as typeof fetch,
    );

    const result = await routeFromArtifact(db, artifact, {
      caller_session_id: 'caller-to',
    });
    expect(result.bi_encoder_only).toBe(true);
    const rows = readFallbackRows(db, 'caller-to');
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].detail).reason).toBe('timeout');
    db.close();
  });

  it('records unreachable when reranker fetch raises TypeError', async () => {
    const db = freshV32Db();
    const artifact = setupCePrimary(db, 'sess-fb-net');

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes('7439/rerank')) {
          throw new TypeError('fetch failed');
        }
        if (url.includes('11434/api/embed')) {
          return new Response(
            JSON.stringify({ embeddings: [Array(1024).fill(0.001), Array(1024).fill(0.002), Array(1024).fill(0.003), Array(1024).fill(0.004)] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as typeof fetch,
    );

    const result = await routeFromArtifact(db, artifact, {
      caller_session_id: 'caller-net',
    });
    expect(result.bi_encoder_only).toBe(true);
    const rows = readFallbackRows(db, 'caller-net');
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].detail).reason).toBe('unreachable');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 5. sqlite-vec absent / Ollama unreachable degrades non-throwing
// ---------------------------------------------------------------------------

describe('routeFromArtifact — degrades non-throwing when network seams fail', () => {
  it('returns spans with rank_score=0 when both reranker and Ollama throw', async () => {
    const db = freshV32Db();
    const sessionId = 'sess-degrade';
    seedChunks(db, sessionId, 3);

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    );

    const artifact: RoutingArtifact = {
      session_id: sessionId,
      created_at_epoch_ms: BASE_TIME + 60_000,
      query_text: 'degrade test',
    };

    let threw = false;
    let result: Awaited<ReturnType<typeof routeFromArtifact>> | null = null;
    try {
      result = await routeFromArtifact(db, artifact);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.spans.length).toBeGreaterThan(0);
    expect(result!.bi_encoder_only).toBe(true);
    for (const s of result!.spans) expect(s.rank_score).toBe(0);
    db.close();
  });

  it('returns empty result when transcript_chunk_v6 is absent (pre-V32 DB)', async () => {
    const db = new Database(':memory:'); // no schema init
    mockOllamaEmbed();
    const artifact: RoutingArtifact = {
      session_id: 'sess-prev32',
      created_at_epoch_ms: BASE_TIME,
      query_text: 'pre-V32',
    };
    const result = await routeFromArtifact(db, artifact);
    expect(result.spans.length).toBe(0);
    expect(result.candidate_count).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 6. POLISH-01 Routing Finding #1 — null-body candidate yields degraded result
// ---------------------------------------------------------------------------

describe('routeFromArtifact — null-body candidate yields degraded result, never throws', () => {
  it('coalesces NULL body + missing query_text to empty string and returns degraded ranking', async () => {
    // Build a DB where transcript_chunk_v6 allows NULL body — models
    // production drift (older schema variant or direct PRAGMA-bypass writes
    // that produced NULL body rows). The fix must defend against the shape,
    // regardless of which schema generation produced it.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE transcript_chunk_v6 (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT,
        turn_index INTEGER NOT NULL,
        sub_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        body TEXT,                                     -- NULLABLE (drift shape)
        created_at_epoch_ms INTEGER NOT NULL,
        provenance TEXT,
        wrapper_redacted INTEGER
      );
      CREATE TABLE telemetry (
        event_kind TEXT, ts_epoch_ms INTEGER, session_id TEXT, detail TEXT
      );
    `);
    db.prepare(
      `INSERT INTO transcript_chunk_v6 (id, session_id, project_id, turn_index, sub_index, role, body, created_at_epoch_ms, provenance, wrapper_redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1, 'sess-null-1', 'test-project', 0, 0, 'tool', null, BASE_TIME, 'organic', 0,
    );

    mockOllamaEmbed();

    let threw = false;
    let result: Awaited<ReturnType<typeof routeFromArtifact>> | null = null;
    try {
      result = await routeFromArtifact(db, {
        session_id: 'sess-null-1',
        created_at_epoch_ms: BASE_TIME,
        // query_text deliberately omitted — coalesce path engages
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.spans.length).toBe(1);
    expect(result!.bi_encoder_only).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 7. POLISH-01 Routing Finding #2 — telemetry-write throw isolated from fallback
// ---------------------------------------------------------------------------

describe('routeFromArtifact — telemetry exception during fallback is isolated', () => {
  it('runs bi-encoder fallback even when telemetry write throws', async () => {
    const db = freshV32Db();
    const sessionId = 'sess-telem-throw';
    seedChunks(db, sessionId, 3);

    // Flip mode to cross_encoder_primary.
    const cfgDir = path.join(tmpHome, '.claudex');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ v6: { routing: { reranker_mode: 'cross_encoder_primary' } } }),
    );

    // Mock cross-encoder to fail (so we enter the telemetry write site),
    // and embed to succeed (so the bi-encoder fallback can produce spans).
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes('7439/rerank')) return new Response('Service Unavailable', { status: 503 });
        if (url.includes('11434/api/embed')) {
          return new Response(
            JSON.stringify({ embeddings: [Array(1024).fill(0.001), Array(1024).fill(0.002), Array(1024).fill(0.003), Array(1024).fill(0.004)] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('', { status: 404 });
      }) as typeof fetch,
    );

    // Make telemetry table unavailable by dropping it AFTER schema init.
    // The next INSERT into telemetry will throw "no such table: telemetry"
    // which is exactly the production drift Gemini surfaced.
    db.prepare(`DROP TABLE telemetry`).run();

    let threw = false;
    let result: Awaited<ReturnType<typeof routeFromArtifact>> | null = null;
    try {
      result = await routeFromArtifact(db, {
        session_id: sessionId,
        created_at_epoch_ms: BASE_TIME + 60_000,
        query_text: 'telemetry-throw test',
      }, { caller_session_id: 'caller-throw' });
    } catch {
      threw = true;
    }

    // The fix: telemetry-write throw is isolated; bi-encoder fallback completes.
    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.spans.length).toBeGreaterThan(0);
    expect(result!.bi_encoder_only).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 8. POLISH-01 Routing Finding #3 — time-window absolute-distance ordering
// ---------------------------------------------------------------------------

describe('routeFromArtifact — candidate fetch orders by absolute time-distance from artifact', () => {
  it('returns the 20 chunks closest to artifact.created_at_epoch_ms when 30 chunks fall inside the window', async () => {
    const db = freshV32Db();
    const artifactTs = BASE_TIME;
    // Seed 30 chunks across a 4h window with the artifact at the midpoint.
    // Offsets in minutes: -75..-5 (i=0..14, 5min apart) then +5..+75 (i=15..29).
    // Closest 20 are at offsets in [-50min, +50min] inclusive — turn_index 5..24.
    for (let i = 0; i < 30; i++) {
      const offsetMin = i < 15 ? -(15 - i) * 5 : (i - 14) * 5;
      const ts = artifactTs + offsetMin * 60_000;
      upsertChunk(db, {
        session_id: 'sess-time',
        project_id: 'test-project',
        turn_index: i,
        sub_index: 0,
        role: 'assistant',
        provenance: 'organic',
        body: `body ${i}`,
        created_at_epoch_ms: ts,
        wrapper_redacted: false,
      });
    }
    mockOllamaEmbed();

    const result = await routeFromArtifact(
      db,
      { session_id: 'sess-time', created_at_epoch_ms: artifactTs, query_text: 'q' },
      { window_ms_before: 2 * 60 * 60_000, window_ms_after: 2 * 60 * 60_000 },
    );

    // 30 candidates inside window; SQL caps at 20 closest.
    expect(result.candidate_count).toBe(20);
    // Default top_k_per_artifact returns 3 spans — every returned span's
    // turn_index must be in the closest-20 range [5, 24] regardless of which
    // 3 the ranker picked.
    for (const s of result.spans) {
      expect(s.turn_index).toBeGreaterThanOrEqual(5);
      expect(s.turn_index).toBeLessThanOrEqual(24);
    }
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Purity guard — production module is never mocked
// ---------------------------------------------------------------------------

describe('purity guard — production routing module is never mocked', () => {
  it('this test file does not mock transcript-routing.ts', () => {
    const thisFile = fs.readFileSync(__filename, 'utf8');
    expect(thisFile).not.toMatch(/vi\.mock.*transcript-routing/);
  });
});
