/**
 * Phase 10 plan 10-04 WIR-01 — live-wiring ship gate for the v6 routing +
 * assembly surface.
 *
 * Calls the EXPORTED production functions (`routeFromArtifacts` from Plan
 * 10-01, `formatDeliberationSurfaceSection` from Plan 10-02) against
 * fixtures matching every DB shape currently in the wild: V17-collapsed
 * (the shape that burned v5.0.0) plus base-table fresh-DB. NEVER mocks the
 * routing or assembly modules — only the network seams (Ollama embed) are
 * mocked, mirroring the Phase 8 wire-test pattern.
 *
 * Failing this test BLOCKS SHIP at Vesna severity per WIR-02 phase coupling.
 *
 * Four CONTEXT-locked assertions (a-d):
 *   (a) transcript spans actually retrieved when artifact reference fires
 *   (b) spans actually appear in the assembly output
 *   (c) zero errors across V17-collapsed + base-table fresh-DB fixtures
 *   (d) advisory narration line emitted
 *
 * WIR-01 is wire correctness only — runs the exported routing+assembly
 * functions against production-shape fixtures. NOT engagement re-measurement
 * (that would re-litigate the P9 verdict using post-hoc data).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initializeSchema, runMigrations } from '../../core/migrations.js';
import { upsertChunk } from '../../ingestion/upsert-chunk.js';
import {
  routeFromArtifacts,
  type RoutingArtifact,
} from '../../retrieval/transcript-routing.js';
import { formatDeliberationSurfaceSection } from '../../assembly/sections.js';

// ---------------------------------------------------------------------------
// Fixture builders (mirror Phase 8 wire-test)
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-wir-'));
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

/**
 * V17-collapsed fixture extended with the minimum tables runMigrations
 * needs to advance from V31 to V32 cleanly. Mirrors what an existing
 * production install at V31 looks like before V32 lands.
 *
 * Identical to the buildV17V32Fixture helper from phase-8-wire-test —
 * copied here so the wire-test stands alone (per Phase 8 precedent).
 */
function buildV17V32Fixture(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE artifact (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT,
      scope TEXT,
      status TEXT,
      confidence REAL,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL,
      session_id TEXT,
      project_id TEXT,
      embedding_ref INTEGER,
      supersedes_id TEXT,
      data TEXT
    );
    CREATE TABLE legacy_id_map (
      legacy_table TEXT NOT NULL,
      legacy_id INTEGER NOT NULL,
      new_uuid TEXT NOT NULL,
      PRIMARY KEY (legacy_table, legacy_id)
    );
    CREATE VIEW learnings AS
    SELECT
      CAST((SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = 'learnings' AND m.new_uuid = artifact.id) AS INTEGER) AS id,
      CAST(artifact.project_id AS TEXT) AS project,
      artifact.body AS content,
      COALESCE(CAST(json_extract(artifact.data, '$.provenance') AS TEXT), 'organic') AS provenance
    FROM artifact
    WHERE kind = 'learning'
    ORDER BY created_at_epoch;
  `);
}

function freshBaseTableV32Db(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function freshV17CollapsedV32Db(): Database.Database {
  const db = new Database(':memory:');
  buildV17V32Fixture(db);
  db.pragma('user_version = 31');
  runMigrations(db);
  return db;
}

function seedDeliberation(db: Database.Database, sessionId: string): {
  artifact: RoutingArtifact;
  bodies: string[];
} {
  const t0 = BASE_TIME;
  const bodies = [
    'Why are we using the embedded vector tables instead of an external store?',
    'Single-store design — embed the vector tables in the primary DB; removes a deployment surface.',
  ];
  upsertChunk(db, {
    session_id: sessionId,
    project_id: 'test',
    turn_index: 0,
    sub_index: 0,
    role: 'user',
    provenance: 'organic',
    body: bodies[0],
    created_at_epoch_ms: t0,
    wrapper_redacted: false,
  });
  upsertChunk(db, {
    session_id: sessionId,
    project_id: 'test',
    turn_index: 1,
    sub_index: 0,
    role: 'assistant',
    provenance: 'organic',
    body: bodies[1],
    created_at_epoch_ms: t0 + 60_000,
    wrapper_redacted: false,
  });
  return {
    artifact: {
      session_id: sessionId,
      created_at_epoch_ms: t0,
      query_text: 'should we add another vector store?',
    },
    bodies,
  };
}

function mockBiEncoder(): void {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('11434/api/embed')) {
      const body = init?.body ? JSON.parse(String(init.body)) : { input: [] };
      const texts: string[] = body.input ?? [];
      // Deterministic non-zero embeddings — every text aligns with query.
      const embeddings = texts.map((_t, i) => {
        const v = Array(1024).fill(0);
        v[0] = 1 / (i + 1);
        return v;
      });
      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch);
}

// ---------------------------------------------------------------------------
// (a) transcript spans actually retrieved when artifact reference fires
// ---------------------------------------------------------------------------

describe('WIR-01 (a) — spans actually retrieved when artifact reference fires', () => {
  for (const fixture of ['base-table', 'v17-collapsed'] as const) {
    it(`routeFromArtifacts returns spans for a real artifact reference on ${fixture}`, async () => {
      const db = fixture === 'base-table' ? freshBaseTableV32Db() : freshV17CollapsedV32Db();
      expect(db.pragma('user_version', { simple: true })).toBe(32);

      const sessionId = `wir01-spans-${fixture}`;
      const { artifact } = seedDeliberation(db, sessionId);
      mockBiEncoder();

      const result = await routeFromArtifacts(db, [artifact]);

      expect(result.spans.length).toBeGreaterThan(0);
      expect(result.spans[0].session_id).toBe(sessionId);
      expect(result.bi_encoder_only).toBe(true);
      db.close();
    });
  }
});

// ---------------------------------------------------------------------------
// (b) spans actually appear in the assembly output
// ---------------------------------------------------------------------------

describe('WIR-01 (b) — spans actually appear in the assembly output', () => {
  for (const fixture of ['base-table', 'v17-collapsed'] as const) {
    it(`formatDeliberationSurfaceSection renders spans into the output on ${fixture}`, async () => {
      const db = fixture === 'base-table' ? freshBaseTableV32Db() : freshV17CollapsedV32Db();
      const sessionId = `wir01-output-${fixture}`;
      const { artifact, bodies } = seedDeliberation(db, sessionId);
      mockBiEncoder();

      const sectionText = await formatDeliberationSurfaceSection(
        db,
        [artifact],
        {
          enabled: true,
          totalAssemblyBudgetTokens: 10_000,
          caller_session_id: 'wir01-test',
        },
      );

      expect(sectionText).not.toBeNull();
      // POLISH-02 — bi-encoder-only path emits the locked low-confidence header
      // (Gemini Assembly Finding #3). These wire tests use the bi-encoder
      // fallback (Ollama mocked, no cross-encoder), so the suffix is expected.
      expect(sectionText).toMatch(
        /^## Deliberation Surfaced (?:\(low-confidence retrieval\)|— \d+ spans? from \d+ sessions?)/,
      );
      expect(sectionText).toContain(`From session ${sessionId}`);
      // At least one of the seeded bodies must appear in the output.
      const containsBody = bodies.some((b) => sectionText!.includes(b));
      expect(containsBody).toBe(true);
      db.close();
    });
  }
});

// ---------------------------------------------------------------------------
// (c) zero errors across V17-collapsed + base-table fresh-DB fixtures
// ---------------------------------------------------------------------------

describe('WIR-01 (c) — zero errors across V17-collapsed + base-table fresh-DB fixtures', () => {
  it('routing + assembly run without throwing on either fixture', async () => {
    for (const fixture of ['base-table', 'v17-collapsed'] as const) {
      const db = fixture === 'base-table' ? freshBaseTableV32Db() : freshV17CollapsedV32Db();
      const { artifact } = seedDeliberation(db, `wir01-zero-${fixture}`);
      mockBiEncoder();

      let threw = false;
      try {
        const routing = await routeFromArtifacts(db, [artifact]);
        const section = await formatDeliberationSurfaceSection(db, [artifact], {
          enabled: true,
          totalAssemblyBudgetTokens: 10_000,
        });
        expect(routing).toBeDefined();
        expect(section).not.toBeNull();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      db.close();
    }
  });

  it('routing + assembly STILL do not throw when network is unavailable', async () => {
    const db = freshBaseTableV32Db();
    const { artifact } = seedDeliberation(db, 'wir01-no-network');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);

    let threw = false;
    try {
      const routing = await routeFromArtifacts(db, [artifact]);
      const section = await formatDeliberationSurfaceSection(db, [artifact], {
        enabled: true,
        totalAssemblyBudgetTokens: 10_000,
      });
      expect(routing).toBeDefined();
      // section may be non-null with rank_score=0 spans — both are valid degraded outputs
      expect(section === null || typeof section === 'string').toBe(true);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (d) advisory narration line emitted
// ---------------------------------------------------------------------------

describe('WIR-01 (d) — advisory narration line emitted', () => {
  it('emits "## Deliberation Surfaced …" advisory header in the rendered section', async () => {
    const db = freshBaseTableV32Db();
    // Seed across two distinct sessions for M > 1
    const a = seedDeliberation(db, 'wir01-advisory-A');
    const b = seedDeliberation(db, 'wir01-advisory-B');
    mockBiEncoder();

    const section = await formatDeliberationSurfaceSection(
      db,
      [a.artifact, b.artifact],
      { enabled: true, totalAssemblyBudgetTokens: 10_000 },
    );

    expect(section).not.toBeNull();
    // POLISH-02 — header has two locked variants per Gemini Assembly Finding #3:
    //   bi_encoder_only=true → '## Deliberation Surfaced (low-confidence retrieval)'
    //   cross-encoder confirmed → '## Deliberation Surfaced — N spans from M sessions'
    // This wire test uses the bi-encoder fallback path; either variant satisfies
    // "advisory line was emitted."
    expect(section).toMatch(
      /^## Deliberation Surfaced (?:\(low-confidence retrieval\)|— \d+ spans? from \d+ sessions?)$/m,
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Purity guard — the production routing+assembly modules are never mocked
// ---------------------------------------------------------------------------

describe('WIR-01 purity guard — production routing+assembly modules are never mocked', () => {
  it('this test file does not mock the routing or assembly modules under test', () => {
    const thisFile = fs.readFileSync(__filename, 'utf8');
    expect(thisFile).not.toMatch(/vi\.mock.*transcript-routing/);
    expect(thisFile).not.toMatch(/vi\.mock.*deliberation-surface/);
    expect(thisFile).not.toMatch(/vi\.mock.*sections/);
  });
});
